import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const e2eDatabase = resolve('.tmp', `picknext-e2e-${Date.now()}.db`);
const e2ePort = process.env.E2E_PORT ?? '5560';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${e2ePort}`, trace: 'retain-on-failure', ...devices['Pixel 7'] },
  webServer: {
    command: 'node apps/server/dist/main.js',
    url: `http://127.0.0.1:${e2ePort}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: e2ePort,
      DATABASE_PATH: e2eDatabase,
      JWT_SECRET: 'e2e-secret-with-more-than-thirty-two-characters'
    }
  }
});
