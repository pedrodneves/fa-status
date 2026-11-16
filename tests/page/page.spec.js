// @ts-check
/**
 * Page tests: docs/ served locally, the Apps Script API mocked with page.route.
 * All data is synthetic. Run with: npm run test:page
 * Screenshots for review land in test-results/screenshots/ (gitignored).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const API = 'https://script.google.com/macros/s/**';
const CODE = 'k7Qm2xV9pLr4TzN8wYc3Ef';
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'screenshots');

/** A synthetic app object in the backend's contract shape. */
function app(over) {
  return Object.assign({
    name: 'Harbor Swap', institution: 'Fernway Labs', type: 'Non-Issuer', submitted: '2026-10-14',
    state: 'with_tokenomics', lock: { verified: '2026-10-18', amountMillions: 1.5 }, testing: 'complete',
    partyId: 'harborswap-1::1220a9c4d0e3f1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef90b81e',
    website: 'https://harborswap.example', announcement: null, updated: '2026-11-03',
    dvp: [{ id: '13557857392', name: 'Harbor Swap: RFQ settlement', state: 'in_review', submitted: '2026-10-20', finalApproval: null,
      requestUrl: 'https://lists.example.org/g/accountability/message/147', requestRef: '147', updated: '2026-10-31' }]
  }, over || {});
}

