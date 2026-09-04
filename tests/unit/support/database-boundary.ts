import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DATABASE_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
]);

export const TRUSTED_DATABASE_FILES = new Set([
  'db/admin/index.ts',
  'db/client.ts',
  'db/migrate.mjs',
  'db/scope/resolve.ts',
  'db/scope/scoped.ts',
]);

const MODULE_SPECIFIER =
  /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RAW_ACQUISITION = /\b(?:getPool|getDb|getAppDb|getAdminDb|withAdmin|adminDb)\b/;
const RAW_EXECUTION = /\.\s*(?:query|connect|select|execute|transaction)\s*\(|\.\s*\$client\b/;

function extension(path: string): string {
  const match = path.match(/(\.[^.\/]+)$/);
  return match?.[1] ?? '';
}

function isRawModule(specifier: string): boolean {
  const normalized = specifier.replace(/\\/g, '/').replace(/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/, '');
  if (/^(?:pg|pg\/.*|drizzle-orm\/node-postgres(?:\/.*)?)$/.test(normalized)) return true;
  if (/^(?:@\/|#|~\/)?db\/(?:client|admin)(?:\/.*)?$/.test(normalized)) return true;
  return /^(?:\.\.?\/)+(?:.*\/)?(?:client|admin)(?:\/.*)?$/.test(normalized);
}

export function databaseBoundaryViolations(repoPath: string, source: string): string[] {
  if (TRUSTED_DATABASE_FILES.has(repoPath)) return [];

  const violations = new Set<string>();
  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier && isRawModule(specifier)) violations.add(`raw module: ${specifier}`);
  }
  if (RAW_ACQUISITION.test(source)) violations.add('raw database acquisition');
  if (RAW_EXECUTION.test(source)) violations.add('raw database execution');
  return [...violations];
}

export function databaseSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return databaseSourceFiles(path);
    return entry.isFile() && DATABASE_SOURCE_EXTENSIONS.has(extension(path)) ? [path] : [];
  });
}

export function scanDatabaseBoundary(root: string, databaseRoot: string): string[] {
  return databaseSourceFiles(databaseRoot).flatMap((path) => {
    const repoPath = relative(root, path).split(sep).join('/');
    return databaseBoundaryViolations(repoPath, readFileSync(path, 'utf8')).map(
      (reason) => `${repoPath}: ${reason}`,
    );
  });
}
