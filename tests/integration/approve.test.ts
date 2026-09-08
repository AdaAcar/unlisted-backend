import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as approveRoute } from '@/app/api/applications/[id]/approve/route';
import { POST as createApplicationRoute } from '@/app/api/plans/[id]/applications/route';
import { POST as confirmRoute } from '@/app/api/applications/[id]/confirm/route';
import {
  DELETE as unshortlistRoute,
  POST as shortlistRoute,
} from '@/app/api/applications/[id]/shortlist/route';
import { POST as withdrawMemberRoute } from '@/app/api/applications/[id]/withdraw-member/route';
import { POST as inviteRoute } from '@/app/api/applications/[id]/invite/route';
import { POST as acceptInvitationRoute } from '@/app/api/invitations/[id]/accept/route';
import { POST as declineInvitationRoute } from '@/app/api/invitations/[id]/decline/route';
import { GET as threadRoute } from '@/app/api/plans/[id]/thread/route';

import {
  cookieFor,
  idCtx,
  introducedUserIds,
  planRow,
  seedPublishedPlan,
  seedUser,
  type PlanSeed,
} from './support/applications';
import { freshDb, type TestDb } from './support/db';

/**
 * C7b — `POST /applications/:id/approve` (tonight mode). Host taps once, the
 * applicant is in; a spot is hard-consumed under the plan row lock. Idempotent.
 * 404 in planned mode, and every planned-mode endpoint 404s on a tonight plan.
 * The tonight hosting gate (Decision A): cleared once the host circle's record
 * shows `plans_hosted > 0 OR plans_attended > 0`.
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t?.close();
});

const req = (cookie: string | undefined, body: unknown = {}, method = 'POST') =>
  new NextRequest('http://localhost/x', {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

/** Clear the tonight hosting gate for a plan's host circle (Decision A). */
async function clearGate(plan: PlanSeed): Promise<void> {
  await t.pool.query(`UPDATE circle SET plans_hosted = 1 WHERE id = $1`, [plan.hostCircleId]);
}

/** Seed a tonight plan whose gate is cleared, and one submitted solo application. */
async function seedTonightWithApplication(
  opts: { openSpots?: number } = {},
): Promise<{ plan: PlanSeed; applicantId: string; applicationId: string }> {
  const plan = await seedPublishedPlan(t, {
    mode: 'tonight',
    openSpots: opts.openSpots ?? 2,
    startsInDays: 1,
  });
  await clearGate(plan);
  const applicantId = await seedUser(t);
  const created = await createApplicationRoute(
    req(await cookieFor(t, applicantId), {}),
    idCtx(plan.planId),
  );
  expect(created.status).toBe(201);
  const applicationId = ((await created.json()) as { id: string }).id;
  return { plan, applicantId, applicationId };
}

