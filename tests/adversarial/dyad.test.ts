import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as createApplicationRoute } from '@/app/api/plans/[id]/applications/route';
import { POST as shortlistRoute } from '@/app/api/applications/[id]/shortlist/route';
import { POST as inviteRoute } from '@/app/api/applications/[id]/invite/route';
import { POST as acceptRoute } from '@/app/api/invitations/[id]/accept/route';
import { GET as threadRoute } from '@/app/api/plans/[id]/thread/route';

import {
  cookieFor,
  idCtx,
  introducedUserIds,
  planRow,
  seedPublishedPlan,
  seedUser,
} from '../integration/support/applications';
import { freshDb, type TestDb } from '../integration/support/db';

/**
 * The dyad attack (todo_agent.md C5+C6+C7a Tests): no sequence of applications,
 * invitations and accepts may produce a viable plan below MIN_PLAN_TOTAL (3),
 * and no path may produce a two-person meeting. Viability gates the
 * introduction, not the acceptance — a solo host plus one accepted guest is
 * never introduced, never gets a thread, and never confirms.
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

/** Drive a solo applicant all the way to `accepted` on the given plan. */
async function acceptSolo(
  plan: { planId: string; hostLeadId: string },
  applicantId: string,
): Promise<string> {
  const cookie = await cookieFor(t, applicantId);
  const host = await cookieFor(t, plan.hostLeadId);
  const id = (
    (await (await createApplicationRoute(req(cookie), idCtx(plan.planId))).json()) as {
      id: string;
    }
  ).id;
  const sl = await shortlistRoute(req(host), idCtx(id));
  expect(sl.status).toBe(200);
  const inv = await inviteRoute(req(host), idCtx(id));
  expect(inv.status).toBe(200);
  const acc = await acceptRoute(req(cookie), idCtx(id));
  expect(acc.status).toBe(200);
  return id;
}

describe('dyad attack', () => {
  it('a solo host plus one accepted guest never becomes viable, threaded, or introduced', async () => {
    // Host circle = the lead only (1 confirmed host). open_spots high enough
    // that capacity never blocks — the ONLY thing standing between here and a
    // dyad is the viability rule.
    const plan = await seedPublishedPlan(t, { openSpots: 5, minGroupSize: 1 });
    const guestA = await seedUser(t);

    await acceptSolo(plan, guestA);

    const row = await planRow(t, plan.planId);
    expect(Number(row.confirmed_host_count)).toBe(1);
    expect(Number(row.accepted_guest_count)).toBe(1); // confirmed_total = 2
    expect(row.viable_at).toBeNull(); // NOT viable at 2
    expect(row.state).toBe('published'); // not confirmed, not closed

    // No thread exists — not created-but-empty, not created.
    expect(
      (await t.pool.query(`SELECT 1 FROM message_thread WHERE plan_id = $1`, [plan.planId]))
        .rowCount,
    ).toBe(0);
    // GET /plans/:id/thread is 404 for the accepted guest.
    const threadRes = await threadRoute(
      req(await cookieFor(t, guestA), {}, 'GET'),
      idCtx(plan.planId),
    );
    expect(threadRes.status).toBe(404);

    // Nobody has been introduced to anybody.
    expect(await introducedUserIds(t, plan.planId)).toEqual([]);

    // The database itself refuses to latch viability below the floor.
    await expect(
      t.pool.query(`UPDATE plan SET viable_at = now() WHERE id = $1`, [plan.planId]),
    ).rejects.toThrow(/MIN_PLAN_TOTAL/);
  });

  it('the third acceptance — and only the third — latches viability and introduces everyone', async () => {
    const plan = await seedPublishedPlan(t, { openSpots: 5, minGroupSize: 1 });
    const [a, b] = [await seedUser(t), await seedUser(t)];

    await acceptSolo(plan, a);
    expect((await planRow(t, plan.planId)).viable_at).toBeNull(); // total 2
    expect(await introducedUserIds(t, plan.planId)).toEqual([]);

    await acceptSolo(plan, b);
    const row = await planRow(t, plan.planId);
    expect(row.viable_at).not.toBeNull(); // total 3 — viable now
    expect((await introducedUserIds(t, plan.planId)).sort()).toEqual(
      [plan.hostLeadId, a, b].sort(),
    );
  });

  it('withdrawing back to two confirmed does not un-cancel viability but also never met', async () => {
    // Reach viability (3), then a guest is effectively gone — the introduction
    // latch stays (permanent), but confirmed_total is back to 2 and the plan is
    // not "met": completion requires viability at starts_at, which E1 enforces.
    const plan = await seedPublishedPlan(t, { openSpots: 5, minGroupSize: 1 });
    const [a, b] = [await seedUser(t), await seedUser(t)];
    await acceptSolo(plan, a);
    await acceptSolo(plan, b);
    expect((await planRow(t, plan.planId)).viable_at).not.toBeNull();

    // Directly drop a guest (models a withdrawal path C7c/E1 will own).
    await t.pool.query(
      `UPDATE plan SET accepted_guest_count = accepted_guest_count - 1 WHERE id = $1`,
      [plan.planId],
    );
    const row = await planRow(t, plan.planId);
    expect(Number(row.confirmed_host_count) + Number(row.accepted_guest_count)).toBe(2);
    // viable_at stays latched (the introduction happened and is permanent) ...
    expect(row.viable_at).not.toBeNull();
    // ... but the DB will not let it be cleared, nor re-derive a dyad meeting.
    await expect(
      t.pool.query(`UPDATE plan SET viable_at = NULL WHERE id = $1`, [plan.planId]),
    ).rejects.toThrow(/cannot be cleared/);
  });
});
