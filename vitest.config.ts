import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/architecture/**/*.test.ts', 'tests/protocol/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 30_000,
  },
});
