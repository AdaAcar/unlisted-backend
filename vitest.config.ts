import path from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * The `@/*` path alias is declared in tsconfig.json for the type checker and
 * mirrored here for the test runner. It is a single root-level entry (`@` -> repo
 * root); keep the two in sync. We do not use `vite-tsconfig-paths` because it is
 * ESM-only and Vitest loads this config through a CommonJS `require`, which fails
 * on an ESM-only dependency. A one-line alias avoids the dependency entirely and
 * avoids making the whole package ESM (`"type": "module"`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/env.ts'],
    // Integration tests drop and recreate the `public` schema of a single test
    // database; running test files in parallel would let them clobber each
    // other. The suite is small enough that serial files cost nothing.
    fileParallelism: false,
    hookTimeout: 30000,
    // The C5/C6/C7a route tests drive several full HTTP handlers per case, each
    // opening its own actor-scoped transaction chain against real Postgres; a
    // few (concurrency probes, multi-member confirm loops) legitimately take
    // 5-15s. The default 5s testTimeout is for pure/unit work.
    testTimeout: 20000,
    passWithNoTests: true,
  },
});
