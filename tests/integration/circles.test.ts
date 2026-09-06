import { NextRequest } from 'next/server';
import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST as createCircleRoute } from '@/app/api/circles/route';
import { GET as getCircleRoute } from '@/app/api/circles/[id]/route';
import { POST as addMemberRoute } from '@/app/api/circles/[id]/members/route';
import { POST as acceptRoute } from '@/app/api/circles/[id]/members/accept/route';
import { DELETE as removeMemberRoute } from '@/app/api/circles/[id]/members/[userId]/route';
import { POST as transferLeadRoute } from '@/app/api/circles/[id]/lead/route';
import { circles, createCircle, recordAuditEntry } from '@/db';
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

async function seedUser(opts: { verified?: boolean; standing?: string } = {}): Promise<string> {
  const id = ulid();
  await t.pool.query(
    `INSERT INTO "user" (id, first_name, verification_state, standing) VALUES ($1, 'U', $2, $3)`,
    [id, opts.verified === false ? 'none' : 'verified', opts.standing ?? 'good'],
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

function req(method: string, cookie?: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/circles', {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const memberCtx = (id: string, userId: string) => ({ params: Promise.resolve({ id, userId }) });

/** Create a circle straight through the route; returns its id and the lead's cookie. */
async function newCircle(
  name = 'Hosts',
): Promise<{ circleId: string; leadId: string; leadCookie: string }> {
  const leadId = await seedUser();
  const leadCookie = await cookieFor(leadId);
  const res = await createCircleRoute(req('POST', leadCookie, { name }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return { circleId: body.id, leadId, leadCookie };
}

async function addActiveMember(
  circleId: string,
  role: 'member' | 'lead' = 'member',
): Promise<string> {
  const userId = await seedUser();
  await t.pool.query(
    `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, $4, 'active', now())`,
    [ulid(), circleId, userId, role],
  );
  return userId;
}

async function auditActions(circleId: string): Promise<string[]> {
  const { rows } = await t.pool.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY created_at`,
    [circleId],
  );
  return rows.map((r) => r.action);
}

async function activeLeads(circleId: string): Promise<string[]> {
  const { rows } = await t.pool.query<{ user_id: string }>(
    `SELECT user_id FROM circle_member
     WHERE circle_id = $1 AND role = 'lead' AND status = 'active'`,
    [circleId],
  );
  return rows.map((r) => r.user_id);
}

describe('POST /circles', () => {
  it('creates a circle, makes the creator the lead, and returns a counter-free view', async () => {
    const leadId = await seedUser();
    const res = await createCircleRoute(
      req('POST', await cookieFor(leadId), { name: 'Kadikoy Crew' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['id', 'leadUserId', 'memberIds', 'name']);
    expect(body.name).toBe('Kadikoy Crew');
    expect(body.leadUserId).toBe(leadId);
    expect(body.memberIds).toEqual([leadId]);

    const { rows } = await t.pool.query<{ role: string; status: string }>(
      `SELECT role, status FROM circle_member WHERE circle_id = $1`,
      [body.id],
    );
    expect(rows).toEqual([{ role: 'lead', status: 'active' }]);
    expect(await auditActions(body.id as string)).toEqual(['circle_create']);
  });

  it('rejects an unverified creator with 403 and an unauthenticated one with 401', async () => {
    const unverified = await seedUser({ verified: false });
    expect(
      (await createCircleRoute(req('POST', await cookieFor(unverified), { name: 'X' }))).status,
    ).toBe(403);
    expect((await createCircleRoute(req('POST', undefined, { name: 'X' }))).status).toBe(401);
  });

  it('rejects a blank or over-long name with 400', async () => {
    const cookie = await cookieFor(await seedUser());
    expect((await createCircleRoute(req('POST', cookie, { name: '   ' }))).status).toBe(400);
    expect((await createCircleRoute(req('POST', cookie, { name: 'x'.repeat(121) }))).status).toBe(
      400,
    );
  });
});

describe('a non-member gets 404 on every circle route', () => {
  it('GET, add member, remove member, transfer lead, and accept all 404', async () => {
    const { circleId } = await newCircle();
    const outsiderCookie = await cookieFor(await seedUser());
    const victimId = await seedUser();

    expect((await getCircleRoute(req('GET', outsiderCookie), idCtx(circleId))).status).toBe(404);
    expect(
      (await addMemberRoute(req('POST', outsiderCookie, { userId: victimId }), idCtx(circleId)))
        .status,
    ).toBe(404);
    expect(
      (await removeMemberRoute(req('DELETE', outsiderCookie), memberCtx(circleId, victimId)))
        .status,
    ).toBe(404);
    expect(
      (await transferLeadRoute(req('POST', outsiderCookie, { userId: victimId }), idCtx(circleId)))
        .status,
    ).toBe(404);
    expect((await acceptRoute(req('POST', outsiderCookie), idCtx(circleId))).status).toBe(404);
  });

  it('does not distinguish a real circle from a made-up id', async () => {
    const outsiderCookie = await cookieFor(await seedUser());
    expect((await getCircleRoute(req('GET', outsiderCookie), idCtx(ulid()))).status).toBe(404);
  });
});

describe('lead-only actions are denied to an ordinary member (403, not 404)', () => {
  it('add member, remove another member, and transfer lead are all forbidden', async () => {
    const { circleId, leadId } = await newCircle();
    const memberId = await addActiveMember(circleId);
    const memberCookie = await cookieFor(memberId);
    const someoneElse = await seedUser();

    expect(
      (await addMemberRoute(req('POST', memberCookie, { userId: someoneElse }), idCtx(circleId)))
        .status,
    ).toBe(403);
    expect(
      (await removeMemberRoute(req('DELETE', memberCookie), memberCtx(circleId, leadId))).status,
    ).toBe(403);
    expect(
      (await transferLeadRoute(req('POST', memberCookie, { userId: leadId }), idCtx(circleId)))
        .status,
    ).toBe(403);
  });
});

describe('member self-removal', () => {
  it('lets an ordinary member remove themselves and drops them from the roster', async () => {
    const { circleId, leadId, leadCookie } = await newCircle();
    const memberId = await addActiveMember(circleId);

    const res = await removeMemberRoute(
      req('DELETE', await cookieFor(memberId)),
      memberCtx(circleId, memberId),
    );
    expect(res.status).toBe(204);

    const { rows } = await t.pool.query<{ status: string }>(
      `SELECT status FROM circle_member WHERE circle_id = $1 AND user_id = $2`,
      [circleId, memberId],
    );
    expect(rows[0]?.status).toBe('removed');

    const view = (await (await getCircleRoute(req('GET', leadCookie), idCtx(circleId))).json()) as {
      memberIds: string[];
    };
    expect(view.memberIds).toEqual([leadId]);
    expect(await auditActions(circleId)).toContain('circle_member_remove');
  });

  it('refuses to let the sitting lead remove themselves (409, transfer first)', async () => {
    const { circleId, leadId, leadCookie } = await newCircle();
    await addActiveMember(circleId);

    const res = await removeMemberRoute(req('DELETE', leadCookie), memberCtx(circleId, leadId));
    expect(res.status).toBe(409);
    expect(await activeLeads(circleId)).toEqual([leadId]);
  });
});

describe('invitation acceptance', () => {
  it('an invited user cannot read the circle and is not counted active until they accept', async () => {
    const { circleId, leadId, leadCookie } = await newCircle();
    const inviteeId = await seedUser();
    const inviteeCookie = await cookieFor(inviteeId);

    expect(
      (await addMemberRoute(req('POST', leadCookie, { userId: inviteeId }), idCtx(circleId)))
        .status,
    ).toBe(204);

    // Not yet a member: no read access.
    expect((await getCircleRoute(req('GET', inviteeCookie), idCtx(circleId))).status).toBe(404);

    // Not counted as active in the lead's view.
    const before = (await (
      await getCircleRoute(req('GET', leadCookie), idCtx(circleId))
    ).json()) as { memberIds: string[] };
    expect(before.memberIds).toEqual([leadId]);

    // Accept -> active, readable, counted.
    expect((await acceptRoute(req('POST', inviteeCookie), idCtx(circleId))).status).toBe(204);
    expect((await getCircleRoute(req('GET', inviteeCookie), idCtx(circleId))).status).toBe(200);
    const after = (await (
      await getCircleRoute(req('GET', leadCookie), idCtx(circleId))
    ).json()) as { memberIds: string[] };
    expect(after.memberIds.sort()).toEqual([leadId, inviteeId].sort());

    expect(await auditActions(circleId)).toEqual([
      'circle_create',
      'circle_member_invite',
      'circle_member_accept',
    ]);
  });

  it('accepting with no pending invitation 404s', async () => {
    const { circleId } = await newCircle();
    expect(
      (await acceptRoute(req('POST', await cookieFor(await seedUser())), idCtx(circleId))).status,
    ).toBe(404);
  });

  it('rejects an invite of an unknown user (422) and a duplicate invite (409)', async () => {
    const { circleId, leadCookie } = await newCircle();
    expect(
      (await addMemberRoute(req('POST', leadCookie, { userId: ulid() }), idCtx(circleId))).status,
    ).toBe(422);

    const inviteeId = await seedUser();
    expect(
      (await addMemberRoute(req('POST', leadCookie, { userId: inviteeId }), idCtx(circleId)))
        .status,
    ).toBe(204);
    expect(
      (await addMemberRoute(req('POST', leadCookie, { userId: inviteeId }), idCtx(circleId)))
        .status,
    ).toBe(409);
  });
});

describe('transfer lead', () => {
  it('leaves exactly one active lead, on both circle.lead_user_id and circle_member', async () => {
    const { circleId, leadId, leadCookie } = await newCircle();
    const newLeadId = await addActiveMember(circleId);

    const res = await transferLeadRoute(
      req('POST', leadCookie, { userId: newLeadId }),
      idCtx(circleId),
    );
    expect(res.status).toBe(204);

    const { rows: circleRows } = await t.pool.query<{ lead_user_id: string }>(
      `SELECT lead_user_id FROM circle WHERE id = $1`,
      [circleId],
    );
    expect(circleRows[0]?.lead_user_id).toBe(newLeadId);

    expect(await activeLeads(circleId)).toEqual([newLeadId]);

    const { rows: memberRows } = await t.pool.query<{
      user_id: string;
      role: string;
      status: string;
    }>(`SELECT user_id, role, status FROM circle_member WHERE circle_id = $1 ORDER BY role`, [
      circleId,
    ]);
    expect(memberRows).toEqual([
      { user_id: newLeadId, role: 'lead', status: 'active' },
      { user_id: leadId, role: 'member', status: 'active' },
    ]);
    expect(await auditActions(circleId)).toContain('circle_transfer_lead');
  });

  it('cannot be used to reach a two-lead state — the partial unique index blocks a second active lead', async () => {
    const { circleId } = await newCircle();
    await expect(
      t.pool.query(
        `INSERT INTO circle_member (id, circle_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, 'lead', 'active', now())`,
        [ulid(), circleId, await seedUser()],
      ),
    ).rejects.toThrow(/circle_one_active_lead|duplicate key/);
  });

  it('rejects a transfer to a non-active-member with 409 and no change', async () => {
    const { circleId, leadId, leadCookie } = await newCircle();
    const strangerId = await seedUser();

    const res = await transferLeadRoute(
      req('POST', leadCookie, { userId: strangerId }),
      idCtx(circleId),
    );
    expect(res.status).toBe(409);
    expect(await activeLeads(circleId)).toEqual([leadId]);

    const { rows } = await t.pool.query<{ lead_user_id: string }>(
      `SELECT lead_user_id FROM circle WHERE id = $1`,
      [circleId],
    );
    expect(rows[0]?.lead_user_id).toBe(leadId);
  });
});

describe('block exclusion happens in SQL, not after fetching', () => {
  it('a blocked co-member is removed from the roster by a NOT EXISTS on block', async () => {
    const { circleId, leadId } = await newCircle();
    const memberId = await addActiveMember(circleId);
    const blockedId = await addActiveMember(circleId);

    const compiled = circles.get(userActor(leadId), circleId).toSQL().sql.toLowerCase();
    expect(compiled).toContain('not exists');
    expect(compiled).toContain('block');

    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      leadId,
      blockedId,
    ]);

    const view = await circles.get(userActor(leadId), circleId);
    expect(view?.memberIds.sort()).toEqual([leadId, memberId].sort());

    // The other direction is excluded too.
    await t.pool.query(`DELETE FROM block WHERE blocker_user_id = $1`, [leadId]);
    await t.pool.query(`INSERT INTO block (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      blockedId,
      leadId,
    ]);
    const view2 = await circles.get(userActor(leadId), circleId);
    expect(view2?.memberIds.sort()).toEqual([leadId, memberId].sort());
  });
});

describe('audit + rollback', () => {
  it('writes one audit row per state change and none when the transaction rolls back', async () => {
    const leadId = await seedUser();
    const actor = userActor(leadId);
    const doomedId = ulid();

    await expect(
      withActor(actor, async (executor) => {
        await createCircle(executor, actor, 'Doomed');
        await recordAuditEntry(executor, actor, {
          action: 'circle_create',
          actorRole: 'user',
          resourceId: doomedId,
          resourceType: 'circle',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect((await t.pool.query(`SELECT 1 FROM circle WHERE name = 'Doomed'`)).rowCount).toBe(0);
    expect(await auditActions(doomedId)).toEqual([]);
  });
});
