import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    viewport: { width: 390, height: 844 },
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npx tsx scripts/browser-fixture.ts && npm run start -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    env: { DATABASE_URL: "file:.data/browser-test.db" },
    timeout: 60000,
  },
});
