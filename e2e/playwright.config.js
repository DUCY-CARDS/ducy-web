// Browser tests (#553): the site and a local relay, in Chromium and WebKit.
// Needs the wasm build in wasm/ and `npm ci --prefix relay`. E2E_CHANNEL=chrome
// uses an installed Chrome instead of Playwright's Chromium.
import { defineConfig, devices } from '@playwright/test';

// E2E_PORT moves both, so two checkouts can run their tests at once.
const shift = Number(process.env.E2E_PORT || 0);
export const SITE_PORT = 4173 + shift;
export const RELAY_PORT = 8788 + shift;
const channel = process.env.E2E_CHANNEL;

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  // A whole run can't hang CI or a machine: it stops itself.
  globalTimeout: 25 * 60_000,
  expect: {timeout: 30_000},
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {baseURL: `http://localhost:${SITE_PORT}`},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome'], ...(channel ? {channel} : {})}},
    {name: 'webkit', use: {...devices['Desktop Safari']}},
    {name: 'chromium-phone', use: {...devices['Pixel 7'], viewport: {width: 375, height: 800}, ...(channel ? {channel} : {})}},
    {name: 'webkit-phone', use: {...devices['iPhone 14'], viewport: {width: 375, height: 800}}},
  ],
  webServer: [
    {command: `node e2e/serve.mjs ${SITE_PORT}`, cwd: '..', url: `http://localhost:${SITE_PORT}/index.html`},
    {command: `node relay/dev-server.mjs ${RELAY_PORT}`, cwd: '..', port: RELAY_PORT},
  ],
});
