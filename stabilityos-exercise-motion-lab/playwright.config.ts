import { defineConfig, devices } from '@playwright/test';

// Uses the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH). WebGL runs through
// Chromium's software rasteriser in headless CI containers; see docs/VALIDATION.md.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'evidence/playwright-output',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'evidence/e2e-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    // `npm run preview` binds 127.0.0.1 explicitly: a bare `localhost` can resolve to ::1 first
    // (e.g. GitHub's Ubuntu runners), leaving this IPv4 URL unreachable until the timeout.
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    { name: 'workbench', testIgnore: /render-bench/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'bench', testMatch: /render-bench/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
});
