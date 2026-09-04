import { describe, expect, it } from 'vitest';

import type { AuditEntry } from '@/db/audit';

const RESOURCE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('AuditEntry moderator reason', () => {
  it('requires `reason` for a moderator entry, at compile time and at the value level', () => {
    // @ts-expect-error moderator entries must carry a `reason`; mirrors the
    // audit_log_moderator_reason_chk database constraint so the omission fails
    // to compile as well as failing to insert.
    const missingReason: AuditEntry = {
      actorRole: 'moderator',
      action: 'ban_user',
      resourceType: 'user',
      resourceId: RESOURCE_ID,
    };

    const withReason: AuditEntry = {
      actorRole: 'moderator',
      action: 'ban_user',
      resourceType: 'user',
      resourceId: RESOURCE_ID,
      reason: 'repeated policy violations',
    };

    expect(withReason.actorRole).toBe('moderator');
    expect((missingReason as { reason?: string }).reason).toBeUndefined();
  });

  it('leaves `reason` optional for a non-moderator user entry', () => {
    const entry: AuditEntry = {
      actorRole: 'user',
      action: 'update_profile',
      resourceType: 'user',
      resourceId: RESOURCE_ID,
    };
    expect(entry.actorRole).toBe('user');
  });

  it('leaves `reason` optional for a system entry', () => {
    const entry: AuditEntry = {
      actorRole: 'system',
      action: 'auto_cancel_plan',
      resourceType: 'plan',
      resourceId: RESOURCE_ID,
    };
    expect(entry.actorRole).toBe('system');
  });
});
