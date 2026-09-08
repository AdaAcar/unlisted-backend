import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as getThreadRoute, POST as postThreadRoute } from '@/app/api/plans/[id]/thread/route';
import { createThreadForViablePlan } from '@/db';
import { withActor } from '@/db/scope/scoped';
import { generateSessionToken, hashSessionToken } from '@/lib/sessionToken';

import { userActor } from './support/a3';
import { freshDb, type TestDb } from './support/db';

let t: TestDb;

beforeAll(async () => {
  t = await freshDb();
});

afterAll(async () => {
  await t?.close();
});

async function seedUser(): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing) VALUES ($1,'U','verified','good')`,
    [id],
  );
  return id;
}

async function cookieFor(userId: string): Promise<string> {
  const token = generateSessionToken();
  await t.pool.query(
    `INSERT INTO session (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [ulid(), userId, hashSessionToken(token)],
  );
  return `session=${token}`;
}

/** A published plan hosted by a circle of `hostCount` active members, made
 *  viable so the reconcile trigger writes that many ledger rows. */
async function seedViablePlan(hostCount = 3): Promise<{ planId: string; members: string[] }> {
  const members: string[] = [];
  const circleId = ulid();
  for (let i = 0; i < hostCount; i += 1) members.push(await seedUser());
  await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1,'H',$2)`, [
    circleId,
    members[0],
  ]);
  for (let i = 0; i < hostCount; i += 1) {
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1,$2,$3,$4,'active',now())`,
      [ulid(), circleId, members[i], i === 0 ? 'lead' : 'member'],
    );
  }
  const venueId = ulid();
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type) VALUES ($1,'V','addr','c','bar')`,
    [venueId],
  );
  const planId = ulid();
  await t.pool.query(
    `INSERT INTO plan (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
                       district, venue_type, state, mode, published_at)
     VALUES ($1,$2,$3, now() + interval '10 days', 5, 1, 'c','bar','published','planned', now())`,
    [planId, circleId, venueId],
  );
  // accepted_guest_count = 1 so the Decision B set-time floor (C7c) is
  // satisfied; the ledger is still populated from the `hostCount` real host
  // members, no guest application needed for these thread-shape tests.
  await t.pool.query(
    `UPDATE plan SET confirmed_host_count = $2, accepted_guest_count = 1, viable_at = now() WHERE id = $1`,
    [planId, hostCount],
  );
  return { planId, members };
}

/** A published plan that never reached viability (no viable_at, empty ledger). */
async function seedNonViablePlan(): Promise<string> {
  const leadId = await seedUser();
  const circleId = ulid();
  await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1,'H',$2)`, [
    circleId,
    leadId,
  ]);
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1,$2,$3,'lead','active',now())`,
    [ulid(), circleId, leadId],
  );
  const venueId = ulid();
  await t.pool.query(
    `INSERT INTO venue (id, name, address, district, type) VALUES ($1,'V','addr','c','bar')`,
    [venueId],
  );
  const id = ulid();
  await t.pool.query(
    `INSERT INTO plan (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
                       district, venue_type, state, mode, published_at)
     VALUES ($1,$2,$3, now() + interval '10 days', 5, 1, 'c','bar','published','planned', now())`,
    [id, circleId, venueId],
  );
  return id;
}

async function makeThread(planId: string, asUserId: string): Promise<string> {
  const outcome = await withActor(userActor(asUserId), (e) => createThreadForViablePlan(e, planId));
  if (!outcome.ok) throw new Error(`makeThread failed: ${outcome.reason}`);
  return outcome.id;
}

function req(cookie: string | undefined, body?: unknown, method = 'GET'): NextRequest {
  return new NextRequest('http://localhost/plans/x/thread', {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function auditRows(
  threadId: string,
): Promise<Array<{ action: string; after_state: unknown }>> {
  const { rows } = await t.pool.query<{ action: string; after_state: unknown }>(
    `SELECT action, after_state FROM audit_log WHERE resource_id = $1 ORDER BY created_at`,
    [threadId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Done-when: no route, parameter, or direct repository call makes a thread on a
// non-viable plan.
// ---------------------------------------------------------------------------

describe('no thread on a non-viable plan', () => {
  it('has no thread-creation route at all; GET and POST 404 on a non-viable plan', async () => {
    const planId = await seedNonViablePlan();
    const cookie = await cookieFor(await seedUser());
    expect((await getThreadRoute(req(cookie), ctx(planId))).status).toBe(404);
    expect((await postThreadRoute(req(cookie, { body: 'hi' }, 'POST'), ctx(planId))).status).toBe(
      404,
    );
  });

  it('rejects a direct db/threads.ts create for a non-viable plan', async () => {
    const nonViable = await seedNonViablePlan();
    const someUser = await seedUser();
    const outcome = await withActor(userActor(someUser), (e) =>
      createThreadForViablePlan(e, nonViable),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(['not_viable', 'not_participant']).toContain(outcome.reason);
  });

  it('rejects a raw superuser INSERT for a non-viable plan (the FK to viable_plan_key)', async () => {
    const nonViable = await seedNonViablePlan();
    await expect(
      t.pool.query(
        `INSERT INTO message_thread (id, plan_id, participant_count) VALUES ($1, $2, 3)`,
        [ulid(), nonViable],
      ),
    ).rejects.toThrow(/message_thread_(plan_viable_fk|min_participants_chk)/);
  });

  it('rejects a participant of one viable plan creating a thread for a different non-viable one', async () => {
    const { members } = await seedViablePlan(3);
    const nonViable = await seedNonViablePlan();
    const outcome = await withActor(userActor(members[0]!), (e) =>
      createThreadForViablePlan(e, nonViable),
    );
    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thread creation on a viable plan (the db/threads.ts helper — no route yet).
// ---------------------------------------------------------------------------

describe('createThreadForViablePlan', () => {
  it('creates one thread with participant_count from the ledger; a second is "exists"', async () => {
    const { planId, members } = await seedViablePlan(3);

    const first = await withActor(userActor(members[1]!), (e) =>
      createThreadForViablePlan(e, planId),
    );
    expect(first.ok).toBe(true);

    const { rows } = await t.pool.query<{ participant_count: number }>(
      `SELECT participant_count FROM message_thread WHERE plan_id = $1`,
      [planId],
    );
    expect(rows[0]?.participant_count).toBe(3);

    const second = await withActor(userActor(members[0]!), (e) =>
      createThreadForViablePlan(e, planId),
    );
    expect(second).toEqual({ ok: false, reason: 'exists' });
  });

  it('rejects a non-participant creating the thread', async () => {
    const { planId } = await seedViablePlan(3);
    const stranger = await seedUser();
    const outcome = await withActor(userActor(stranger), (e) =>
      createThreadForViablePlan(e, planId),
    );
    expect(outcome).toEqual({ ok: false, reason: 'not_participant' });
  });
});

// ---------------------------------------------------------------------------
// GET /plans/:id/thread
// ---------------------------------------------------------------------------

describe('GET /plans/:id/thread', () => {
  it('401 without a session', async () => {
    const { planId } = await seedViablePlan();
    expect((await getThreadRoute(req(undefined), ctx(planId))).status).toBe(401);
  });

  it('404 when the thread has not been created yet, even for a participant', async () => {
    const { planId, members } = await seedViablePlan(3);
    expect((await getThreadRoute(req(await cookieFor(members[0]!)), ctx(planId))).status).toBe(404);
  });

  it('200 with an empty message list for a participant once the thread exists', async () => {
    const { planId, members } = await seedViablePlan(3);
    await makeThread(planId, members[0]!);

    const res = await getThreadRoute(req(await cookieFor(members[1]!)), ctx(planId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thread: Record<string, unknown>; messages: unknown[] };
    expect(Object.keys(body.thread).sort()).toEqual(['id', 'participantCount']);
    expect(body.thread.participantCount).toBe(3);
    expect(body.messages).toEqual([]);
  });

  it('404 for a stranger with a valid session (not a participant)', async () => {
    const { planId, members } = await seedViablePlan(3);
    await makeThread(planId, members[0]!);
    expect((await getThreadRoute(req(await cookieFor(await seedUser())), ctx(planId))).status).toBe(
      404,
    );
  });

  it('404 for a plan the actor cannot even see', async () => {
    // A draft plan is invisible to a non-host; planContext-style 404.
    const draftId = ulid();
    const leadId = await seedUser();
    const circleId = ulid();
    await t.pool.query(`INSERT INTO circle (id, name, lead_user_id) VALUES ($1,'H',$2)`, [
      circleId,
      leadId,
    ]);
    await t.pool.query(
      `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
       VALUES ($1,$2,$3,'lead','active',now())`,
      [ulid(), circleId, leadId],
    );
    const venueId = ulid();
    await t.pool.query(
      `INSERT INTO venue (id, name, address, district, type) VALUES ($1,'V','a','c','bar')`,
      [venueId],
    );
    await t.pool.query(
      `INSERT INTO plan (id, host_circle_id, venue_id, starts_at, open_spots, min_group_size,
                         district, venue_type, state, mode)
       VALUES ($1,$2,$3, now() + interval '5 days', 3, 1, 'c','bar','draft','planned')`,
      [draftId, circleId, venueId],
    );
    expect(
      (await getThreadRoute(req(await cookieFor(await seedUser())), ctx(draftId))).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /plans/:id/thread
// ---------------------------------------------------------------------------

describe('POST /plans/:id/thread', () => {
  it('a participant posts a message; the audit entry records the post but not the body', async () => {
    const { planId, members } = await seedViablePlan(3);
    const threadId = await makeThread(planId, members[0]!);

    const res = await postThreadRoute(
      req(await cookieFor(members[1]!), { body: 'see you at 9' }, 'POST'),
      ctx(planId),
    );
    expect(res.status).toBe(201);
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg.body).toBe('see you at 9');
    expect(msg.senderUserId).toBe(members[1]);

    const audit = await auditRows(threadId);
    expect(audit.map((r) => r.action)).toEqual(['message_post']);
    expect(JSON.stringify(audit[0]?.after_state)).not.toContain('see you at 9');

    // and it shows up on a subsequent GET
    const get = await getThreadRoute(req(await cookieFor(members[2]!)), ctx(planId));
    const body = (await get.json()) as { messages: Array<{ body: string }> };
    expect(body.messages.map((m) => m.body)).toEqual(['see you at 9']);
  });

  it('400 on an empty body, 401 without a session, 404 for a non-participant', async () => {
    const { planId, members } = await seedViablePlan(3);
    await makeThread(planId, members[0]!);

    expect(
      (
        await postThreadRoute(
          req(await cookieFor(members[0]!), { body: '  ' }, 'POST'),
          ctx(planId),
        )
      ).status,
    ).toBe(400);
    expect(
      (await postThreadRoute(req(undefined, { body: 'hi' }, 'POST'), ctx(planId))).status,
    ).toBe(401);
    expect(
      (
        await postThreadRoute(
          req(await cookieFor(await seedUser()), { body: 'hi' }, 'POST'),
          ctx(planId),
        )
      ).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Block, mid-flight (docs/security.md stalking; docs/safety.md D1 preview).
// ---------------------------------------------------------------------------

describe('a blocked co-participant is excluded from the thread in SQL', () => {
  it("hides a blocked member's messages from the blocker, but not from others", async () => {
    const { planId, members } = await seedViablePlan(3);
    const [alice, bob, carol] = members as [string, string, string];
    await makeThread(planId, alice);

    await postThreadRoute(req(await cookieFor(bob), { body: 'from bob' }, 'POST'), ctx(planId));
    await postThreadRoute(req(await cookieFor(alice), { body: 'from alice' }, 'POST'), ctx(planId));

    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      alice,
      bob,
    ]);

    const aliceView = (await (
      await getThreadRoute(req(await cookieFor(alice)), ctx(planId))
    ).json()) as { messages: Array<{ body: string }> };
    expect(aliceView.messages.map((m) => m.body)).toEqual(['from alice']); // bob's is gone

    const carolView = (await (
      await getThreadRoute(req(await cookieFor(carol)), ctx(planId))
    ).json()) as { messages: Array<{ body: string }> };
    expect(carolView.messages.map((m) => m.body).sort()).toEqual(['from alice', 'from bob']);
  });
});
