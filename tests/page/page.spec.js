// @ts-check
/**
 * Page tests: docs/ served locally, the Apps Script API mocked with page.route.
 * All data is synthetic. Run with: npm run test:page
 * Screenshots for review land in test-results/screenshots/ (gitignored).
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const API = 'https://script.google.com/macros/s/**';
const TOKEN = 'k7Qm2xV9pLr4TzN8wYc3Ef';
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'screenshots');
const CORS = { 'access-control-allow-origin': '*' };

/** A synthetic application in the backend's contract shape. */
function app(over) {
  return Object.assign({
    id: '101', name: 'Harbor Swap', institution: 'Fernway Labs', type: 'Non-Issuer', submitted: '2026-10-14',
    state: 'with_tokenomics', lock: { verified: '2026-10-18', amountMillions: 1.5 }, testing: 'complete',
    partyId: 'harborswap-1::1220a9c4d0e3f1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef90b81e',
    website: 'https://harborswap.example', announcement: null, updated: '2026-11-03',
    dvp: [{ id: '13557857392', name: 'Harbor Swap (RFQ settlement)', state: 'in_review', submitted: '2026-10-20', finalApproval: null,
      requestUrl: 'https://lists.example.org/g/accountability/message/147', requestRef: '147', updated: '2026-10-31' }]
  }, over || {});
}

/** One application found for the token. */
const one = (over) => ({ found: true, apps: [app(over)] });

/** Three applications, as the backend sends them (newest first). */
const three = () => ({
  found: true,
  apps: [
    app({ id: '103', name: 'Harbor Vault', state: 'approved', submitted: '2026-11-02', announcement: 'https://lists.example.org/g/tokenomics/message/9', dvp: [] }),
    app(),
    app({ id: '99', name: 'Harbor Bridge', state: 'not_approved', submitted: '2026-06-01', dvp: [] })
  ]
});

/**
 * Mocks the API. `answer` is a GET body, or a function (route, request) => void.
 * POSTs (the email form) get `opts.post` (default { ok: true }).
 * Returns the request log.
 */
async function mockApi(page, answer, opts) {
  const options = opts || {};
  const requests = [];
  // The real config.js points at the live deployment; tests always serve their
  // own: a test deployment, or (opts.placeholder) the not-yet-deployed placeholder.
  const deployment = options.placeholder ? 'REPLACE_WITH_DEPLOYMENT_ID' : 'TEST_DEPLOYMENT';
  await page.route('**/config.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: "window.FA_STATUS_CONFIG = Object.freeze({ apiUrl: 'https://script.google.com/macros/s/" + deployment + "/exec', supportEmail: 'ops@canton.foundation', reapplyUrl: 'https://canton.foundation/featured-app-request/' });"
  }));
  await page.route(API, async (route, request) => {
    requests.push(request);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    if (typeof answer === 'function') return answer(route, request);
    const body = request.method() === 'POST' ? (options.post || { ok: true }) : answer;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  });
  return requests;
}

async function shot(page, name, testInfo) {
  await page.screenshot({ path: path.join(SHOTS, name + '-' + testInfo.project.name + '.png'), fullPage: true });
}

const pill = (page) => page.locator('.status-box .pill');
const screen = (page, name) => page.locator('main[data-screen="' + name + '"]');

// ------------------------------------------------------------------ the start page and the email form

test('start page: the email form, no request until it is sent', async ({ page }, testInfo) => {
  const requests = await mockApi(page, { found: false });
  await page.goto('/');
  await expect(screen(page, 'start').locator('h1')).toHaveText('Check your application status');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.locator('[data-private-link]')).toBeHidden();
  expect(requests).toHaveLength(0);
  await shot(page, 'start', testInfo);
});

