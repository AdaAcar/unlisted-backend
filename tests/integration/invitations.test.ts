import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as createApplicationRoute } from '@/app/api/plans/[id]/applications/route';
import { POST as shortlistRoute } from '@/app/api/applications/[id]/shortlist/route';
import { POST as inviteRoute } from '@/app/api/applications/[id]/invite/route';
import { POST as acceptRoute } from '@/app/api/invitations/[id]/accept/route';
import { POST as declineRoute } from '@/app/api/invitations/[id]/decline/route';
import { expireInvitation, lockApplication, lockPlan } from '@/db';
import { withActor } from '@/db/scope/scoped';

import { userActor } from './support/a3';
import {
  applicationRow,
  cookieFor,
  idCtx,
  introducedUserIds,
  planRow,
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

/** Create a solo application, shortlist it, and invite it — leaving it `invited`. */
async function invitedSolo(
  plan: { planId: string; hostLeadId: string },
  applicantId: string,
): Promise<{ applicationId: string; cookie: string }> {
  const cookie = await cookieFor(t, applicantId);
  const created = await createApplicationRoute(req(cookie, {}), idCtx(plan.planId));
  const applicationId = ((await created.json()) as { id: string }).id;
  const host = await cookieFor(t, plan.hostLeadId);
  await shortlistRoute(req(host, {}), idCtx(applicationId));
  const inv = await inviteRoute(req(host, {}), idCtx(applicationId));
  if (inv.status !== 200) throw new Error(`invite failed: ${inv.status} ${await inv.text()}`);
  return { applicationId, cookie };
}

// ---------------------------------------------------------------------------
// C7a — deny paths first
// ---------------------------------------------------------------------------

describe('C7a authorization / mode', () => {
  it('accept and decline 404 in tonight mode', async () => {
    const plan = await seedPublishedPlan(t, { mode: 'tonight' });
    const u = await seedUser(t);
    const cookie = await cookieFor(t, u);
    const created = await createApplicationRoute(req(cookie, {}), idCtx(plan.planId));
    const id = ((await created.json()) as { id: string }).id;
    expect((await acceptRoute(req(cookie, {}), idCtx(id))).status).toBe(404);
    expect((await declineRoute(req(cookie, {}), idCtx(id))).status).toBe(404);
    expect(
      (await inviteRoute(req(await cookieFor(t, plan.hostLeadId), {}), idCtx(id))).status,
    ).toBe(404);
  });

  it('a non-invitee cannot accept (403)', async () => {
    const plan = await seedPublishedPlan(t, { hostExtraMembers: 1 });
    const { applicationId } = await invitedSolo(plan, await seedUser(t));
    const other = await seedUser(t);
    const res = await acceptRoute(req(await cookieFor(t, other), {}), idCtx(applicationId));
    // The invited application is visible to the host circle members but `other`
    // is a total stranger → 404.
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// C7a — accept / decline
// ---------------------------------------------------------------------------

describe('C7a accept / decline', () => {
  it('invite places a hold; accept converts it and latches viability on the third attendee', async () => {
    const plan = await seedPublishedPlan(t, { openSpots: 3, hostExtraMembers: 1 });
    const applicant = await seedUser(t);
    const { applicationId, cookie } = await invitedSolo(plan, applicant);

    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(1);

    const res = await acceptRoute(req(cookie, {}), idCtx(applicationId));
    expect(res.status).toBe(200);
    const row = await planRow(t, plan.planId);
    expect(Number(row.held_count)).toBe(0);
    expect(Number(row.accepted_guest_count)).toBe(1);
    expect(row.viable_at).not.toBeNull(); // host 2 + guest 1 = 3
    // C7c: the viability crossing opens the thread inside the same locked
    // transaction that stamped viable_at.
    expect(
      (await t.pool.query(`SELECT 1 FROM message_thread WHERE plan_id = $1`, [plan.planId]))
        .rowCount,
    ).toBe(1);
    // The viability latch populated the introduction ledger off the crossing.
    expect(await introducedUserIds(t, plan.planId)).toContain(applicant);
    expect((await introducedUserIds(t, plan.planId)).length).toBe(3);
  });

  it('accept is idempotent — a repeat produces no second effect', async () => {
    const plan = await seedPublishedPlan(t, { openSpots: 3, hostExtraMembers: 1 });
    const { applicationId, cookie } = await invitedSolo(plan, await seedUser(t));

    expect((await acceptRoute(req(cookie, {}), idCtx(applicationId))).status).toBe(200);
    const first = await planRow(t, plan.planId);
    expect((await acceptRoute(req(cookie, {}), idCtx(applicationId))).status).toBe(200);
    const second = await planRow(t, plan.planId);
    expect(Number(second.accepted_guest_count)).toBe(Number(first.accepted_guest_count));
    expect(Number(second.accepted_guest_count)).toBe(1);
  });

  it('decline is idempotent and returns the held spot to the pool', async () => {
    const plan = await seedPublishedPlan(t, { openSpots: 1, hostExtraMembers: 1 });
    const { applicationId, cookie } = await invitedSolo(plan, await seedUser(t));
    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(1);

    expect((await declineRoute(req(cookie, {}), idCtx(applicationId))).status).toBe(200);
    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(0);
    expect((await applicationRow(t, applicationId)).state).toBe('declined');

    // Repeat: still 200, still 0.
    expect((await declineRoute(req(cookie, {}), idCtx(applicationId))).status).toBe(200);
    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(0);

    // The freed spot is now invitable again.
    const fresh = await invitedSoloRaw(plan, await seedUser(t));
    const reinvite = await inviteRoute(
      req(await cookieFor(t, plan.hostLeadId), {}),
      idCtx(fresh.applicationId),
    );
    const body = await reinvite.text();
    expect(reinvite.status, `${reinvite.status}: ${body} (app ${fresh.applicationId})`).toBe(200);
  });

  /** Create + shortlist only (no invite) — returns the shortlisted application. */
  async function invitedSoloRaw(
    p: { planId: string; hostLeadId: string },
    applicantId: string,
  ): Promise<{ applicationId: string }> {
    const cookie = await cookieFor(t, applicantId);
    const created = await createApplicationRoute(req(cookie, {}), idCtx(p.planId));
    if (created.status !== 201) {
      throw new Error(`create failed: ${created.status} ${await created.text()}`);
    }
    const applicationId = ((await created.json()) as { id: string }).id;
    const sl = await shortlistRoute(
      req(await cookieFor(t, p.hostLeadId), {}),
      idCtx(applicationId),
    );
    if (sl.status !== 200) throw new Error(`shortlist failed: ${sl.status} ${await sl.text()}`);
    return { applicationId };
  }

  it('accept is rejected on overlap with another accepted plan', async () => {
    const applicant = await seedUser(t);

    // Plan 1: applicant accepts (starts in 5 days, no ends_at → instantaneous).
    const p1 = await seedPublishedPlan(t, { openSpots: 3, hostExtraMembers: 1, startsInDays: 5 });
    const first = await invitedSolo(p1, applicant);
    expect((await acceptRoute(req(first.cookie, {}), idCtx(first.applicationId))).status).toBe(200);

    // Give plan 1 a real 3h window so plan 2 (same start) overlaps it.
    await t.pool.query(`UPDATE plan SET ends_at = starts_at + interval '3 hours' WHERE id = $1`, [
      p1.planId,
    ]);

    // Plan 2: same start time → overlaps.
    const p2 = await seedPublishedPlan(t, { openSpots: 3, hostExtraMembers: 1, startsInDays: 5 });
    const second = await invitedSolo(p2, applicant);
    const res = await acceptRoute(req(second.cookie, {}), idCtx(second.applicationId));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('overlap');

    // Plan 3: far in the future → no overlap, accept succeeds.
    const p3 = await seedPublishedPlan(t, {
      openSpots: 3,
      hostExtraMembers: 1,
      startsInDays: 20,
    });
    const third = await invitedSolo(p3, applicant);
    expect((await acceptRoute(req(third.cookie, {}), idCtx(third.applicationId))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// C7a — capacity: the DB CHECK, hold expiry, and concurrency
// ---------------------------------------------------------------------------

describe('C7a capacity backstop', () => {
  it('plan_capacity_ceiling_chk rejects a direct overshoot (last line of defence)', async () => {
    // 0013 downgraded the privilege guarantee (both writers hold UPDATE on the
    // counters), so the CHECK — not the reducer — is now the final backstop.
    const plan = await seedPublishedPlan(t, { openSpots: 1 });
    await expect(
      t.pool.query(`UPDATE plan SET accepted_guest_count = 2 WHERE id = $1`, [plan.planId]),
    ).rejects.toThrow(/plan_capacity_ceiling_chk/);
    await expect(
      t.pool.query(`UPDATE plan SET held_count = 2 WHERE id = $1`, [plan.planId]),
    ).rejects.toThrow(/plan_capacity_ceiling_chk/);
  });

  it('an expired hold returns the spot to the pool (E1 release path, tested directly)', async () => {
    const plan = await seedPublishedPlan(t, { openSpots: 1, hostExtraMembers: 1 });
    const { applicationId } = await invitedSolo(plan, await seedUser(t));
    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(1);

    await withActor(userActor(plan.hostLeadId), async (executor) => {
      const lp = await lockPlan(executor, plan.planId);
      const la = await lockApplication(executor, applicationId);
      const out = await expireInvitation(executor, lp!, la!, new Date());
      expect(out.outcome).toBe('declined'); // shared release outcome type
    });

    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(0);
    expect((await applicationRow(t, applicationId)).state).toBe('expired');
  });

  it('concurrent invites for the last spot place exactly one hold', async () => {
    // The real capacity race in planned mode is at invite: the ceiling
    // (accepted + held <= open_spots) means only one hold fits.
    const plan = await seedPublishedPlan(t, { openSpots: 1, hostExtraMembers: 1 });
    const host = await cookieFor(t, plan.hostLeadId);

    const mk = async (): Promise<string> => {
      const cookie = await cookieFor(t, await seedUser(t));
      const created = await createApplicationRoute(req(cookie, {}), idCtx(plan.planId));
      const id = ((await created.json()) as { id: string }).id;
      await shortlistRoute(req(host, {}), idCtx(id));
      return id;
    };
    const [a, b] = [await mk(), await mk()];

    const [ra, rb] = await Promise.all([
      inviteRoute(req(host, {}), idCtx(a)),
      inviteRoute(req(host, {}), idCtx(b)),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(1);
  });

  it('concurrent accepts for one available spot leave exactly one winner', async () => {
    // C7a done-when. Seed: open_spots = 1, host = 2. Solo A is invited normally
    // (held_count -> 1). Solo B is forced into `invited` WITHOUT a second hold —
    // modelling B's hold having been released (expiry) between invite and accept
    // while B's application state lagged. Both accept concurrently: the plan row
    // lock serialises them, the first converts the single hold, and the second
    // hits held_count going negative in the reducer -> 409.
    const plan = await seedPublishedPlan(t, { openSpots: 1, hostExtraMembers: 1 });
    const a = await invitedSolo(plan, await seedUser(t)); // held_count = 1

    const bUser = await seedUser(t);
    const bCookie = await cookieFor(t, bUser);
    const bCreated = await createApplicationRoute(req(bCookie, {}), idCtx(plan.planId));
    const bId = ((await bCreated.json()) as { id: string }).id;
    await t.pool.query(
      `UPDATE application SET state = 'invited', response_deadline = now() + interval '1 hour' WHERE id = $1`,
      [bId],
    );

    const [ra, rb] = await Promise.all([
      acceptRoute(req(a.cookie, {}), idCtx(a.applicationId)),
      acceptRoute(req(bCookie, {}), idCtx(bId)),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await planRow(t, plan.planId);
    expect(Number(row.accepted_guest_count)).toBe(1);
    expect(Number(row.held_count)).toBe(0);
    // Exactly one application is accepted.
    const accepted = await t.pool.query(
      `SELECT count(*)::int AS n FROM application WHERE plan_id = $1 AND state = 'accepted'`,
      [plan.planId],
    );
    expect(accepted.rows[0].n).toBe(1);
  });

  it('held_count is an ownership-less aggregate — an accept converts any hold', async () => {
    // Two invitees, two holds, two spots. B accepts before A; B consumes "a"
    // hold, not B's own. Capacity stays exact regardless of order.
    const plan = await seedPublishedPlan(t, { openSpots: 2 }); // host = lead only (1)
    const a = await invitedSolo(plan, await seedUser(t));
    const b = await invitedSolo(plan, await seedUser(t));
    expect(Number((await planRow(t, plan.planId)).held_count)).toBe(2);

    expect((await acceptRoute(req(b.cookie, {}), idCtx(b.applicationId))).status).toBe(200);
    expect((await acceptRoute(req(a.cookie, {}), idCtx(a.applicationId))).status).toBe(200);

    const row = await planRow(t, plan.planId);
    expect(Number(row.held_count)).toBe(0);
    expect(Number(row.accepted_guest_count)).toBe(2);
    expect(row.viable_at).not.toBeNull(); // 1 + 2 = 3
  });
});
