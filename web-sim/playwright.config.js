// The harnesses talk to two local servers, so the test run starts both itself. Without this a fresh
// clone fails with a connection error rather than a useful one.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // The IoU gate opens a reference page per state, so it is slow by nature, not by accident.
  timeout: 15 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  webServer: [
    {
      command: 'node tools/serve.js ../../lilguy-fork/public 8793',
      url: 'http://localhost:8793/single-eye.html',
      reuseExistingServer: true,
      timeout: 20000,
    },
    {
      command: 'node tools/serve.js . 8794',
      url: 'http://localhost:8794/lark.js',
      reuseExistingServer: true,
      timeout: 20000,
    },
    // The editor is a separate Vite app with its own dependencies. Started here so `npm test` covers
    // it from a fresh clone, but its install is NOT this package's problem -- the spec skips itself
    // with a clear message when editor/node_modules is missing, rather than failing the whole run.
    {
      command: 'npm --prefix editor run dev',
      url: 'http://localhost:8795/',
      reuseExistingServer: true,
      timeout: 40000,
    },
  ],
});
