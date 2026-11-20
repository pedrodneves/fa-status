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

// The status pill sits in the band, next to the title.
const pill = (page) => page.locator('.hero-status .pill');
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
  ['approved', 'Approved'], ['provisional', 'Provisionally approved'], ['on_hold', 'On hold'], ['not_approved', 'Not approved'],
  ['revoked', 'Featured status revoked'], ['withdrawn', 'Withdrawn'], ['closed_process', 'Closed: process changed']
];
for (const [state, label] of STATES) {
  test('state ' + state + ' shows "' + label + '"', async ({ page }) => {
    await mockApi(page, one({ state: state, announcement: 'https://lists.example.org/g/tokenomics/message/101' }));
    await page.goto('/#' + TOKEN);
    await expect(pill(page)).toHaveText(label);
    await expect(pill(page)).toHaveAttribute('data-state', state);
    if (['withdrawn', 'closed_process'].includes(state)) {
      await expect(page.locator('[data-step-state]')).toHaveCount(2);
      await expect(page.locator('[data-step-state="stop"]')).toHaveCount(1);
    }
    if (state === 'not_approved') {
      // Received, the verified lock, the committee's decision, then the outcome.
      await expect(page.locator('[data-step]')).toHaveCount(4);
      await expect(page.locator('[data-step="committee"]')).toHaveAttribute('data-step-state', 'done');
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
  await expect(page.locator('.status-box a.p-btn')).toHaveAttribute('href', 'https://canton.foundation/featured-app-request/');
});

// ------------------------------------------------------------------ rejection and provisional status

test('not approved: the decision and its date, why (our email), apply again, questions about the decision', async ({ page }, testInfo) => {
  let body = one({
    state: 'not_approved', dvp: [], update: { kind: 'declined', date: '2026-11-12' },
    history: [{ at: '2026-11-12T14:05:00Z', kind: 'status', to: 'not_approved', from: 'in_review' }]
  });
  await mockApi(page, (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto('/#' + TOKEN);
  await expect(pill(page)).toHaveText('Not approved');
  await expect(page.locator('[data-step="committee"]')).toContainText('Decided 12 Nov 2026');
  await expect(page.locator('[data-step="lock"]')).toHaveAttribute('data-step-state', 'done');
  await expect(page.locator('[data-step="outcome"]')).toContainText('Committee decision');
  await expect(page.locator('.status-message')).toHaveText('The Featured App Committee did not approve this application. Our email explains why.');
  await expect(page.locator('.status-box .next')).toContainText('You can apply again after three months. If you substantially change your proposal, you can resubmit sooner, once the changed version is live on MainNet.');
  const apply = page.locator('.status-box a.p-btn');
  await expect(apply).toHaveText('Apply again ↗');
  await expect(apply).toHaveAttribute('target', '_blank');
  await expect(page.locator('[data-update="declined"]')).toContainText('Emailed 12 Nov 2026');
  await expect(page.locator('[data-update="declined"]')).toContainText('after three months, or sooner with a substantially changed proposal once it\'s live on MainNet');
  await expect(page.locator('[data-section="help"] h2')).toHaveText('Questions about this decision?');
  await expect(page.locator('[data-section="public"]')).toHaveCount(0);
  await expect(page.locator('.tile')).not.toContainText(['Testing']);
  await shot(page, 'app-not-approved', testInfo);

  // No history: the decline email's date. Neither: "Review ended". No verified lock: no lock step.
  body = one({ state: 'not_approved', dvp: [], lock: { verified: null, amountMillions: null }, update: { kind: 'declined', date: '2026-11-10' } });
  await page.goto('/#' + TOKEN.slice(0, 21) + 'n');
  await expect(page.locator('[data-step="committee"]')).toContainText('Decided 10 Nov 2026');
  await expect(page.locator('[data-step="lock"]')).toHaveCount(0);
  body = one({ state: 'not_approved', dvp: [], update: null });
  await page.goto('/#' + TOKEN.slice(0, 21) + 'o');
  await expect(page.locator('[data-step="committee"]')).toContainText('Review ended');
});

test('provisional: the pill, a flagged last step, the conditions wording, and what is public', async ({ page }, testInfo) => {
  await mockApi(page, one({
    state: 'provisional', name: 'Tidepool DEX', faType: 'Featured Asset-Moving App', dvp: [],
    announcement: 'https://lists.example.org/g/tokenomics/message/7'
  }));
  await page.goto('/#' + TOKEN);
  await expect(pill(page)).toHaveText('Provisionally approved');
  await expect(pill(page)).toHaveClass(/warn/);
  const granted = page.locator('[data-step="granted"]');
  await expect(granted).toHaveAttribute('data-step-state', 'done');
  await expect(granted.locator('.pill')).toHaveText('Provisional');
  await expect(granted).toContainText('Conditions apply');
  await expect(page.locator('.status-message')).toContainText('on a provisional basis');
  await expect(page.locator('.status-box .next')).toContainText('the committee can revoke Featured App status');
  await expect(page.locator('.status-box a')).toHaveText(/View the public announcement/);
  const card = page.locator('[data-section="public"]');
  await expect(card).toContainText('Party ID');
  await expect(card.locator('a')).toHaveAttribute('href', '#featured');
  await shot(page, 'app-provisional', testInfo);
});

// ------------------------------------------------------------------ the public list (#featured)

const PID = (hint, ch) => hint + '::1220' + ch.repeat(64);

/** The public list in the backend's contract shape (newest first). */
function featuredList() {
  return {
    updated: '2026-11-20T14:20:00Z',
    apps: [
      { name: 'Tidepool DEX', type: 'Featured Asset-Moving App', status: 'provisional', since: '2026-11-14', sinceExact: true, partyIds: [PID('tidepool-1', 'a')], record: 'https://lists.example.org/g/tokenomics/message/7' },
      { name: 'Harbor Swap', type: 'Featured Asset-Moving App', status: 'featured', since: '2026-11-13', sinceExact: true, partyIds: [PID('harborswap-1', 'b'), PID('harborswap-ops', 'c')], record: 'https://lists.example.org/g/tokenomics/message/8' },
      { name: 'Lumen Wallet', type: 'Basic Featured App', status: 'featured', since: '2026-10-29', sinceExact: true, partyIds: [PID('lumen', 'd')], record: null },
      { name: 'Quarry Bonds', type: 'Featured Asset', status: 'featured', since: '2026-07-07', sinceExact: false, partyIds: [], record: 'javascript:alert(1)' },
      { name: 'Orchard Analytics', type: null, status: 'featured', since: '2026-07-07', sinceExact: false, partyIds: [PID('orchard', 'e')], record: 'https://lists.example.org/g/tokenomics/message/2' }
    ]
  };
}

const pubRow = (page, name) => page.locator('.pub-row').filter({ has: page.locator('.pub-name', { hasText: name }) });

test('public list: the numbers, one row per app with its Party IDs, from one plain GET', async ({ page }, testInfo) => {
  const requests = await mockApi(page, featuredList());
  await page.goto('/#featured');
  await expect(screen(page, 'featured').locator('h1')).toHaveText('Featured apps');
  await expect(page).toHaveTitle('Featured apps · Featured App Status');
  await expect(page.locator('[data-private-link]')).toBeHidden();
  await expect(page.locator('.pub-stat dd')).toHaveText(['5', '2', '1']);
  await expect(page.locator('.pub-row')).toHaveCount(5);
  await expect(page.locator('[data-section="revoked"]')).toHaveCount(0);
  await expect(page.locator('.pub-foot')).toContainText('Showing 5 of 5');
  await expect(page.locator('.pub-foot')).toContainText('Updated 20 Nov 2026');

  const tidepool = pubRow(page, 'Tidepool DEX');
  await expect(tidepool.locator('.pill')).toHaveText('Provisional');
  await expect(tidepool.locator('.pub-note')).toContainText('can revoke it');
  const harbor = pubRow(page, 'Harbor Swap');
  await expect(harbor.locator('[data-field="party-id"]')).toHaveText([PID('harborswap-1', 'b'), PID('harborswap-ops', 'c')]);
  await expect(harbor.locator('.pub-since')).toContainText('13 Nov 2026');
  await expect(harbor.locator('.pub-record a')).toHaveAttribute('href', 'https://lists.example.org/g/tokenomics/message/8');
  const quarry = pubRow(page, 'Quarry Bonds');
  await expect(quarry.locator('.pub-since')).toContainText('By 7 Jul 2026');
  await expect(quarry.locator('.pub-record')).toContainText('Not linked');
  await expect(quarry).toContainText('No Party ID on file');
  await expect(pubRow(page, 'Orchard Analytics').locator('.pub-type')).toContainText('Not set yet');
  await expect(pubRow(page, 'Lumen Wallet').locator('.pub-note')).toHaveCount(0);

  expect(requests).toHaveLength(1);
  const url = new URL(requests[0].url());
  expect(requests[0].method()).toBe('GET');
  expect(url.searchParams.get('view')).toBe('featured');
  expect(url.searchParams.get('link')).toBeNull();
  const feed = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec?view=featured';
  await expect(page.getByRole('link', { name: 'JSON feed ↗' })).toHaveAttribute('href', feed);
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', feed + '&format=csv');
  await expect(page.locator('.feed-code')).toHaveText('GET ' + feed);
  await shot(page, 'featured', testInfo);
});

test('public list: filter chips from the data, and search by name or Party ID', async ({ page }) => {
  await mockApi(page, featuredList());
  await page.goto('/#featured');
  const chips = page.locator('.filter');
  await expect(chips).toHaveText(['All 5', 'Basic Featured App 1', 'Featured Asset-Moving App 2', 'Featured Asset 1', 'Type not set 1', 'Provisional 1']);
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');

  await chips.filter({ hasText: 'Featured Asset-Moving App' }).click();
  await expect(chips.filter({ hasText: 'Featured Asset-Moving App' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.pub-name')).toHaveText(['Tidepool DEX', 'Harbor Swap']);

  const search = page.getByLabel('Search by app name or Party ID');
  await search.fill('harborswap-ops');
  await expect(page.locator('.pub-name')).toHaveText(['Harbor Swap']);
  await expect(search).toBeFocused();

  await chips.first().click();
  await search.fill('LUMEN');
  await expect(page.locator('.pub-name')).toHaveText(['Lumen Wallet']);
  await search.fill('nothing like this');
  await expect(page.locator('.pub-row')).toHaveCount(0);
  await expect(page.locator('.pub-empty')).toHaveText('No featured app matches that search.');
  await expect(page.locator('.pub-foot')).toContainText('Showing 0 of 5');
});

test('public list: revoked apps in a card of their own, with the date, searched with the list', async ({ page }, testInfo) => {
  const body = featuredList();
  body.apps.push(
    { name: 'Copper Bridge', type: 'Featured Asset', status: 'revoked', since: '2026-11-18', sinceExact: true, partyIds: [PID('copper-bridge', '9')], record: 'https://lists.example.org/g/tokenomics/message/5' },
    { name: 'Pilot Markets', type: null, status: 'revoked', since: '2026-07-07', sinceExact: false, partyIds: [], record: null }
  );
  await mockApi(page, body);
  await page.goto('/#featured');

  // The featured list, its numbers and chips leave the revoked apps out.
  const main = page.locator('[data-section="featured"]');
  await expect(page.locator('.pub-stat dd')).toHaveText(['5', '2', '1']);
  await expect(page.locator('.filter').first()).toHaveText('All 5');
  await expect(main.locator('.pub-row')).toHaveCount(5);
  await expect(main.locator('.pub-foot')).toContainText('Showing 5 of 5');

  const revoked = page.locator('[data-section="revoked"]');
  await expect(revoked.locator('h2')).toHaveText('Featured status revoked 2');
  await expect(revoked.locator('.pub-head')).toContainText('Revoked on');
  await expect(revoked.locator('.pub-name')).toHaveText(['Copper Bridge', 'Pilot Markets']);
  const copper = pubRow(page, 'Copper Bridge');
  await expect(copper.locator('.pill')).toHaveText('Revoked');
  await expect(copper.locator('.pill')).toHaveClass(/bad/);
  await expect(copper.locator('.pub-since')).toHaveText('Revoked on: 18 Nov 2026');
  await expect(copper.locator('[data-field="party-id"]')).toHaveText(PID('copper-bridge', '9'));
  await expect(pubRow(page, 'Pilot Markets').locator('.pub-since')).toContainText('By 7 Jul 2026');
  await shot(page, 'featured-revoked', testInfo);

  // The search covers both lists.
  const search = page.getByLabel('Search by app name or Party ID');
  await search.fill('copper-bridge');
  await expect(main.locator('.pub-empty')).toHaveText('No featured app matches that search.');
  await expect(revoked.locator('.pub-name')).toHaveText(['Copper Bridge']);
  await search.fill('harbor');
  await expect(main.locator('.pub-name')).toHaveText(['Harbor Swap']);
  await expect(revoked.locator('.pub-empty')).toHaveText('No revoked app matches that search.');
});

test('revoked: the application page says the app is on the public list as revoked', async ({ page }) => {
  await mockApi(page, one({ state: 'revoked', dvp: [], announcement: 'https://lists.example.org/g/tokenomics/message/5' }));
  await page.goto('/#' + TOKEN);
  await expect(pill(page)).toHaveText('Featured status revoked');
  const card = page.locator('[data-section="public"]');
  await expect(card).toContainText('on the public list as revoked');
  await expect(card.locator('a')).toHaveAttribute('href', '#featured');
});

test('public list: copy a Party ID', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page, featuredList());
  await page.goto('/#featured');
  const button = page.getByRole('button', { name: 'Copy the Party ID of Lumen Wallet' });
  await button.click();
  await expect(button).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PID('lumen', 'd'));
});

test('public list: a failure shows the retry screen; an empty list says so', async ({ page }) => {
  let body = { error: 'unavailable' };
  await mockApi(page, (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto('/#featured');
  await expect(screen(page, 'error').locator('h1')).toHaveText("We couldn't load the list");
  body = { updated: '2026-11-20T14:20:00Z', apps: [] };
  await page.locator('[data-action="retry"]').click();
  await expect(screen(page, 'featured')).toBeVisible();
  await expect(page.locator('.pub-empty')).toHaveText('No apps are listed yet.');
  await expect(page.locator('.pub-stat dd')).toHaveText(['0', '0']);
});

test('the start page and the footer link to the public list, and its back link returns', async ({ page }) => {
  await mockApi(page, featuredList());
  await page.goto('/');
  await expect(page.locator('footer a[href="#featured"]')).toHaveText('Featured apps');
  await page.getByRole('link', { name: 'See which apps are featured →' }).click();
  await expect(screen(page, 'featured')).toBeVisible();
  await page.getByRole('link', { name: '← Check your own application' }).click();
  await expect(screen(page, 'start')).toBeVisible();
});

test('list: provisional apps count as approved', async ({ page }) => {
  const body = three();
  body.apps[2].state = 'provisional';
  await mockApi(page, body);
  await page.goto('/#' + TOKEN);
  await expect(page.locator('.chip')).toHaveText(['3 applications', '1 in progress', '2 approved', '1 DVP request']);
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

// ------------------------------------------------------------------ the redesign: band, tiles, activity, sections

test('start page: how review works, every status, the FAQ, and the footer links', async ({ page }) => {
  await mockApi(page, { found: false });
  await page.goto('/');
  await expect(page.locator('[data-section="how"] li')).toHaveCount(6);
  await expect(page.locator('[data-section="how"] li').nth(4)).toContainText('Tokenomics Committee review');
  await expect(page.locator('[data-section="how"] li').nth(5)).toContainText('the public list of featured apps');
  await expect(page.locator('[data-section="statuses"] .pill')).toHaveCount(10);
  await expect(page.locator('[data-section="statuses"]')).toContainText('Provisionally approved');
  await expect(page.locator('[data-section="faq"] details')).toHaveCount(7);
  await expect(page.locator('[data-section="faq"]')).toContainText('Is anything about my application public?');
  await page.getByText("I didn't get an email").click();
  await expect(page.locator('[data-section="faq"] details').first()).toHaveAttribute('open', '');
  await expect(page.locator('.example')).toHaveAttribute('aria-hidden', 'true');
  const footer = page.locator('footer[data-footer]');
  await expect(footer.locator('a[href="https://canton.foundation/featured-app-request/"]')).toHaveCount(1);
  await expect(footer.locator('a[href="mailto:ops@canton.foundation"]')).toHaveCount(1);
  await expect(footer.locator('a[target="_blank"]').first()).toHaveAttribute('rel', 'noopener noreferrer');
});

test('application page: number tiles, "what happens next", activity newest first', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-17T12:00:00Z'));
  await mockApi(page, one({ update: { kind: 'office_hours', date: '2026-11-16' } }));
  await page.goto('/#' + TOKEN);
  await expect(page.locator('.hero-progress')).toHaveText('Step 5 of 6 · Tokenomics Committee review');
  const tiles = page.locator('.tile');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0)).toContainText('34 days ago');
  await expect(tiles.nth(0)).toContainText('14 Oct 2026');
  await expect(tiles.nth(1)).toContainText('1.5M CC');
  await expect(tiles.nth(2)).toContainText('Complete');
  await expect(tiles.nth(3)).toContainText('14 days ago');
  await expect(page.locator('.status-box .next')).toContainText('If the Tokenomics Committee approves');
  const events = page.locator('[data-section="activity"] li');
  await expect(events).toHaveCount(5);
  await expect(events.first()).toContainText('16 Nov 2026');
  await expect(events.first()).toContainText('Office hours invitation');
  await expect(events.last()).toContainText('Application submitted');
  await expect(page.locator('[data-section="help"] a')).toHaveAttribute('href', 'mailto:ops@canton.foundation');
});

test('ended applications: no testing tile, no "what happens next", no progress line', async ({ page }) => {
  await mockApi(page, one({ state: 'withdrawn', lock: { verified: null, amountMillions: null }, testing: 'not_started', dvp: [] }));
  await page.goto('/#' + TOKEN);
  await expect(pill(page)).toHaveText('Withdrawn');
  await expect(page.locator('.tile')).toHaveCount(2);
  await expect(page.locator('.tile')).not.toContainText(['Testing']);
  await expect(page.locator('.status-box .next')).toHaveCount(0);
  await expect(page.locator('.hero-progress')).toHaveCount(0);
  await expect(page.locator('[data-section="activity"]')).toHaveCount(1);
});

test('Copy Party ID writes the ID to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page, one());
  await page.goto('/#' + TOKEN);
  await page.locator('[data-action="copy"]').click();
  await expect(page.locator('[data-action="copy"]')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(app().partyId);
});

test('list: count chips and the progress of each application', async ({ page }) => {
  await mockApi(page, three());
  await page.goto('/#' + TOKEN);
  await expect(page.locator('.chip')).toHaveText(['3 applications', '1 in progress', '1 approved', '1 ended', '1 DVP request']);
  await expect(page.locator('a.app[data-app-id="101"] .app-step')).toHaveText('Step 5 of 6 · Tokenomics Committee review');
  await expect(page.locator('a.app[data-app-id="103"] .app-step')).toHaveText('All steps complete');
  await expect(page.locator('a.app[data-app-id="99"] .app-step')).toHaveCount(0);
  await expect(page.locator('a.app[data-app-id="101"] .seg')).toHaveCount(6);
});

test('DVP page: tiles with the final approval, and a card back to the application', async ({ page }) => {
  await mockApi(page, one());
  await page.goto('/#' + TOKEN + '/dvp-13557857392');
  await expect(page.locator('.tile').nth(1)).toContainText('Not yet');
  await expect(page.locator('[data-section="for-app"] a.app')).toHaveAttribute('href', '#' + TOKEN);
  await expect(page.locator('[data-section="for-app"] .pill')).toHaveText('With Tokenomics Committee');
});

test('history: every change from the activity log, newest first, older ones folded; lock confirmed by status', async ({ page }) => {
  const history = [
    { at: '2026-11-17T12:35:07Z', kind: 'status', to: 'in_review_locked', from: 'in_review' },
    { at: '2026-11-17T11:26:43Z', kind: 'email', to: 'fa_type_info' },
    { at: '2026-11-17T11:26:31Z', kind: 'fa_type', text: 'Featured Asset-Moving App' },
    { at: '2026-11-17T11:26:27Z', kind: 'dvp_status', to: 'in_review' },
    { at: '2026-10-25T09:00:00Z', kind: 'dvp_state', to: 'with_tokenomics', request: '13557857392' },
    { at: '2026-10-02T09:00:00Z', kind: 'testing', to: 'complete' },
    { at: '2026-09-10T08:01:00Z', kind: 'lock_amount', amount: 1.5 },
    { at: 'not-a-time', kind: 'testing', to: 'complete' },
    { at: '2026-09-09T08:00:00Z', kind: 'something_new', to: 'x' }
  ];
  await page.emulateMedia({ colorScheme: 'light' });
  await mockApi(page, one({ state: 'in_review', lock: { verified: null, amountMillions: null, confirmed: true }, history: history }));
  await page.goto('/#' + TOKEN);
  await expect(page.locator('[data-step="lock"]')).toHaveAttribute('data-step-state', 'done');
  await expect(page.locator('[data-step="lock"]')).toContainText('Confirmed');
  await expect(page.locator('.tile').nth(1)).toContainText('Confirmed');
  await expect(page.locator('[data-section="activity"]')).toHaveCount(0);

  const card = page.locator('[data-section="history"]');
  const visible = card.locator(':scope > ol.activity > li');
  await expect(visible).toHaveCount(6);
  await expect(visible.first()).toContainText('Canton Coin lock confirmed');
  await expect(visible.first()).toContainText('Status: In committee review');
  await expect(visible.first().locator('time')).toHaveAttribute('datetime', '2026-11-17T12:35:07Z');
  await expect(visible.nth(1)).toContainText('Information for Traffic-Based App Rewards');
  await expect(visible.nth(4)).toContainText('Harbor Swap (RFQ settlement) · With Tokenomics Committee');
  // 7 valid log entries + the submission + the DVP submission = 9; 6 shown, 3 folded.
  const more = card.locator('details.history-more');
  await expect(more.locator('summary')).toHaveText('Show 3 earlier changes');
  await more.locator('summary').click();
  await expect(more.locator('li')).toHaveCount(3);
  await expect(more.locator('li').first()).toContainText('Application submitted');
  await expect(more.locator('li').last()).toContainText('Locked amount recorded');
  await expect(card).not.toContainText('something_new');
});

test('history on the DVP page: the request\'s own status changes', async ({ page }) => {
  await mockApi(page, one({ history: [
    { at: '2026-10-25T09:00:00Z', kind: 'dvp_state', to: 'with_tokenomics', request: '13557857392' },
    { at: '2026-10-26T09:00:00Z', kind: 'dvp_state', to: 'approved', request: '999' },
    { at: '2026-11-17T12:35:07Z', kind: 'status', to: 'in_review_locked', from: 'in_review' }
  ] }));
  await page.goto('/#' + TOKEN + '/dvp-13557857392');
  const items = page.locator('[data-section="history"] li');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('Approved by the Featured App Committee');
  await expect(items.last()).toContainText('Request received');
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
  await page.unroute(API);
  await mockApi(page, featuredList());
  await page.goto('/#featured');
  await expect(page.locator('.pub-row')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (testInfo.project.name === 'mobile') await shot(page, 'featured-360', testInfo);
  await page.goto('/');
  await expect(screen(page, 'start')).toBeVisible();
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
  await expect(page.locator('.p-logo')).toBeVisible();
  await expect(button).toHaveAttribute('aria-label', 'Switch to dark theme');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe('rgb(255, 255, 252)');

  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.p-logo')).toBeVisible();
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

test('theme: a dark system setting gives the dark theme and a "white" button', async ({ page }) => {
  await mockApi(page, { found: false });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(screen(page, 'start')).toBeVisible();
  await expect(page.locator('.p-logo')).toBeVisible();
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