describe('POST /applications/:id/approve — allow path', () => {
  it('the host lead approves a submitted tonight application; the spot is consumed and the event is audited', async () => {
    const { plan, applicationId } = await seedTonightWithApplication();
    const hostCookie = await cookieFor(t, plan.hostLeadId);

    const res = await approveRoute(req(hostCookie, {}), idCtx(applicationId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; mode: string };
    expect(body.state).toBe('approved');
    expect(body.mode).toBe('tonight');

    const row = await planRow(t, plan.planId);
    expect(Number(row.accepted_guest_count)).toBe(1);
    // Two attendees (1 host + 1 guest) — not viable, no thread.
    expect(row.viable_at).toBeNull();

    const audit = await t.pool.query<{ action: string; actor_role: string }>(
      `SELECT action, actor_role FROM audit_log WHERE resource_id = $1 AND action = 'application_approve'`,
      [applicationId],
    );
    expect(audit.rows).toEqual([{ action: 'application_approve', actor_role: 'circle_lead' }]);
  });

  it('is idempotent: a second approve returns 200 and does not consume a second spot', async () => {
    const { plan, applicationId } = await seedTonightWithApplication();
    const hostCookie = await cookieFor(t, plan.hostLeadId);

    expect((await approveRoute(req(hostCookie, {}), idCtx(applicationId))).status).toBe(200);
    expect((await approveRoute(req(hostCookie, {}), idCtx(applicationId))).status).toBe(200);

    expect(Number((await planRow(t, plan.planId)).accepted_guest_count)).toBe(1);
    const audit = await t.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1 AND action = 'application_approve'`,
      [applicationId],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });
});

describe('POST /applications/:id/approve — deny paths', () => {
  it('401 when unauthenticated', async () => {
    const { applicationId } = await seedTonightWithApplication();
    expect((await approveRoute(req(undefined, {}), idCtx(applicationId))).status).toBe(401);
  });

  it('404 for a stranger who cannot see the application (existence not disclosed)', async () => {
    const { applicationId } = await seedTonightWithApplication();
    const stranger = await cookieFor(t, await seedUser(t));
    expect((await approveRoute(req(stranger, {}), idCtx(applicationId))).status).toBe(404);
  });

  it('403 for the applicant trying to approve their own application (not the host lead)', async () => {
    const { applicantId, applicationId } = await seedTonightWithApplication();
    // The applicant can see their own application but does not lead the host
    // circle — denied. (The gate check runs first and also fails for a
    // non-member, so the body is `tonight_locked`; either way it is a 403.)
    const res = await approveRoute(req(await cookieFor(t, applicantId), {}), idCtx(applicationId));
    expect(res.status).toBe(403);
  });

  it('403 tonight_locked when the host circle has no completed plan on record', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'tonight', openSpots: 2, startsInDays: 1 });
    // Gate NOT cleared: plans_hosted = plans_attended = 0.
    const applicantId = await seedUser(t);
    const created = await createApplicationRoute(
      req(await cookieFor(t, applicantId), {}),
      idCtx(plan.planId),
    );
    const applicationId = ((await created.json()) as { id: string }).id;

    const res = await approveRoute(
      req(await cookieFor(t, plan.hostLeadId), {}),
      idCtx(applicationId),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('tonight_locked');
    expect(Number((await planRow(t, plan.planId)).accepted_guest_count)).toBe(0);
  });

  it('the gate opens once plans_attended > 0 (guest history counts too)', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'tonight', openSpots: 2, startsInDays: 1 });
    await t.pool.query(`UPDATE circle SET plans_attended = 1 WHERE id = $1`, [plan.hostCircleId]);
    const applicantId = await seedUser(t);
    const created = await createApplicationRoute(
      req(await cookieFor(t, applicantId), {}),
      idCtx(plan.planId),
    );
    const applicationId = ((await created.json()) as { id: string }).id;
    expect(
      (await approveRoute(req(await cookieFor(t, plan.hostLeadId), {}), idCtx(applicationId)))
        .status,
    ).toBe(200);
  });

  it('409 not_approvable for an application that is not submitted', async () => {
    const { plan, applicantId, applicationId } = await seedTonightWithApplication();
    await t.pool.query(
      `UPDATE application SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`,
      [applicationId],
    );
    const res = await approveRoute(
      req(await cookieFor(t, plan.hostLeadId), {}),
      idCtx(applicationId),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('not_approvable');
    expect(applicantId).toBeTruthy();
  });

  it('404 in planned mode', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'planned', openSpots: 2 });
    await clearGate(plan);
    const applicantId = await seedUser(t);
    const created = await createApplicationRoute(
      req(await cookieFor(t, applicantId), {}),
      idCtx(plan.planId),
    );
    const applicationId = ((await created.json()) as { id: string }).id;
    expect(
      (await approveRoute(req(await cookieFor(t, plan.hostLeadId), {}), idCtx(applicationId)))
        .status,
    ).toBe(404);
  });
});

describe('POST /applications/:id/approve — concurrency at the last spot', () => {
  it('two concurrent approvals for the last spot leave exactly one winner', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'tonight', openSpots: 1, startsInDays: 1 });
    await clearGate(plan);
    const hostCookie = await cookieFor(t, plan.hostLeadId);

    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const created = await createApplicationRoute(
        req(await cookieFor(t, await seedUser(t)), {}),
        idCtx(plan.planId),
      );
      ids.push(((await created.json()) as { id: string }).id);
    }

    const [ra, rb] = await Promise.all([
      approveRoute(req(hostCookie, {}), idCtx(ids[0]!)),
      approveRoute(req(hostCookie, {}), idCtx(ids[1]!)),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);

    const row = await planRow(t, plan.planId);
    expect(Number(row.accepted_guest_count)).toBe(1);
    const approved = await t.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM application WHERE plan_id = $1 AND state = 'approved'`,
      [plan.planId],
    );
    expect(Number(approved.rows[0]?.n)).toBe(1);
  });
});

