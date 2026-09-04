import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('environment parsing', () => {
  it('is lazy at import time', async () => {
    delete process.env.DATABASE_URL;
    await expect(import('@/lib/env')).resolves.toBeDefined();
  });

  it('reports a missing required database URL clearly', async () => {
    delete process.env.DATABASE_URL;
    const { env } = await import('@/lib/env');
    expect(() => env.databaseUrl).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-Postgres URL', async () => {
    process.env.DATABASE_URL = 'https://example.test/database';
    const { env } = await import('@/lib/env');
    expect(() => env.databaseUrl).toThrow(/postgres/i);
  });

  it('parses the three runtime role URLs', async () => {
    process.env.DATABASE_URL = 'postgres://owner:secret@localhost:5432/db';
    process.env.APP_DATABASE_URL = 'postgres://app:secret@localhost:5432/db';
    process.env.ADMIN_DATABASE_URL = 'postgres://admin:secret@localhost:5432/db';
    const { env } = await import('@/lib/env');
    expect(env.databaseUrl).toContain('owner');
    expect(env.appDatabaseUrl).toContain('app');
    expect(env.adminDatabaseUrl).toContain('admin');
  });

  it('reports a missing audit hash secret clearly', async () => {
    delete process.env.AUDIT_HASH_SECRET;
    const { env } = await import('@/lib/env');
    expect(() => env.auditHashSecret).toThrow(/AUDIT_HASH_SECRET/);
  });

  it('rejects an audit hash secret shorter than 32 bytes', async () => {
    process.env.AUDIT_HASH_SECRET = 'too-short';
    const { env } = await import('@/lib/env');
    expect(() => env.auditHashSecret).toThrow(/AUDIT_HASH_SECRET/);
  });

  it('accepts a 32-byte-or-longer audit hash secret', async () => {
    process.env.AUDIT_HASH_SECRET = 'x'.repeat(32);
    const { env } = await import('@/lib/env');
    expect(env.auditHashSecret).toBe('x'.repeat(32));
  });
});
