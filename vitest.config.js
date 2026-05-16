import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 10000,
    hookTimeout: 15000,
    include: ['tests/**/*.test.js'],
    globals: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      PORT: '0',
      RATE_LIMIT_MAX_REQUESTS: '10000',
      LOG_TO_FILE: 'false',
    },
  },
});
