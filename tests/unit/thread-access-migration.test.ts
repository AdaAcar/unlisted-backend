import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../../db/migrations');

function stripComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

const sql = stripComments(readFileSync(resolve(migrations, '0012_thread_access.sql'), 'utf8'));

describe('thread access migration boundaries (C8)', () => {
  it('is recorded at journal index 12 and leaves the frozen migrations alone', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((e) => e.idx === 12)?.tag).toBe('0012_thread_access');
    for (const idx of [0, 1, 4, 11]) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBeTruthy();
    }
  });

  it('drops the circle-to-circle apparatus but keeps the viability FK and the >= 3 check', () => {
    expect(sql).toMatch(/DROP CONSTRAINT message_thread_distinct_circles_chk/i);
    expect(sql).toMatch(/DROP CONSTRAINT message_thread_circle_a_id_circle_id_fk/i);
    expect(sql).toMatch(/DROP CONSTRAINT message_thread_circle_b_id_circle_id_fk/i);
    expect(sql).toMatch(/DROP COLUMN circle_a_id/i);
    expect(sql).toMatch(/DROP COLUMN circle_b_id/i);
    // Never touches the load-bearing 0001 guards.
    expect(sql).not.toMatch(/message_thread_plan_viable_fk/i);
    expect(sql).not.toMatch(/message_thread_min_participants_chk/i);
  });

  it('makes one thread per plan and trigger-maintains participant_count from the ledger', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX message_thread_plan_uq ON (?:public\.)?message_thread \(plan_id\)/i,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER message_thread_set_participant_count\s+BEFORE INSERT ON (?:public\.)?message_thread/i,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER plan_participant_introduction_resync_thread_count\s+AFTER INSERT ON (?:public\.)?plan_participant_introduction/i,
    );
    // The count function reads the ledger and is VOLATILE (called from the
    // AFTER trigger, must see the just-inserted row).
    expect(sql).toMatch(
      /message_thread_ledger_count[\s\S]*?FROM (?:public\.)?plan_participant_introduction/i,
    );
    expect(sql).toMatch(
      /message_thread_ledger_count\(target_plan_id varchar\(26\)\)[\s\S]*?LANGUAGE sql VOLATILE SECURITY DEFINER/i,
    );
  });

  it('adds app_thread_participant as a SECURITY DEFINER predicate, executable by unlisted_app only', () => {
    expect(sql).toMatch(
      /CREATE FUNCTION app_thread_participant\(counterparty_plan_id varchar\(26\)\) RETURNS boolean/i,
    );
    expect(sql).toMatch(/app_thread_participant[\s\S]*?LANGUAGE sql STABLE SECURITY DEFINER/i);
    expect(sql).toMatch(
      /ALTER FUNCTION app_thread_participant\(varchar\) OWNER TO unlisted_migrator/i,
    );
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_thread_participant\(varchar\) FROM PUBLIC/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app_thread_participant\(varchar\) TO unlisted_app/i,
    );
    // never to admin
    expect(sql).not.toMatch(/app_thread_participant\(varchar\) TO [^;]*unlisted_admin/i);
  });

  it('grants unlisted_app SELECT+INSERT (no UPDATE/DELETE) on message_thread and message, RLS-gated on participation', () => {
    expect(sql).toMatch(/GRANT SELECT, INSERT ON (?:public\.)?message_thread TO unlisted_app/i);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON (?:public\.)?message TO unlisted_app/i);
    expect(sql).not.toMatch(
      /GRANT[^;]*(UPDATE|DELETE)[^;]*ON (?:public\.)?message(_thread)? TO unlisted_app/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY message_thread_app_read[\s\S]*?app_thread_participant\(plan_id\)/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY message_thread_app_insert[\s\S]*?app_thread_participant\(plan_id\)/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY message_app_read[\s\S]*?app_user_visible\(sender_user_id\)/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY message_app_insert[\s\S]*?sender_user_id = app_current_actor_id\(\)/i,
    );
    // unlisted_admin gets nothing on either table.
    expect(sql).not.toMatch(/ON (?:public\.)?message(_thread)?[^;]*TO[^;]*unlisted_admin/i);
  });

  it('folds in the carried-over C3 fix: app_active_host_member_count moves to unlisted_migrator', () => {
    expect(sql).toMatch(
      /ALTER FUNCTION app_active_host_member_count\(varchar\) OWNER TO unlisted_migrator/i,
    );
  });
});
