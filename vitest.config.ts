import { configDefaults, defineConfig } from 'vitest/config';

// Coverage-enforced: `npm run test:coverage` fails on any regression below
// 100%. Genuinely-unreachable defensive branches are excluded inline with
// `/* v8 ignore next */`. The bare `npm test` stays coverage-free for fast
// local iteration.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Nested checkouts of this same repo (agent worktrees). The default
      // `include` is recursive, so without this every test runs twice.
      '**/.claude/**',
      '**/worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // stdio entry point — covered by the boot test, not unit tests
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
