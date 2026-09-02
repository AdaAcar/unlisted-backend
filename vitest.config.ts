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
    passWithNoTests: true,
  },
});
