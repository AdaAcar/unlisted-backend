import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Client } = pg;
const defaultMigrationsFolder = resolve(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

function migrationsFolderFromArgs(args) {
  const index = args.indexOf('--migrations-folder');
  if (index === -1) return defaultMigrationsFolder;
  const value = args[index + 1];
  if (!value) throw new Error('--migrations-folder requires a path');
  return resolve(value);
}

export async function runMigrations({
  assumeMigratorRole = true,
  connectionString = process.env.DATABASE_URL,
  migrationsFolder = defaultMigrationsFolder,
} = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required');

  // This connection belongs only to this dedicated runner. A session-scoped role
  // is safe here because the connection is permanently closed in finally.
  const client = new Client({ connectionString });
  try {
    await client.connect();
    if (assumeMigratorRole) await client.query('SET ROLE unlisted_migrator');
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  runMigrations({
    assumeMigratorRole: !args.includes('--bootstrap'),
    migrationsFolder: migrationsFolderFromArgs(args),
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
