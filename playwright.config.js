// Page tests: docs/ served locally, the Apps Script API mocked with page.route.
// Uses the installed Google Chrome (channel 'chrome'), so no browser download.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/page',
  timeout: 30000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173', channel: 'chrome' },
  webServer: { command: 'node tests/support/static-server.js 4173', url: 'http://localhost:4173', reuseExistingServer: true },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
  ]
});
