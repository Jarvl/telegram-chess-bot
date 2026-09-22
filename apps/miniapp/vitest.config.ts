import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
  test: {
    name: 'miniapp',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
