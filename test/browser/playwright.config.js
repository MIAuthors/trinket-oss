const { defineConfig, devices } = require('@playwright/test');

// Browser smoke tests against a LOCAL `make gcp` stack (Firestore + Firebase-Auth
// + Storage emulators, app on :3001). These exercise the client-side journeys the
// HTTP `flow` harness cannot: editor prefill, running code, snapshot rendering.
// Auth is handled hermetically by global-setup via the Firebase Auth emulator.
module.exports = defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: require.resolve('./global-setup'),
  use: {
    baseURL: process.env.TRINKET_BASE_URL || 'http://localhost:3001',
    storageState: require('path').join(__dirname, '.auth-state.json'),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // glowscript/WebVPython render via WebGL; SwiftShader gives headless Chrome a
    // software GL context so canvas/snapshot paths actually run.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