test('the form refuses something that is not one address, without a request', async ({ page }) => {
  const requests = await mockApi(page, { found: false });
  await page.goto('/');
  for (const bad of ['', 'nope', 'a@b', 'a@b.com, c@d.com']) {
    await page.getByLabel('Email address').fill(bad);
    await page.getByRole('button', { name: 'Email me my link' }).click();
    await expect(page.locator('.form-message')).toHaveText('Enter one email address, like name@company.com.');
    await expect(page.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
  }
  expect(requests).toHaveLength(0);
});

test('sending the form: one POST with a text/plain JSON body, then "check your email"', async ({ page }, testInfo) => {
  const requests = await mockApi(page, { found: false }, { delayMs: 600 });
  await page.goto('/');
  await page.getByLabel('Email address').fill('  alice@harbor.example ');
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(screen(page, 'sent').locator('h1')).toHaveText('Check your email');
  await expect(page.locator('.address')).toHaveText('alice@harbor.example');
  expect(requests).toHaveLength(1);
  const req = requests[0];
  expect(req.method()).toBe('POST');
  expect(JSON.parse(req.postData() || '')).toEqual({ email: 'alice@harbor.example' });
  const headers = req.headers();
  expect(headers['content-type']).toMatch(/^text\/plain/);
  ['authorization', 'cache-control', 'pragma', 'referer'].forEach((h) => expect(headers[h], h).toBeUndefined());
  await shot(page, 'sent', testInfo);

  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(screen(page, 'start')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('');
});

test('the form: a failure or invalid_email keeps the form with a message, and it can be sent again', async ({ page }) => {
  let reply = { status: 500, body: 'oops' };
  await mockApi(page, (route) => route.fulfill({ status: reply.status, contentType: 'application/json', headers: CORS, body: reply.body }));
  await page.goto('/');
  await page.getByLabel('Email address').fill('alice@harbor.example');
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(page.locator('.form-message')).toHaveText("We couldn't send your link just now. Please try again in a minute.");
  await expect(page.getByRole('button', { name: 'Email me my link' })).toBeEnabled();

  reply = { status: 200, body: '{"ok":false,"error":"invalid_email"}' };
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(page.locator('.form-message')).toHaveText('Enter one email address, like name@company.com.');

  reply = { status: 200, body: '{"ok":false,"error":"unavailable"}' };
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(page.locator('.form-message')).toContainText("couldn't send");

  reply = { status: 200, body: '{"ok":true}' };
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(screen(page, 'sent')).toBeVisible();
});

test('the form makes no request while config.js still has the placeholder', async ({ page }) => {
  const requests = await mockApi(page, { found: false }, { placeholder: true });
  await page.goto('/');
  await page.getByLabel('Email address').fill('alice@harbor.example');
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(page.locator('.form-message')).toContainText("couldn't send");
  await page.goto('/#' + TOKEN);
  await expect(screen(page, 'error')).toBeVisible();
  expect(requests).toHaveLength(0);
});

// ------------------------------------------------------------------ opening a link

test('malformed tokens: "not valid" with the form, without any request', async ({ page }) => {
  const requests = await mockApi(page, one());
  for (const bad of ['#abc', '#' + TOKEN.slice(0, 21), '#' + TOKEN + 'x', '#' + TOKEN.slice(0, 21) + '!', '#' + TOKEN + '/dvp-abc']) {
    await page.goto('/' + bad);
    await expect(screen(page, 'invalid').locator('h1')).toHaveText("This link isn't valid");
    await expect(page.getByLabel('Email address')).toBeVisible();
  }
  expect(requests).toHaveLength(0);
});

test('found:false: "not valid", and the form there works; the bad token leaves the URL', async ({ page }, testInfo) => {
  await mockApi(page, { found: false });
  await page.goto('/#' + TOKEN);
  await expect(screen(page, 'invalid')).toBeVisible();
  await shot(page, 'invalid', testInfo);
  await page.getByLabel('Email address').fill('alice@harbor.example');
  await page.getByRole('button', { name: 'Email me my link' }).click();
  await expect(screen(page, 'sent')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('loading, then the only application straight away; one plain GET with no custom headers', async ({ page }, testInfo) => {
  const requests = await mockApi(page, one(), { delayMs: 1200 });
  await page.goto('/#' + TOKEN);
  await expect(screen(page, 'loading')).toBeVisible();
  await shot(page, 'loading', testInfo);
  await expect(screen(page, 'app').locator('h1')).toHaveText('Harbor Swap');
  await expect(page.locator('a.back')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  const req = requests[0];
  expect(req.method()).toBe('GET');
  expect(new URL(req.url()).searchParams.get('link')).toBe(TOKEN);
  const headers = req.headers();
  ['content-type', 'authorization', 'cache-control', 'pragma', 'referer'].forEach((h) => expect(headers[h], h).toBeUndefined());
});

test('a trailing "." or ")" pasted from an email still works', async ({ page }) => {
  await mockApi(page, one());
  await page.goto('/#' + TOKEN + ').');
  await expect(screen(page, 'app').locator('h1')).toHaveText('Harbor Swap');
});

test('several applications: the list, then each page, with links back; one request in all', async ({ page }, testInfo) => {
  const requests = await mockApi(page, three());
  await page.goto('/#' + TOKEN);
  await expect(screen(page, 'list').locator('h1')).toHaveText('Your applications');
  await expect(page.locator('a.app[data-app-id]')).toHaveCount(3);
  await expect(page.locator('a.app[data-app-id]').first()).toContainText('Harbor Vault');
  await expect(page.locator('a.app[data-app-id="101"]')).toContainText('1 DVP request');
  await expect(page.locator('a.app[data-app-id="99"] .pill')).toHaveText('Not approved');
  await expect(page.locator('[data-private-link]')).toBeVisible();
  await expect(page).toHaveTitle('Your applications · Featured App Status');
  await shot(page, 'list', testInfo);

  await page.locator('a.app[data-app-id="101"]').click();
  await expect(page).toHaveURL(new RegExp('#' + TOKEN + '/app-101$'));
  await expect(screen(page, 'app').locator('h1')).toHaveText('Harbor Swap');
  await page.locator('a.app[data-dvp-id]').click();
  await expect(page).toHaveURL(new RegExp('#' + TOKEN + '/app-101/dvp-13557857392$'));
  await expect(screen(page, 'dvp').locator('h1')).toHaveText('Harbor Swap (RFQ settlement)');
  await page.locator('a.back').click();
  await expect(screen(page, 'app').locator('h1')).toHaveText('Harbor Swap');
  await page.locator('a.back').click();
  await expect(screen(page, 'list')).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('unknown ids in the URL fall back to the application, then to the list', async ({ page }) => {
  await mockApi(page, three());
  await page.goto('/#' + TOKEN + '/app-101/dvp-555');
  await expect(screen(page, 'app').locator('h1')).toHaveText('Harbor Swap');
  await page.goto('/#' + TOKEN + '/app-777');
  await expect(screen(page, 'list')).toBeVisible();
  await page.goto('/#' + TOKEN + '/dvp-13557857392');
  await expect(screen(page, 'dvp').locator('h1')).toHaveText('Harbor Swap (RFQ settlement)');
});

// ------------------------------------------------------------------ the application page

test('with_tokenomics page: pill, timeline, on file, DVP list, private-link badge, title', async ({ page }, testInfo) => {
  await mockApi(page, one());
  await page.goto('/#' + TOKEN);
  await expect(pill(page)).toHaveText('With Tokenomics Committee');
  await expect(pill(page)).toHaveAttribute('data-state', 'with_tokenomics');
  await expect(page.locator('.status-box')).toContainText('Last updated 3 Nov 2026');
  await expect(page.locator('[data-step-state]')).toHaveCount(6);
  await expect(page.locator('[data-step-state="current"]')).toContainText('Tokenomics Committee review');
  await expect(page.locator('.tl')).toContainText('1.5M CC locked');
  await expect(page.locator('[data-field="party-id"]')).toContainText('harborswap-1::');
  await expect(page.locator('[data-field="website"] a')).toHaveAttribute('href', 'https://harborswap.example/');
  await expect(page.locator('a.app[data-dvp-id]')).toHaveCount(1);
  await expect(page.locator('a.app[data-dvp-id]')).toHaveAttribute('href', '#' + TOKEN + '/dvp-13557857392');
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
    await mockApi(page, one({ state: state, announcement: 'https://lists.example.org/g/tokenomics/message/101' }));
    await page.goto('/#' + TOKEN);
    await expect(pill(page)).toHaveText(label);
    await expect(pill(page)).toHaveAttribute('data-state', state);
    if (['not_approved', 'withdrawn', 'closed_process'].includes(state)) {
      await expect(page.locator('[data-step-state]')).toHaveCount(2);
      await expect(page.locator('[data-step-state="stop"]')).toHaveCount(1);
    }
  });
}

test('approved: announcement link (https only); closed: reapply link; not approved: contact line', async ({ page }, testInfo) => {
  let body = one({ state: 'approved', name: 'Fernway USD', announcement: 'https://lists.example.org/g/tokenomics/message/101', dvp: [] });
  await mockApi(page, (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto('/#' + TOKEN);
  await expect(page.locator('.status-box a')).toHaveText(/View the public announcement/);
  await expect(page.locator('[data-step-state="done"]')).toHaveCount(6);
  await shot(page, 'app-approved', testInfo);

  body = one({ state: 'approved', announcement: 'javascript:alert(1)' });
  await page.goto('/#' + TOKEN.slice(0, 21) + 'g');
  await expect(pill(page)).toHaveText('Approved');
  await expect(page.locator('.status-box a')).toHaveCount(0);

  body = one({ state: 'closed_process', name: 'Lumen Wallet', dvp: [] });
  await page.goto('/#' + TOKEN.slice(0, 21) + 'h');
  await expect(page.locator('.status-box a')).toHaveAttribute('href', 'https://canton.foundation/featured-app-request/');

  body = one({ state: 'not_approved', dvp: [] });
  await page.goto('/#' + TOKEN.slice(0, 21) + 'i');
  await expect(page.locator('.status-contact a')).toHaveAttribute('href', 'mailto:ops@canton.foundation');
});

test('the latest committee email shows under the status, with its date; resubmit links to the new form', async ({ page }, testInfo) => {
  let body = one({ update: { kind: 'office_hours', date: '2026-11-16' } });
  await mockApi(page, (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto('/#' + TOKEN);
  const box = page.locator('[data-update]');
  await expect(box).toHaveAttribute('data-update', 'office_hours');
  await expect(box).toContainText('Latest email from the committee');
  await expect(box).toContainText('Office hours invitation');
  await expect(box).toContainText('Emailed 16 Nov 2026');
  await expect(box.locator('a')).toHaveCount(0);
  await shot(page, 'app-update', testInfo);

  body = one({ update: { kind: 'resubmit', date: '2026-08-31' } });
  await page.goto('/#' + TOKEN.slice(0, 21) + 'j');
  await expect(page.locator('[data-update="resubmit"] a')).toHaveAttribute('href', 'https://canton.foundation/featured-app-request/');

  const cases = [null, { kind: 'something_new', date: '2026-11-16' }, 'office_hours'];
  for (let i = 0; i < cases.length; i++) {
    body = one({ name: 'Harbor Swap', update: cases[i] });
    await page.goto('/#' + TOKEN.slice(0, 20) + 'k' + i);  // a new token each time, so the page asks again
    await expect(page.locator('main h1')).toHaveText('Harbor Swap');
    await expect(page.locator('[data-update]')).toHaveCount(0);
  }
});

test('FA type under "On file"; DVP status at the top of the DVP section, even without DVP requests', async ({ page }, testInfo) => {
  let body = one({ faType: 'Basic Featured App', dvpStatus: 'faac_approved' });
  await mockApi(page, (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto('/#' + TOKEN);
  await expect(page.locator('[data-field="fa-type"]')).toHaveText('Basic Featured App');
  await expect(page.locator('[data-dvp-status="faac_approved"] .pill')).toHaveText('Approved by the Featured App Committee');
  await expect(page.locator('a.app[data-dvp-id]')).toHaveCount(1);
  await shot(page, 'app-dvp-status', testInfo);

  body = one({ dvpStatus: 'declined', dvp: [] });
  await page.goto('/#' + TOKEN.slice(0, 20) + 'm1');
  await expect(page.locator('[data-section="dvp"] .pill')).toHaveText('Declined');
  await expect(page.locator('[data-field="fa-type"]')).toHaveCount(0);

  body = one({ dvpStatus: 'something_new', dvp: [] });
  await page.goto('/#' + TOKEN.slice(0, 20) + 'm2');
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  await expect(page.locator('[data-section="dvp"]')).toHaveCount(0);
});

test('testing action_needed shows "Action needed"', async ({ page }) => {
  await mockApi(page, one({ state: 'in_review', testing: 'action_needed', lock: { verified: null, amountMillions: null }, dvp: [] }));
  await page.goto('/#' + TOKEN);
  await expect(page.locator('.tl')).toContainText('Action needed');
  await expect(page.locator('.tl')).toContainText('We emailed you about testing access');
});

test('DVP page: reference, public record, back link, no refetch', async ({ page }, testInfo) => {
  const requests = await mockApi(page, one());
  await page.goto('/#' + TOKEN);
  await page.locator('a.app[data-dvp-id]').click();
  await expect(screen(page, 'dvp').locator('h1')).toHaveText('Harbor Swap (RFQ settlement)');
  await expect(page.locator('.d-eyebrow')).toContainText('#147');
  await expect(page.locator('[data-section="record"] a')).toHaveAttribute('href', 'https://lists.example.org/g/accountability/message/147');
  await shot(page, 'dvp', testInfo);
  await page.locator('a.back').click();
  await expect(screen(page, 'app')).toBeVisible();
  expect(requests).toHaveLength(1);
});

// ------------------------------------------------------------------ failures

test('errors show the retry screen, and "Try again" recovers', async ({ page }, testInfo) => {
  let mode = 'error';
  await mockApi(page, (route) => {
    if (mode === 'error') return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"error":"unavailable"}' });
    if (mode === '500') return route.fulfill({ status: 500, headers: CORS, body: 'oops' });
    if (mode === 'abort') return route.abort();
    if (mode === 'empty') return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"found":true,"apps":"nope"}' });
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(one()) });
  });
  await page.goto('/#' + TOKEN);
  await expect(screen(page, 'error')).toBeVisible();
  await shot(page, 'error', testInfo);
  for (const m of ['500', 'abort', 'empty']) {
    mode = m;
    await page.locator('[data-action="retry"]').click();
    await expect(screen(page, 'error')).toBeVisible();
  }
  mode = 'ok';
  await page.locator('[data-action="retry"]').click();
  await expect(screen(page, 'app').locator('h1')).toHaveText('Harbor Swap');
});

test('a hash change to another token fetches its applications', async ({ page }) => {
  await mockApi(page, (route, request) => {
    const token = new URL(request.url()).searchParams.get('link');
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(one({ name: token === TOKEN ? 'Harbor Swap' : 'Quillpoint Vault' })) });
  });
  await page.goto('/#' + TOKEN);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  await page.evaluate((t) => { location.hash = t; }, 'QQQQQQQQQQQQQQQQQQQQQQ');
  await expect(page.locator('main h1')).toHaveText('Quillpoint Vault');
});

// ------------------------------------------------------------------ safety and layout

test('data is rendered as text: no HTML injection', async ({ page }) => {
  const evil = { name: '<img src=x onerror="window.__x=1">', institution: '<script>window.__y=1</script>' };
  await mockApi(page, { found: true, apps: [app(evil), app(Object.assign({ id: '5' }, evil))] });
  await page.goto('/#' + TOKEN);
  await expect(page.locator('a.app[data-app-id]').first()).toContainText('<img src=x onerror="window.__x=1">');
  await page.goto('/#' + TOKEN + '/app-101');
  await expect(page.locator('main h1')).toHaveText('<img src=x onerror="window.__x=1">');
  expect(await page.evaluate(() => [window.__x, window.__y, document.querySelectorAll('main img, main script').length])).toEqual([undefined, undefined, 0]);
});

test('privacy meta tags, CSP, and no request other than the page and the API', async ({ page }) => {
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173') && !r.url().startsWith('https://script.google.com/') && !r.url().startsWith('data:')) external.push(r.url()); });
  await mockApi(page, one());
  await page.goto('/#' + TOKEN);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com/);
  expect(external).toEqual([]);
});

test('no horizontal scroll at 360px; dark mode has a dark background', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockApi(page, one({ partyId: 'x'.repeat(300) }));
  await page.goto('/#' + TOKEN);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/');
  await expect(screen(page, 'start')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  expect(r + g + b).toBeLessThan(120);
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload(); // a fresh layout at full width, so the screenshot isn't stitched
    await expect(screen(page, 'start')).toBeVisible();
    await shot(page, 'start-dark', testInfo);
  }
});

test('theme: follows the system until the button is pressed, then remembers the choice', async ({ page }, testInfo) => {
  await mockApi(page, one());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#' + TOKEN);
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  const button = page.locator('[data-theme-toggle]');
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('.p-logo-light')).toBeVisible();
  await expect(page.locator('.p-logo-dark')).toBeHidden();
  await expect(button).toHaveAttribute('aria-label', 'Switch to dark theme');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe('rgb(255, 255, 252)');

  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.p-logo-dark')).toBeVisible();
  await expect(page.locator('.p-logo-light')).toBeHidden();
  await expect(button).toHaveAttribute('aria-label', 'Switch to white theme');
  expect(await background()).toBe('rgb(24, 2, 49)');
  if (testInfo.project.name === 'desktop') await shot(page, 'app-dark-picked', testInfo);

  // The choice survives a reload, even with the system set to light.
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Harbor Swap');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await background()).toBe('rgb(24, 2, 49)');

  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect(await background()).toBe('rgb(255, 255, 252)');
});

test('theme: a dark system setting gives the dark theme, the dark logo and a "white" button', async ({ page }) => {
  await mockApi(page, { found: false });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(screen(page, 'start')).toBeVisible();
  await expect(page.locator('.p-logo-dark')).toBeVisible();
  await expect(page.locator('.p-logo-light')).toBeHidden();
  await expect(page.locator('[data-theme-toggle]')).toHaveAttribute('aria-label', 'Switch to white theme');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(24, 2, 49)');
});

test('brand: IBM Plex Sans is served by the site itself, the logo has a text alternative', async ({ page }) => {
  const fontRequests = [];
  page.on('request', (r) => { if (r.resourceType() === 'font') fontRequests.push(r.url()); });
  await mockApi(page, { found: false });
  await page.goto('/');
  await expect(screen(page, 'start')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Sans"'))).toBe(true);
  expect(fontRequests.length).toBeGreaterThan(0);
  fontRequests.forEach((url) => expect(url).toMatch(/^http:\/\/localhost:4173\/fonts\//));
  await expect(page.getByRole('img', { name: 'Canton Foundation' })).toHaveCount(1);
});

test('unknown paths get the 404 page', async ({ page }) => {
  const res = await page.goto('/no/such/page');
  expect(res && res.status()).toBe(404);
  await expect(page.locator('h1')).toContainText('not found');
});
