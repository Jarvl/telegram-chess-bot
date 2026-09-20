import { defineConfig } from 'vitest/config';

const hasDatabase = Boolean(process.env.TEST_DATABASE_URL);
if (!hasDatabase) {
  console.warn(
    '[server] TEST_DATABASE_URL is not set: integration tests are skipped. See scripts/local-postgres.sh.',
  );
}

export default defineConfig({
  test: {
    name: 'server',
    include: hasDatabase ? ['test/**/*.test.ts'] : ['test/unit/**/*.test.ts'],
    globalSetup: hasDatabase ? ['test/helpers/globalSetup.ts'] : [],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
