import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const DB_ROOT = join(ROOT, 'db');
const RAW_IMPORTS = [
  /from ['"]pg['"]/,
  /from ['"]drizzle-orm\/node-postgres['"]/,
  /from ['"]@\/db\/client['"]/,
  /from ['"]@\/db\/admin['"]/,
  /from ['"](?:\.\.\/)+client['"]/,
];
const TRUSTED_DB_FILES = new Set([
  'db/admin/index.ts',
  'db/client.ts',
  'db/scope/resolve.ts',
  'db/scope/scoped.ts',
]);
const RAW_EXECUTION = /\.(?:execute|select|transaction)\s*\(/;

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function repoPath(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

describe('database scoping chokepoint', () => {
  it('keeps raw database imports in the explicitly allowed modules', () => {
    const violations = typescriptFiles(DB_ROOT).flatMap((path) => {
      const relativePath = repoPath(path);
      const allowed = TRUSTED_DB_FILES.has(relativePath);
      if (allowed) return [];
      const source = readFileSync(path, 'utf8');
      return RAW_IMPORTS.some((pattern) => pattern.test(source)) ? [relativePath] : [];
    });
    expect(violations).toEqual([]);
  });

  it('does not trust database directories or test directories through glob exemptions', () => {
    const eslint = JSON.parse(readFileSync(join(ROOT, '.eslintrc.json'), 'utf8')) as {
      overrides?: { files?: string[] }[];
    };
    const trusted = eslint.overrides?.flatMap((override) => override.files ?? []) ?? [];
    expect(trusted.some((entry) => entry.includes('**'))).toBe(false);
    expect(new Set(trusted)).toEqual(
      new Set([
        'db/client.ts',
        'db/scope/scoped.ts',
        'db/scope/resolve.ts',
        'db/admin/index.ts',
        'tests/integration/support/db.ts',
        'tests/integration/rls-deny-by-default.test.ts',
        'tests/integration/repo-block-scoping.test.ts',
      ]),
    );
  });

  it('keeps raw select calls out of repositories', () => {
    const violations = typescriptFiles(DB_ROOT).filter((path) => {
      if (TRUSTED_DB_FILES.has(repoPath(path))) return false;
      return RAW_EXECUTION.test(readFileSync(path, 'utf8'));
    });
    expect(violations.map(repoPath)).toEqual([]);
  });

  it('sets actor scope transaction-locally and never at session scope', () => {
    const source = readFileSync(join(DB_ROOT, 'scope/scoped.ts'), 'utf8');
    expect(source).not.toMatch(/SET\s+SESSION/i);
    expect(source.match(/set_config\([^\n]+true\)/g)).toHaveLength(2);
    expect(source).toContain('.transaction(');
    expect(source).toMatch(/SET LOCAL ROLE unlisted_app/);
  });

  it('sets admin capability transaction-locally through the named executor', () => {
    const source = readFileSync(join(DB_ROOT, 'admin/index.ts'), 'utf8');
    expect(source).not.toMatch(/SET\s+SESSION/i);
    expect(source).toContain('.transaction(');
    expect(source).toMatch(/SET LOCAL ROLE unlisted_admin/);
  });
});