describe('POST /applications/:id/approve — viability crossing (C7c)', () => {
  it('the third attendee (1 host + 2 tonight approvals) latches viability, opens the thread, and introduces everyone', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'tonight', openSpots: 5, startsInDays: 1 });
    await clearGate(plan);
    const hostCookie = await cookieFor(t, plan.hostLeadId);

    const guests = [await seedUser(t), await seedUser(t)];
    for (const guest of guests) {
      const created = await createApplicationRoute(
        req(await cookieFor(t, guest), {}),
        idCtx(plan.planId),
      );
      const appId = ((await created.json()) as { id: string }).id;
      const res = await approveRoute(req(hostCookie, {}), idCtx(appId));
      expect(res.status).toBe(200);
    }

    const row = await planRow(t, plan.planId);
    expect(row.viable_at).not.toBeNull(); // 1 host + 2 guests = 3

    // The thread exists and introduces all three.
    expect(
      (await t.pool.query(`SELECT 1 FROM message_thread WHERE plan_id = $1`, [plan.planId]))
        .rowCount,
    ).toBe(1);
    expect((await introducedUserIds(t, plan.planId)).sort()).toEqual(
      [plan.hostLeadId, ...guests].sort(),
    );

    // Every participant can now GET the thread.
    for (const uid of [plan.hostLeadId, ...guests]) {
      const res = await threadRoute(req(await cookieFor(t, uid), {}, 'GET'), idCtx(plan.planId));
      expect(res.status).toBe(200);
    }
  });

  it('a stale confirmed_host_count that leaves the live ledger short of three leaves the latch with no thread (non-fatal drift)', async () => {
    // 3 host members at publish -> confirmed_host_count = 3. Two are then made
    // inactive. One tonight approval: the reducer sees 3 + 1 >= MIN_PLAN_TOTAL
    // and latches viable_at, but the live ledger is 1 host + 1 guest = 2, so
    // createThreadForViablePlan returns not_viable — non-fatal. The approval
    // still succeeds (a guest is not punished for someone else's exit).
    const plan = await seedPublishedPlan(t, {
      mode: 'tonight',
      openSpots: 5,
      startsInDays: 1,
      hostExtraMembers: 2,
    });
    await clearGate(plan);
    await t.pool.query(
      `UPDATE circle_member SET status = 'removed', removed_at = now()
        WHERE circle_id = $1 AND role = 'member'`,
      [plan.hostCircleId],
    );
    const guest = await seedUser(t);
    const created = await createApplicationRoute(
      req(await cookieFor(t, guest), {}),
      idCtx(plan.planId),
    );
    const appId = ((await created.json()) as { id: string }).id;
    const res = await approveRoute(req(await cookieFor(t, plan.hostLeadId), {}), idCtx(appId));
    expect(res.status).toBe(200);

    const row = await planRow(t, plan.planId);
    expect(row.viable_at).not.toBeNull(); // latch stays
    expect(
      (await t.pool.query(`SELECT 1 FROM message_thread WHERE plan_id = $1`, [plan.planId]))
        .rowCount,
    ).toBe(0); // but no thread — the live group is short of three
  });
});

describe('planned-mode endpoints 404 on a tonight plan (C7b done-when, second half)', () => {
  it('confirm / shortlist / withdraw-member / invite / invitations accept & decline all return 404', async () => {
    const { plan, applicationId } = await seedTonightWithApplication();
    const hostCookie = await cookieFor(t, plan.hostLeadId);

    const versionHash = 'a'.repeat(64);
    const checks: [string, Promise<Response>][] = [
      ['confirm', confirmRoute(req(hostCookie, { versionHash }), idCtx(applicationId))],
      ['shortlist POST', shortlistRoute(req(hostCookie, {}), idCtx(applicationId))],
      ['shortlist DELETE', unshortlistRoute(req(hostCookie, {}, 'DELETE'), idCtx(applicationId))],
      ['withdraw-member', withdrawMemberRoute(req(hostCookie, {}), idCtx(applicationId))],
      ['invite', inviteRoute(req(hostCookie, {}), idCtx(applicationId))],
      ['invitations/accept', acceptInvitationRoute(req(hostCookie, {}), idCtx(applicationId))],
      ['invitations/decline', declineInvitationRoute(req(hostCookie, {}), idCtx(applicationId))],
    ];
    for (const [label, pending] of checks) {
      expect((await pending).status, label).toBe(404);
    }
  });
});
