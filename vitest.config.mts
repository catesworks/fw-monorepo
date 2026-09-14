import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'suite-nav',
          root: path.join(import.meta.dirname, 'packages/suite-nav'),
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui',
          root: path.join(import.meta.dirname, 'packages/ui'),
          environment: 'jsdom',
          setupFiles: ['./src/vitest.setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