/** Mocks the API. `answer` is a body object, or a function (route, request) => void. Returns the request log. */
async function mockApi(page, answer, opts) {
  const requests = [];
  // The shipped config.js holds a placeholder deployment URL, which the page
  // deliberately refuses to call. Tests serve a config with a real-looking one.
  await page.route('**/config.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: "window.FA_STATUS_CONFIG = Object.freeze({ apiUrl: 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec', supportEmail: 'ops@canton.foundation', reapplyUrl: 'https://canton.foundation/featured-app-request/' });"
  }));
  await page.route(API, async (route, request) => {
    requests.push(request);
    if (opts && opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (typeof answer === 'function') return answer(route, request);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  return requests;
}

async function shot(page, name, testInfo) {
  await page.screenshot({ path: path.join(SHOTS, name + '-' + testInfo.project.name + '.png'), fullPage: true });
}

const pill = (page) => page.locator('.status-box .pill');

// ------------------------------------------------------------------ routing

test('no code: explains how to open the link, makes no request', async ({ page }, testInfo) => {
  const requests = await mockApi(page, { found: false });
  await page.goto('/');
  await expect(page.locator('main[data-screen="no-code"] h1')).toHaveText('Open your status link');
  expect(requests).toHaveLength(0);
  await shot(page, 'no-code', testInfo);
});

test('malformed codes: "not valid" without any request', async ({ page }) => {
  const requests = await mockApi(page, { found: true, app: app() });
  for (const bad of ['#abc', '#' + CODE.slice(0, 21), '#' + CODE + 'x', '#' + CODE.slice(0, 21) + '!']) {
    await page.goto('/' + bad);
    await expect(page.locator('main[data-screen="invalid"] h1')).toHaveText("This link isn't valid");
  }
  expect(requests).toHaveLength(0);
});

test('loading, then the application; one plain GET with no custom headers', async ({ page }, testInfo) => {
  const requests = await mockApi(page, { found: true, app: app() }, { delayMs: 1200 });
  await page.goto('/#' + CODE);
  await expect(page.locator('main[data-screen="loading"]')).toBeVisible();
  await shot(page, 'loading', testInfo);
  await expect(page.locator('main[data-screen="app"] h1')).toHaveText('Harbor Swap');
  expect(requests).toHaveLength(1);
  const req = requests[0];
  expect(req.method()).toBe('GET');
  expect(new URL(req.url()).searchParams.get('link')).toBe(CODE);
  const headers = req.headers();
  ['content-type', 'authorization', 'cache-control', 'pragma', 'referer'].forEach((h) => expect(headers[h], h).toBeUndefined());
});

test('a trailing "." or ")" pasted from an email still works', async ({ page }) => {
  await mockApi(page, { found: true, app: app() });
  await page.goto('/#' + CODE + ').');
  await expect(page.locator('main[data-screen="app"] h1')).toHaveText('Harbor Swap');
});

// ------------------------------------------------------------------ the application page

test('with_tokenomics page: pill, timeline, on file, DVP list, private-link badge, title', async ({ page }, testInfo) => {
  await mockApi(page, { found: true, app: app() });
  await page.goto('/#' + CODE);
  await expect(pill(page)).toHaveText('With Tokenomics Committee');
  await expect(pill(page)).toHaveAttribute('data-state', 'with_tokenomics');
  await expect(page.locator('.status-box')).toContainText('Last updated 3 Nov 2026');
  await expect(page.locator('[data-step-state]')).toHaveCount(6);
  await expect(page.locator('[data-step-state="current"]')).toContainText('Tokenomics Committee review');
  await expect(page.locator('.tl')).toContainText('1.5M CC locked');
  await expect(page.locator('[data-field="party-id"]')).toContainText('harborswap-1::');
  await expect(page.locator('[data-field="website"] a')).toHaveAttribute('href', 'https://harborswap.example/');
  await expect(page.locator('a.app[data-dvp-id]')).toHaveCount(1);
  await expect(page.locator('[data-private-link]')).toBeVisible();
  await expect(page).toHaveTitle('Harbor Swap · Featured App Status');
  await expect(page.locator('main h1')).toBeFocused();
  await shot(page, 'app-with-tokenomics', testInfo);
});

const STATES = [
  ['received', 'Received'], ['in_review', 'In committee review'], ['with_tokenomics', 'With Tokenomics Committee'],
  ['approved', 'Approved'], ['on_hold', 'On hold'], ['not_approved', 'Not approved'], ['revoked', 'Featured status revoked'],
  ['withdrawn', 'Withdrawn'], ['closed_process', 'Closed: process changed']
];
for (const [state, label] of STATES) {
  test('state ' + state + ' shows "' + label + '"', async ({ page }) => {
    await mockApi(page, { found: true, app: app({ state: state, announcement: 'https://lists.example.org/g/tokenomics/message/101' }) });
    await page.goto('/#' + CODE);
    await expect(pill(page)).toHaveText(label);
    await expect(pill(page)).toHaveAttribute('data-state', state);
    if (['not_approved', 'withdrawn', 'closed_process'].includes(state)) {
      await expect(page.locator('[data-step-state]')).toHaveCount(2);
      await expect(page.locator('[data-step-state="stop"]')).toHaveCount(1);
    }
  });
}

test('approved: announcement link (https only); closed: reapply link; not approved: contact line', async ({ page }, testInfo) => {
  await mockApi(page, (route, request) => {
    const n = Number(new URL(request.url()).searchParams.get('link').slice(-1) === 'f' ? 0 : 1);
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ found: true, app: n === 0
      ? app({ state: 'approved', name: 'Fernway USD', announcement: 'https://lists.example.org/g/tokenomics/message/101', dvp: [] })
      : app({ state: 'approved', announcement: 'javascript:alert(1)' }) }) });
  });
  await page.goto('/#' + CODE);
  await expect(page.locator('.status-box a')).toHaveText(/View the public announcement/);
  await expect(page.locator('[data-step-state="done"]')).toHaveCount(6);
  await shot(page, 'app-approved', testInfo);
  await page.goto('/#' + CODE.slice(0, 21) + 'g');
  await expect(pill(page)).toHaveText('Approved');
  await expect(page.locator('.status-box a')).toHaveCount(0);
});

test('closed_process and not_approved extras', async ({ page }, testInfo) => {
  let state = 'closed_process';
  await mockApi(page, (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ found: true, app: app({ state: state, name: 'Lumen Wallet', dvp: [] }) }) }));
  await page.goto('/#' + CODE);
  await expect(page.locator('.status-box a')).toHaveAttribute('href', 'https://canton.foundation/featured-app-request/');
  await shot(page, 'app-closed', testInfo);
  state = 'not_approved';
  await page.goto('/#' + CODE.slice(0, 21) + 'A');
  await expect(page.locator('.status-contact a')).toHaveAttribute('href', 'mailto:ops@canton.foundation');
});

test('testing action_needed shows "Action needed"', async ({ page }, testInfo) => {
  await mockApi(page, { found: true, app: app({ state: 'in_review', testing: 'action_needed', lock: { verified: null, amountMillions: null }, dvp: [] }) });
  await page.goto('/#' + CODE);
  await expect(page.locator('.tl')).toContainText('Action needed');
  await expect(page.locator('.tl')).toContainText('We emailed you about testing access');
  await shot(page, 'app-action-needed', testInfo);
});

