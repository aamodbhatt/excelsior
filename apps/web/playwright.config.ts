import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8193);

/**
 * End-to-end tests run the production build behind the real server with a throwaway database.
 * Locally they use the installed Microsoft Edge; CI uses Playwright's Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.CI ? undefined : 'msedge',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node --import tsx apps/server/src/main.ts',
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/api/auth/me`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      EXCELSIOR_DB: `apps/server/var/e2e-${Date.now()}.sqlite`,
      EXCELSIOR_ORIGINS: `http://127.0.0.1:${PORT},http://localhost:${PORT}`,
    },
  },
});
