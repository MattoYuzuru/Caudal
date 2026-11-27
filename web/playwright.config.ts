import { defineConfig, devices } from '@playwright/test';

const port = 4179;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  workers: process.env.CI ? 1 : 2,
  forbidOnly: Boolean(process.env.CI),
  use: { ...devices['Desktop Chrome'], baseURL, viewport: { width: 1440, height: 910 }, serviceWorkers: 'block' },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: { CAUDAL_WEB_COVERAGE: '1' },
  },
});