// ------------------------------------------------------------------ DVP detail

test('DVP: card opens the request page, back link returns, no refetch', async ({ page }, testInfo) => {
  const requests = await mockApi(page, { found: true, app: app() });
  await page.goto('/#' + CODE);
  await page.locator('a.app[data-dvp-id]').click();
  await expect(page.locator('main[data-screen="dvp"] h1')).toHaveText('Harbor Swap: RFQ settlement');
  await expect(page.locator('.d-eyebrow')).toContainText('#147');
  await expect(page.locator('[data-section="record"] a')).toHaveAttribute('href', 'https://lists.example.org/g/accountability/message/147');
  await shot(page, 'dvp', testInfo);
  await page.locator('a.back').click();
  await expect(page.locator('main[data-screen="app"]')).toBeVisible();
  expect(requests).toHaveLength(1);
});

// ------------------------------------------------------------------ failures

test('found:false shows "not valid"', async ({ page }, testInfo) => {
  await mockApi(page, { found: false });
  await page.goto('/#' + CODE);
  await expect(page.locator('main[data-screen="invalid"]')).toBeVisible();
  await shot(page, 'invalid', testInfo);
});

test('errors show the retry screen, and "Try again" recovers', async ({ page }, testInfo) => {
  let mode = 'error';
  await mockApi(page, (route) => {
    if (mode === 'error') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"error":"unavailable"}' });
    if (mode === '500') return route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'oops' });
    if (mode === 'abort') return route.abort();
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ found: true, app: app() }) });
  });
  await page.goto('/#' + CODE);
  await expect(page.locator('main[data-screen="error"]')).toBeVisible();
  await shot(page, 'error', testInfo);
  for (const m of ['500', 'abort']) {
    mode = m;
    await page.locator('[data-action="retry"]').click();
    await expect(page.locator('main[data-screen="error"]')).toBeVisible();
  }
  mode = 'ok';
  await page.locator('[data-action="retry"]').click();
  await expect(page.locator('main[data-screen="app"] h1')).toHaveText('Harbor Swap');
});

test('hash change to another code fetches the new application', async ({ page }) => {
  await mockApi(page, (route, request) => {
    const code = new URL(request.url()).searchParams.get('link');
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ found: true, app: app({ name: code === CODE ? 'Harbor Swap' : 'Quillpoint Vault' }) }) });
  });
  await page.goto('/#' + CODE);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  await page.evaluate((c) => { location.hash = c; }, 'QQQQQQQQQQQQQQQQQQQQQQ');
  await expect(page.locator('main h1')).toHaveText('Quillpoint Vault');
});

// ------------------------------------------------------------------ safety and layout

test('data is rendered as text: no HTML injection', async ({ page }) => {
  await mockApi(page, { found: true, app: app({ name: '<img src=x onerror="window.__x=1">', institution: '<script>window.__y=1</script>' }) });
  await page.goto('/#' + CODE);
  await expect(page.locator('main h1')).toHaveText('<img src=x onerror="window.__x=1">');
  expect(await page.evaluate(() => [window.__x, window.__y, document.querySelectorAll('main img, main script').length])).toEqual([undefined, undefined, 0]);
});

test('privacy meta tags, CSP, and no request other than the page and the API', async ({ page }) => {
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173') && !r.url().startsWith('https://script.google.com/') && !r.url().startsWith('data:')) external.push(r.url()); });
  await mockApi(page, { found: true, app: app() });
  await page.goto('/#' + CODE);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com/);
  expect(external).toEqual([]);
});

test('no horizontal scroll at 360px; dark mode has a dark background', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockApi(page, { found: true, app: app({ partyId: 'x'.repeat(300) }) });
  await page.goto('/#' + CODE);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  expect(r + g + b).toBeLessThan(120);
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload(); // a fresh layout at full width, so the screenshot isn't stitched
    await expect(page.locator('main h1')).toHaveText('Harbor Swap');
    await shot(page, 'app-dark', testInfo);
  }
});

test('unknown paths get the 404 page', async ({ page }) => {
  const res = await page.goto('/no/such/page');
  expect(res && res.status()).toBe(404);
  await expect(page.locator('h1')).toContainText('not found');
});
