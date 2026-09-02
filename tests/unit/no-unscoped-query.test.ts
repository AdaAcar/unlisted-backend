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
      const allowed =
        relativePath === 'db/client.ts' ||
        relativePath.startsWith('db/scope/') ||
        relativePath.startsWith('db/admin/');
      if (allowed) return [];
      const source = readFileSync(path, 'utf8');
      return RAW_IMPORTS.some((pattern) => pattern.test(source)) ? [relativePath] : [];
    });
    expect(violations).toEqual([]);
  });

  it('keeps raw select calls out of repositories', () => {
    const violations = typescriptFiles(join(DB_ROOT, 'repositories')).filter((path) =>
      /\.(?:select|execute)\s*\(/.test(readFileSync(path, 'utf8')),
    );
    expect(violations.map(repoPath)).toEqual([]);
  });

  it('sets actor scope transaction-locally and never at session scope', () => {
    const source = readFileSync(join(DB_ROOT, 'scope/scoped.ts'), 'utf8');
    expect(source).not.toMatch(/SET\s+SESSION/i);
    expect(source.match(/set_config\([^\n]+true\)/g)).toHaveLength(2);
    expect(source).toContain('.transaction(');
  });
});
