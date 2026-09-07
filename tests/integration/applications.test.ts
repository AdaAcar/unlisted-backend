import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GET as listApplicationsRoute,
  POST as createApplicationRoute,
} from '@/app/api/plans/[id]/applications/route';
import {
  DELETE as withdrawRoute,
  GET as getApplicationRoute,
} from '@/app/api/applications/[id]/route';
import { POST as confirmRoute } from '@/app/api/applications/[id]/confirm/route';
import { POST as withdrawMemberRoute } from '@/app/api/applications/[id]/withdraw-member/route';
import {
  DELETE as unshortlistRoute,
  POST as shortlistRoute,
} from '@/app/api/applications/[id]/shortlist/route';
import { POST as rejectRoute } from '@/app/api/applications/[id]/reject/route';
import { POST as inviteRoute } from '@/app/api/applications/[id]/invite/route';
import { computeApplicationVersionHash } from '@/domain/application-version';

import {
  applicationRow,
  cookieFor,
  idCtx,
  memberRows,
  seedCircle,
  seedPublishedPlan,
  seedUser,
} from './support/applications';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t?.close();
});

function req(cookie: string | undefined, body?: unknown, method = 'POST'): NextRequest {
  return new NextRequest('http://localhost/x', {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createSolo(cookie: string, planId: string, note?: string) {
  return createApplicationRoute(req(cookie, note === undefined ? {} : { note }), idCtx(planId));
}

async function createCircleApplication(
  cookie: string,
  planId: string,
  applicantCircleId: string,
  memberUserIds: string[],
  note?: string,
) {
  return createApplicationRoute(
    req(cookie, { applicantCircleId, memberUserIds, ...(note === undefined ? {} : { note }) }),
    idCtx(planId),
  );
}

// ---------------------------------------------------------------------------
// C5 — deny paths first (agent-rules §8)
// ---------------------------------------------------------------------------

describe('POST /plans/:id/applications — authorization', () => {
  it('401 without a session', async () => {
    const plan = await seedPublishedPlan(t);
    expect((await createApplicationRoute(req(undefined, {}), idCtx(plan.planId))).status).toBe(401);
  });

  it('403 for an unverified user', async () => {
    const plan = await seedPublishedPlan(t);
    const u = await seedUser(t, { verified: false });
    const res = await createSolo(await cookieFor(t, u), plan.planId);
    expect(res.status).toBe(403);
  });

  it('403 for a non-lead applying as a circle', async () => {
    const plan = await seedPublishedPlan(t);
    const circle = await seedCircle(t, 1);
    const nonLead = circle.memberIds[1]!;
    const res = await createCircleApplication(
      await cookieFor(t, nonLead),
      plan.planId,
      circle.circleId,
      [nonLead],
    );
    expect(res.status).toBe(403);
  });

  it('404 on the application for a stranger (existence not disclosed)', async () => {
    const plan = await seedPublishedPlan(t);
    const applicant = await seedUser(t);
    const created = await createSolo(await cookieFor(t, applicant), plan.planId);
    const id = ((await created.json()) as { id: string }).id;
    const stranger = await seedUser(t);
    const res = await getApplicationRoute(
      req(await cookieFor(t, stranger), undefined, 'GET'),
      idCtx(id),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// C5 — planned mode
// ---------------------------------------------------------------------------

describe('C5 planned applications', () => {
  it('a solo application goes straight to submitted', async () => {
    const plan = await seedPublishedPlan(t);
    const u = await seedUser(t);
    const res = await createSolo(await cookieFor(t, u), plan.planId, 'hi');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; state: string; applicantKind: string };
    expect(body.state).toBe('submitted');
    expect(body.applicantKind).toBe('solo');
  });

  it('a circle application starts awaiting_confirmation with an unconfirmed row per member', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 2 });
    const circle = await seedCircle(t, 2);
    const res = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect((await applicationRow(t, id)).state).toBe('awaiting_confirmation');
    const members = await memberRows(t, id);
    expect(members).toHaveLength(3);
    expect(members.every((m) => m.confirmation_state === 'unconfirmed')).toBe(true);
  });

  it('rejects a circle application below min_group_size (422)', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 3 });
    const circle = await seedCircle(t, 1);
    const res = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('too_small');
  });

  it('a second live application by the same applicant is rejected (409)', async () => {
    const plan = await seedPublishedPlan(t);
    const cookie = await cookieFor(t, await seedUser(t));
    expect((await createSolo(cookie, plan.planId)).status).toBe(201);
    const dup = await createSolo(cookie, plan.planId);
    expect(dup.status).toBe(409);
  });

  it('submission is blocked until every member confirms; the last confirm auto-submits', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 2 });
    const circle = await seedCircle(t, 2);
    const [m0, m1, m2] = circle.memberIds;
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'note',
    );
    const id = ((await created.json()) as { id: string }).id;
    const hash = computeApplicationVersionHash({ note: 'note', memberIds: circle.memberIds });

    for (const [i, uid] of [m0, m1].entries()) {
      const res = await confirmRoute(
        req(await cookieFor(t, uid!), { versionHash: hash }),
        idCtx(id),
      );
      expect(res.status).toBe(200);
      expect((await applicationRow(t, id)).state).toBe('awaiting_confirmation');
      expect(i).toBeLessThan(2);
    }
    const last = await confirmRoute(req(await cookieFor(t, m2!), { versionHash: hash }), idCtx(id));
    expect(last.status).toBe(200);
    expect((await applicationRow(t, id)).state).toBe('submitted');
  });

  it('confirm with a stale version hash is rejected (409)', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 1 });
    const circle = await seedCircle(t, 1);
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'v1',
    );
    const id = ((await created.json()) as { id: string }).id;
    const wrong = computeApplicationVersionHash({ note: 'DIFFERENT', memberIds: circle.memberIds });
    const res = await confirmRoute(
      req(await cookieFor(t, circle.leadId), { versionHash: wrong }),
      idCtx(id),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('stale');
  });

  it('a stranger cannot confirm — the application is not even visible (404, §3)', async () => {
    const plan = await seedPublishedPlan(t);
    const circle = await seedCircle(t, 1);
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'x',
    );
    const id = ((await created.json()) as { id: string }).id;
    const outsider = await seedUser(t);
    const hash = computeApplicationVersionHash({ note: 'x', memberIds: circle.memberIds });
    const res = await confirmRoute(
      req(await cookieFor(t, outsider), { versionHash: hash }),
      idCtx(id),
    );
    expect(res.status).toBe(404);
  });

  it('a host-circle lead who is not a member of the application cannot confirm (403)', async () => {
    // The host lead CAN see the application (host-member branch of
    // app_application_visible), so this is 403 not 404.
    const plan = await seedPublishedPlan(t);
    const circle = await seedCircle(t, 1);
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'x',
    );
    const id = ((await created.json()) as { id: string }).id;
    const hash = computeApplicationVersionHash({ note: 'x', memberIds: circle.memberIds });
    const res = await confirmRoute(
      req(await cookieFor(t, plan.hostLeadId), { versionHash: hash }),
      idCtx(id),
    );
    expect(res.status).toBe(403);
  });

  it('editing after partial confirmation voids prior confirmations (withdraw-member)', async () => {
    // C5 done-when.
    const plan = await seedPublishedPlan(t, { minGroupSize: 2 });
    const circle = await seedCircle(t, 3); // lead + 3 = 4 members
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'note',
    );
    const id = ((await created.json()) as { id: string }).id;
    const hash = computeApplicationVersionHash({ note: 'note', memberIds: circle.memberIds });

    // Two of the four confirm.
    for (const uid of [circle.memberIds[0]!, circle.memberIds[1]!]) {
      await confirmRoute(req(await cookieFor(t, uid), { versionHash: hash }), idCtx(id));
    }
    expect(
      (await memberRows(t, id)).filter((m) => m.confirmation_state === 'confirmed'),
    ).toHaveLength(2);

    // A third member withdraws → member set changes → every confirmation voided,
    // application back to awaiting_confirmation.
    const wm = await withdrawMemberRoute(
      req(await cookieFor(t, circle.memberIds[2]!), {}),
      idCtx(id),
    );
    expect(wm.status).toBe(200);
    const after = await memberRows(t, id);
    expect(after).toHaveLength(3);
    expect(after.every((m) => m.confirmation_state === 'unconfirmed')).toBe(true);
    expect(after.every((m) => m.confirmed_version_hash === null)).toBe(true);
    expect((await applicationRow(t, id)).state).toBe('awaiting_confirmation');
  });

  it('withdraw-member below min_group_size invalidates the whole application', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 2 });
    const circle = await seedCircle(t, 1); // 2 members
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
    );
    const id = ((await created.json()) as { id: string }).id;
    const res = await withdrawMemberRoute(
      req(await cookieFor(t, circle.memberIds[1]!), {}),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    expect((await applicationRow(t, id)).state).toBe('withdrawn');
  });

  it('DELETE /applications/:id withdraws a pre-invitation application', async () => {
    const plan = await seedPublishedPlan(t);
    const u = await seedUser(t);
    const cookie = await cookieFor(t, u);
    const id = ((await (await createSolo(cookie, plan.planId)).json()) as { id: string }).id;
    const res = await withdrawRoute(req(cookie, undefined, 'DELETE'), idCtx(id));
    expect(res.status).toBe(200);
    expect((await applicationRow(t, id)).state).toBe('withdrawn');
  });
});

