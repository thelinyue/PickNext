import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const e2eDatabase = resolve('.tmp', `picknext-e2e-${Date.now()}.db`);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5560', trace: 'retain-on-failure', ...devices['Pixel 7'] },
  webServer: {
    command: 'node apps/server/dist/main.js',
    url: 'http://127.0.0.1:5560/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '5560',
      DATABASE_PATH: e2eDatabase,
      JWT_SECRET: 'e2e-secret-with-more-than-thirty-two-characters'
    }
  }
});