// ---------------------------------------------------------------------------
// C5 — tonight mode
// ---------------------------------------------------------------------------

describe('C5 tonight applications', () => {
  it('a group request binds only the caller (always solo in effect)', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'tonight' });
    const circle = await seedCircle(t, 2);
    const res = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; applicantKind: string; state: string };
    expect(body.applicantKind).toBe('solo');
    expect(body.state).toBe('submitted');
    expect(await memberRows(t, body.id)).toHaveLength(0);
  });

  it('POST /applications/:id/confirm 404s in tonight mode', async () => {
    // C5 done-when.
    const plan = await seedPublishedPlan(t, { mode: 'tonight' });
    const u = await seedUser(t);
    const cookie = await cookieFor(t, u);
    const id = ((await (await createSolo(cookie, plan.planId)).json()) as { id: string }).id;
    const res = await confirmRoute(req(cookie, { versionHash: 'a'.repeat(64) }), idCtx(id));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// C6 — review
// ---------------------------------------------------------------------------

describe('C6 review', () => {
  async function submittedSolo(planId: string): Promise<string> {
    const u = await seedUser(t);
    const created = await createSolo(await cookieFor(t, u), planId);
    return ((await created.json()) as { id: string }).id;
  }

  it('GET /plans/:id/applications is host circle lead only', async () => {
    const plan = await seedPublishedPlan(t);
    await submittedSolo(plan.planId);
    const outsider = await seedUser(t);
    // The plan is published (visible via discovery), so a non-lead sees 403 on
    // this lead-only sub-resource, not 404 — same split as C1/C3.
    expect(
      (
        await listApplicationsRoute(
          req(await cookieFor(t, outsider), undefined, 'GET'),
          idCtx(plan.planId),
        )
      ).status,
    ).toBe(403);
    const res = await listApplicationsRoute(
      req(await cookieFor(t, plan.hostLeadId), undefined, 'GET'),
      idCtx(plan.planId),
    );
    expect(res.status).toBe(200);
  });

  it('preserves group context — a circle applicant is one row with a members array', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 2 });
    const circle = await seedCircle(t, 2);
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'n',
    );
    const id = ((await created.json()) as { id: string }).id;
    const hash = computeApplicationVersionHash({ note: 'n', memberIds: circle.memberIds });
    for (const uid of circle.memberIds) {
      await confirmRoute(req(await cookieFor(t, uid), { versionHash: hash }), idCtx(id));
    }
    const res = await listApplicationsRoute(
      req(await cookieFor(t, plan.hostLeadId), undefined, 'GET'),
      idCtx(plan.planId),
    );
    const body = (await res.json()) as {
      applications: { id: string; applicantKind: string; members: unknown[] }[];
    };
    const row = body.applications.find((a) => a.id === id)!;
    expect(row.applicantKind).toBe('circle');
    expect(row.members).toHaveLength(3);
  });

  it('does not list draft / awaiting_confirmation applications', async () => {
    const plan = await seedPublishedPlan(t, { minGroupSize: 1 });
    const circle = await seedCircle(t, 0);
    await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
    ); // stays awaiting_confirmation
    const res = await listApplicationsRoute(
      req(await cookieFor(t, plan.hostLeadId), undefined, 'GET'),
      idCtx(plan.planId),
    );
    expect(((await res.json()) as { applications: unknown[] }).applications).toHaveLength(0);
  });

  it('shortlist is reversible, and a rejected applicant learns only "rejected"', async () => {
    const plan = await seedPublishedPlan(t);
    const id = await submittedSolo(plan.planId);
    const hostCookie = await cookieFor(t, plan.hostLeadId);

    expect((await shortlistRoute(req(hostCookie, {}), idCtx(id))).status).toBe(200);
    expect((await applicationRow(t, id)).state).toBe('shortlisted');
    expect((await unshortlistRoute(req(hostCookie, undefined, 'DELETE'), idCtx(id))).status).toBe(
      200,
    );
    expect((await applicationRow(t, id)).state).toBe('submitted');

    const rej = await rejectRoute(req(hostCookie, {}), idCtx(id));
    expect(rej.status).toBe(200);
    const body = (await rej.json()) as Record<string, unknown>;
    expect(body.state).toBe('rejected');
    expect(JSON.stringify(body)).not.toMatch(/reason/i);
  });

  it('a non-lead host member cannot shortlist / reject / invite (403)', async () => {
    const plan = await seedPublishedPlan(t, { hostExtraMembers: 1 });
    const id = await submittedSolo(plan.planId);
    // second active host member, not the lead
    const { rows } = await t.pool.query<{ user_id: string }>(
      `SELECT user_id FROM circle_member WHERE circle_id = $1 AND role = 'member'`,
      [plan.hostCircleId],
    );
    const nonLead = rows[0]!.user_id;
    const cookie = await cookieFor(t, nonLead);
    expect((await shortlistRoute(req(cookie, {}), idCtx(id))).status).toBe(403);
    expect((await rejectRoute(req(cookie, {}), idCtx(id))).status).toBe(403);
    expect((await inviteRoute(req(cookie, {}), idCtx(id))).status).toBe(403);
  });

  it('a partial invitation returns the circle to awaiting_confirmation with confirmations voided', async () => {
    // C6 done-when: cannot complete without re-confirmation from every affected member.
    const plan = await seedPublishedPlan(t, { openSpots: 3, minGroupSize: 2 });
    const circle = await seedCircle(t, 2); // 3 members
    const created = await createCircleApplication(
      await cookieFor(t, circle.leadId),
      plan.planId,
      circle.circleId,
      circle.memberIds,
      'g',
    );
    const id = ((await created.json()) as { id: string }).id;
    const hash = computeApplicationVersionHash({ note: 'g', memberIds: circle.memberIds });
    for (const uid of circle.memberIds) {
      await confirmRoute(req(await cookieFor(t, uid), { versionHash: hash }), idCtx(id));
    }
    const hostCookie = await cookieFor(t, plan.hostLeadId);
    await shortlistRoute(req(hostCookie, {}), idCtx(id));

    // Invite only 2 of the 3.
    const res = await inviteRoute(
      req(hostCookie, { memberUserIds: [circle.memberIds[0], circle.memberIds[1]] }),
      idCtx(id),
    );
    expect(res.status).toBe(200);
    expect((await applicationRow(t, id)).state).toBe('awaiting_confirmation');
    const members = await memberRows(t, id);
    expect(members.every((m) => m.confirmation_state === 'unconfirmed')).toBe(true);
    expect(members.every((m) => m.invitation_state === 'not_invited')).toBe(true);
    // No holds were placed.
    expect(
      Number(
        (await t.pool.query(`SELECT held_count FROM plan WHERE id = $1`, [plan.planId])).rows[0]
          .held_count,
      ),
    ).toBe(0);
  });
});
