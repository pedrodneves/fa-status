'use strict';
/**
 * Backend tests: apps-script/Code.gs run in Node with mocked Google services
 * (tests/support/gas-env.js) against a fake Monday API (tests/support/fake-monday.js).
 * All data is synthetic. Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv } = require('../support/gas-env');
const { createFakeMonday, faItem, dvpItem, FA, DVP, LINK_COL, REL_COL, SENTINELS } = require('../support/fake-monday');

const SITE = 'https://status.example.org';
const BASE_PROPS = { MONDAY_API_TOKEN: 'test-token-xyz', STATUS_LINK_COLUMN_ID: LINK_COL, SITE_URL: SITE };
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const ALLOWED_FA_COLUMNS = ['text_mm4k2vch', 'color_mm4kmej3', 'color_mm4kpp3q', 'date_mm4kw11a', 'date_mm4kpckv', 'numeric_mm4k6919', 'color_mm6be9ge', 'long_text_mm4kq322', 'link_mm4kmq24', 'link_mm6hfp5g', 'color_mm6eay19', LINK_COL];
const ALLOWED_DVP_COLUMNS = ['date_mm8dsx4y', 'date_mm8dm7a0', 'link_mm8rp25j', 'color_mm8dhgvr', REL_COL];

/** A fixed, valid code for pre-filled cells: 'C' + 21 chars from the seed. */
const codeOf = (seed) => (seed + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').replace(/[^A-Za-z0-9_-]/g, 'x').slice(0, 22);
const linkTo = (code) => SITE + '/#' + code;

/** Builds a fake Monday + a script environment wired to it. */
function setup(opts) {
  const o = opts || {};
  const fake = createFakeMonday({ fa: o.fa || [], dvp: o.dvp || [], statusLinkLabel: o.label === true, statusLinkLabelDeactivated: o.labelDeactivated });
  const env = createGasEnv({ props: Object.assign({}, BASE_PROPS, o.props || {}), fetch: fake.handle });
  return { fake, env };
}

/** n synthetic FA rows with empty Status links. */
function emptyRows(n, extra) {
  return Array.from({ length: n }, (_, i) => faItem(Object.assign({ id: 1000 + i, name: 'App ' + i, status: '1-Needs Review' }, extra || {})));
}

/** The code written into a row's Status link cell, read back from the fake board. */
function writtenCode(fake, itemId) {
  const cell = fake.cell(itemId, LINK_COL);
  if (!cell || !cell.value) return null;
  const url = JSON.parse(cell.value).url;
  return url.slice(url.indexOf('#') + 1);
}

// ============================================================ codes and link cells

test('new codes are 22 base64url characters and unique', () => {
  const { env } = setup();
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const code = env.call('newCode_', {});
    assert.match(code, CODE_RE);
    seen.add(code);
  }
  assert.equal(seen.size, 3000);
});

test('codeFromCell_ reads only well-formed Status links', () => {
  const { env } = setup();
  const code = codeOf('k7Qm2xV9pLr4TzN8wYc3Ef');
  const link = (url, text) => ({ id: LINK_COL, type: 'link', text: text || url, value: JSON.stringify({ url: url, text: text || url }) });
  assert.equal(env.call('codeFromCell_', { id: LINK_COL, type: 'link', text: '', value: null }), '', 'empty cell');
  assert.equal(env.call('codeFromCell_', link(linkTo(code))), code);
  assert.equal(env.call('codeFromCell_', link(linkTo(code) + '/dvp-147')), code, 'sub-route');
  assert.equal(env.call('codeFromCell_', link('https://old-host.example/#' + code, 'Status link')), code, 'any host');
  assert.equal(env.call('codeFromCell_', link('https://example.org/no-code')), null, 'no #');
  assert.equal(env.call('codeFromCell_', link(linkTo(code.slice(0, 21)))), null, 'too short');
  assert.equal(env.call('codeFromCell_', { id: LINK_COL, type: 'link', text: 'typed by hand', value: null }), null, 'text but no value: never overwritten');
  assert.equal(env.call('codeFromCell_', null), null, 'column missing');
});

// ============================================================ the applicant view

test('every FA Status label maps to its state key; empty and unknown labels too', () => {
  const { env } = setup();
  const cases = {
    '0-Locked+Needs Review': 'in_review', '1-Needs Review': 'in_review', '1b-FAAC Approved-waiting on tokenomics': 'with_tokenomics',
    '2-Approved': 'approved', '3-CIP-0116-paused': 'on_hold', '4-No': 'not_approved', '5-Revoked': 'revoked',
    '6-Withdrawn': 'withdrawn', '7-Closed-new-process': 'closed_process', '': 'received', 'Some new label': 'in_review'
  };
  Object.keys(cases).forEach((label) => {
    const app = env.call('toApplicantView', faItem({ id: 1, name: 'X', status: label || null }), []);
    assert.equal(app.state, cases[label], label || '(empty)');
  });
  const testing = { '': 'not_started', 'Sent Email': 'action_needed', 'Pending Review': 'in_progress', 'Stuck': 'in_progress', 'Done': 'complete', 'Odd': 'in_progress' };
  Object.keys(testing).forEach((label) => {
    assert.equal(env.call('toApplicantView', faItem({ id: 1, name: 'X', testing: label || null }), []).testing, testing[label], 'testing ' + label);
  });
});

test('the view holds exactly the contract fields, https-only links and the announcement only when approved', () => {
  const { env } = setup();
  const row = {
    id: 7, name: 'Harbor Swap', institution: 'Fernway Labs', status: '2-Approved', statusChangedAt: '2026-11-03T10:00:00Z',
    type: 'Non-Issuer', submitted: '2026-10-14', lockVerified: '2026-10-18', lockedAmount: 1.5, testing: 'Done',
    partyId: 'harborswap-1::1220abc', website: 'https://harborswap.example', announcement: 'https://lists.example.org/g/tokenomics/message/1'
  };
  const app = JSON.parse(JSON.stringify(env.call('toApplicantView', faItem(row), [])));
  assert.deepEqual(Object.keys(app).sort(), ['announcement', 'dvp', 'institution', 'lock', 'name', 'partyId', 'state', 'submitted', 'testing', 'type', 'updated', 'website']);
  assert.deepEqual(app, {
    name: 'Harbor Swap', institution: 'Fernway Labs', type: 'Non-Issuer', submitted: '2026-10-14', state: 'approved',
    lock: { verified: '2026-10-18', amountMillions: 1.5 }, testing: 'complete', partyId: 'harborswap-1::1220abc',
    website: 'https://harborswap.example', announcement: 'https://lists.example.org/g/tokenomics/message/1', updated: '2026-11-03', dvp: []
  });
  const notApproved = env.call('toApplicantView', faItem(Object.assign({}, row, { status: '5-Revoked', website: 'http://plain.example' })), []);
  assert.equal(notApproved.announcement, null, 'announcement only when approved');
  assert.equal(notApproved.website, null, 'http links are dropped');
  const noLock = env.call('toApplicantView', faItem({ id: 8, name: 'Y', lockedAmount: 0 }), []);
  assert.deepEqual(JSON.parse(JSON.stringify(noLock.lock)), { verified: null, amountMillions: null });
  assert.equal(noLock.updated, null);
});

test('DVP requests: grouped by Connect boards link, newest first, finalApproval only when approved', () => {
  const fa = [faItem({ id: 1, name: 'Harbor Swap', status: '1-Needs Review', statusLink: linkTo(codeOf('Harbor')) })];
  const dvp = [
    dvpItem({ id: 11, name: 'RFQ settlement', status: 'New Submission', submitted: '2026-10-20', finalApproval: '2026-10-21', requestUrl: 'https://lists.example.org/g/accountability/message/147', requestText: '#147 – Harbor', faIds: [1] }),
    dvpItem({ id: 12, name: 'Spot pairs', status: 'Tokenomics Apporval', submitted: '2026-11-01', finalApproval: '2026-11-03', faIds: [1] }),
    dvpItem({ id: 13, name: 'Unlinked', status: 'Denied', submitted: '2026-11-02', faIds: [] })
  ];
  const { env } = setup({ fa, dvp, props: { DVP_LINK_COLUMN_ID: REL_COL } });
  env.call('refresh');
  const res = env.get(codeOf('Harbor')).body;
  assert.equal(res.found, true);
  assert.deepEqual(res.app.dvp.map((d) => d.name), ['Spot pairs', 'RFQ settlement']);
  assert.deepEqual(res.app.dvp[0], { id: '12', name: 'Spot pairs', state: 'approved', submitted: '2026-11-01', finalApproval: '2026-11-03', requestUrl: null, requestRef: null, updated: null });
  assert.equal(res.app.dvp[1].finalApproval, null, 'not approved: no final approval date');
  assert.equal(res.app.dvp[1].requestRef, '147');
  assert.equal(res.app.dvp[1].state, 'in_review');
});

test('without DVP_LINK_COLUMN_ID the DVP board is never read', () => {
  const { env } = setup({ fa: [faItem({ id: 1, name: 'A', statusLink: linkTo(codeOf('A')) })], dvp: [dvpItem({ id: 9, name: 'D', faIds: [1] })] });
  env.call('refresh');
  assert.ok(env.requests.every((r) => String((r.payload.variables || {}).b) !== DVP));
  assert.deepEqual(env.get(codeOf('A')).body.app.dvp, []);
});

// ============================================================ refresh: issuing links

test('refresh writes links into empty cells only, 20 per request, at most 200 per run', () => {
  const existing = codeOf('Existing');
  const dup = codeOf('Duplicate');
  const fa = emptyRows(230).concat([
    faItem({ id: 1, name: 'Has link', statusLink: linkTo(existing) }),
    faItem({ id: 2, name: 'Hand typed', statusLinkRaw: { text: 'see email', value: JSON.stringify({ url: 'https://example.org/page', text: 'see email' }) } }),
    faItem({ id: 3, name: 'Dup A', statusLink: linkTo(dup) }),
    faItem({ id: 4, name: 'Dup B', statusLink: linkTo(dup) })
  ]);
  const { fake, env } = setup({ fa });
  const stats = env.call('refresh');

  assert.equal(stats.linksWritten, 200);
  assert.equal(stats.rowsDeferredByCap, 30);
  assert.equal(stats.unreadableLinks, 1);
  assert.equal(stats.duplicateCodes, 1);
  assert.ok(fake.aliasesPerMutation.every((n) => n <= 20), 'batches of at most 20');
  assert.equal(fake.aliasesPerMutation.reduce((a, b) => a + b, 0), 200);

  // Link format and the untouched cells.
  const written = fa.slice(0, 230).map((row) => fake.cell(row.id, LINK_COL)).filter((c) => c.value);
  assert.equal(written.length, 200);
  const sample = JSON.parse(written[0].value);
  assert.equal(sample.text, 'Status link');
  assert.match(sample.url, /^https:\/\/status\.example\.org\/#[A-Za-z0-9_-]{22}$/);
  assert.equal(JSON.parse(fake.cell(2, LINK_COL).value).url, 'https://example.org/page', 'hand-typed cell never overwritten');
  assert.equal(writtenCode(fake, 1), existing, 'existing link kept');

  // Serving: existing link yes, duplicates no, freshly written yes.
  assert.equal(env.get(existing).body.found, true);
  assert.deepEqual(env.get(dup).body, { found: false });
  assert.equal(env.get(writtenCode(fake, written.length && fa[0].id) || existing).body.found, true);

  // The next run writes the 30 that were deferred.
  const second = env.call('refresh');
  assert.equal(second.linksWritten, 30);
  assert.equal(second.rowsDeferredByCap, 0);
  assert.equal(env.call('refresh').linksPlanned, 0, 'nothing left to write');
});

test('a failed write leaves only that row unserved; a cleared cell gets a new code and the old link dies', () => {
  const fa = emptyRows(3);
  const { fake, env } = setup({ fa });
  fake.failItems.add('1001');
  const stats = env.call('refresh');
  assert.equal(stats.linksWritten, 2);
  assert.equal(stats.linkWriteFailures, 1);
  assert.equal(stats.errorCodes.InvalidItemIdException, 1);
  assert.equal(writtenCode(fake, 1001), null);
  assert.equal(stats.served, 2);

  // Clear a link the way the team would, then refresh.
  const old = writtenCode(fake, 1000);
  fake.cell(1000, LINK_COL).value = null;
  fake.cell(1000, LINK_COL).text = '';
  fake.failItems.clear();
  env.call('refresh');
  const fresh = writtenCode(fake, 1000);
  assert.notEqual(fresh, old);
  assert.deepEqual(env.get(old).body, { found: false });
  assert.equal(env.get(fresh).body.found, true);
});

test('rate limiting stops the writes for this run without serving unsaved codes', () => {
  const { fake, env } = setup({ fa: emptyRows(45) });
  fake.failMutationsWith = { code: 429, body: JSON.stringify({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED' } }] }), headers: { 'Retry-After': '2' } };
  const stats = env.call('refresh');
  assert.equal(stats.rateLimited, true);
  assert.equal(stats.linksWritten, 0);
  assert.equal(stats.served, 0);
  assert.equal(fake.mutations, 3, 'one request, retried twice, then no further batches');
  assert.deepEqual(env.sleeps, [2000, 2000]);
});

// ============================================================ refresh: the automatic email

function emailSetup(rows, opts) {
  return setup(Object.assign({ fa: rows, label: true, props: { SEND_LINK_EMAIL: 'true', EMAIL_NEW_ROWS_FROM: '2026-12-01' } }, opts || {}));
}
const sendEmailOf = (fake, id) => (fake.cell(id, 'color_mm6eay19') || {}).text || null;

test('email label is set only on new rows, never twice, and not on old rows', () => {
  const rows = [
    faItem({ id: 1, name: 'New', created_at: '2026-12-02T09:00:00Z' }),
    faItem({ id: 2, name: 'Old', created_at: '2026-11-20T09:00:00Z' }),
    faItem({ id: 3, name: 'Already', created_at: '2026-12-03T09:00:00Z', sendEmail: 'Status link' }),
    faItem({ id: 4, name: 'Other email sent', created_at: '2026-12-03T09:00:00Z', sendEmail: 'FA Type Email' })
  ];
  const { fake, env } = emailSetup(rows);
  const stats = env.call('refresh');
  assert.equal(stats.linksWritten, 4);
  assert.equal(stats.emailLabelsSet, 2);
  assert.equal(stats.emailSkippedAlreadyLabelled, 1);
  assert.equal(sendEmailOf(fake, 1), 'Status link');
  assert.equal(sendEmailOf(fake, 2), null, 'created before EMAIL_NEW_ROWS_FROM');
  assert.equal(sendEmailOf(fake, 4), 'Status link');
});

test('email is off unless SEND_LINK_EMAIL is exactly "true"', () => {
  const { fake, env } = setup({ fa: [faItem({ id: 1, name: 'New', created_at: '2026-12-02T09:00:00Z' })], label: true, props: { SEND_LINK_EMAIL: 'yes', EMAIL_NEW_ROWS_FROM: '2026-12-01' } });
  env.call('refresh');
  assert.equal(sendEmailOf(fake, 1), null);
});

test('the brake: more than 20 qualifying rows get links but no email label', () => {
  const { fake, env } = emailSetup(emptyRows(21, { created_at: '2026-12-02T09:00:00Z' }));
  const stats = env.call('refresh');
  assert.equal(stats.linksWritten, 21);
  assert.equal(stats.emailBrakeTripped, true);
  assert.equal(stats.emailLabelsSet, 0);
  assert.ok(emptyRows(21).every((row) => sendEmailOf(fake, row.id) === null));
});

test('no "Status link" label: links are written without it (labels are never created)', () => {
  const { fake, env } = emailSetup([faItem({ id: 1, name: 'New', created_at: '2026-12-02T09:00:00Z' })], { label: false });
  const stats = env.call('refresh');
  assert.equal(stats.linksWritten, 1);
  assert.equal(stats.errorCodes.status_link_label_missing, 1);
  assert.equal(sendEmailOf(fake, 1), null);
  assert.ok(env.requests.every((r) => !/create_labels_if_missing/.test(r.payload.query)));
});

test('label missing at write time: the link is retried on its own', () => {
  const { fake, env } = emailSetup([faItem({ id: 1, name: 'New', created_at: '2026-12-02T09:00:00Z' })]);
  fake.writeRejectsLabel = true;
  const stats = env.call('refresh');
  assert.equal(stats.linksWritten, 1);
  assert.equal(stats.emailLabelsSet, 0);
  assert.equal(stats.errorCodes.missingLabel, 1);
  assert.match(writtenCode(fake, 1), CODE_RE);
});

// ============================================================ privacy

test('privacy: only allow-listed columns are requested, and nothing forbidden reaches the cache, answers or logs', () => {
  const fa = [
    faItem({ id: 1, name: 'Harbor Swap', status: '2-Approved', institution: 'Fernway Labs', sendEmail: 'FA Type Email' }),
    faItem({ id: 2, name: 'Quillpoint Vault', status: '4-No', statusLink: linkTo(codeOf('Quill')) })
  ];
  const dvp = [dvpItem({ id: 11, name: 'RFQ settlement', status: 'FAAC Approval', faIds: [1] })];
  const { fake, env } = setup({ fa, dvp, props: { DVP_LINK_COLUMN_ID: REL_COL } });
  fake.failItems.add('999'); // no effect, keeps the fake's error path warm
  env.call('refresh');

  const requested = Array.from(fake.requestedColumnIds);
  requested.forEach((id) => assert.ok(ALLOWED_FA_COLUMNS.concat(ALLOWED_DVP_COLUMNS).includes(id), 'requested a forbidden column: ' + id));
  Object.keys(SENTINELS).forEach((id) => assert.ok(!requested.includes(id)));

  const code1 = writtenCode(fake, 1);
  const answers = [env.get(code1).body, env.get(codeOf('Quill')).body];
  const everything = env.cache.raw() + JSON.stringify(answers);
  Object.values(SENTINELS).concat(['SENTINEL']).forEach((s) => assert.ok(!everything.includes(s), 'leaked ' + s));
  assert.ok(!everything.includes('FA Type Email'), 'Send Email never leaves the script');

  const logs = env.logText();
  [code1, codeOf('Quill'), 'Harbor Swap', 'Quillpoint', 'https://', 'test-token-xyz', 'SENTINEL'].forEach((s) => assert.ok(!logs.includes(s), 'log contains ' + s));
});

test('privacy: Monday error messages (which echo values) never reach the logs', () => {
  const { fake, env } = emailSetup([faItem({ id: 1, name: 'New', created_at: '2026-12-02T09:00:00Z' })]);
  fake.writeRejectsLabel = true; // the fake's error message quotes the written values, link included
  env.call('refresh');
  const logs = env.logText();
  assert.ok(!logs.includes("doesn't exist"));
  assert.ok(!logs.includes('status.example.org'));
});

// ============================================================ cache

test('cache: all 64 shards in one putAll with a 6-hour expiry', () => {
  const { env } = setup({ fa: emptyRows(5) });
  env.call('refresh');
  const keys = env.cache.keys().filter((k) => k.startsWith('fa1:'));
  assert.equal(keys.length, 64);
  assert.equal(env.putAllCalls, 1);
  keys.forEach((k) => assert.equal(env.cache.ttlOf(k), 21600));
  const shards = env.cache.dump();
  assert.equal(Object.values(shards).reduce((n, shard) => n + Object.keys(shard).length, 0), 5);
});

// ============================================================ doGet

test('doGet: bad format, hit, miss in a present shard, and JSON output', () => {
  const { env } = setup({ fa: [faItem({ id: 1, name: 'Harbor Swap', statusLink: linkTo(codeOf('Harbor')) })] });
  env.call('refresh');
  const before = env.requests.length;

  ['', 'short', codeOf('Harbor') + 'x', '../../etc/passwd', '<script>alert(1)</script>'].forEach((bad) => {
    assert.deepEqual(env.get(bad).body, { found: false }, JSON.stringify(bad));
  });
  assert.deepEqual(JSON.parse(env.call('doGet').getContent()), { found: false }, 'no event at all');

  const hit = env.get(codeOf('Harbor'));
  assert.equal(hit.mimeType, 'application/json');
  assert.equal(hit.body.found, true);
  assert.equal(hit.body.app.name, 'Harbor Swap');
  assert.deepEqual(env.get(codeOf('Hzzzz')).body, { found: false }, 'same shard, unknown code');
  assert.equal(env.requests.length, before, 'answers come from the cache without calling Monday');
});

test('doGet on an evicted cache rebuilds read-only (no writes) and answers', () => {
  const { fake, env } = setup({ fa: [faItem({ id: 1, name: 'Harbor Swap', statusLink: linkTo(codeOf('Harbor')) })].concat(emptyRows(2)) });
  env.call('refresh');
  env.cache.clear();
  const mutationsBefore = fake.mutations;
  // Clear one written link to prove the rebuild doesn't issue codes.
  fake.cell(1000, LINK_COL).value = null;
  fake.cell(1000, LINK_COL).text = '';
  const res = env.get(codeOf('Harbor')).body;
  assert.equal(res.found, true);
  assert.equal(fake.mutations, mutationsBefore, 'no mutation during a page view');
  assert.equal(writtenCode(fake, 1000), null);
  assert.equal(env.lockAcquisitions, env.lockReleases, 'lock released');
});

test('doGet on a miss without the lock, or with broken config, answers unavailable and nothing else', () => {
  const { env } = setup({ fa: [faItem({ id: 1, name: 'A', statusLink: linkTo(codeOf('A')) })] });
  env.lockAvailable = false;
  assert.deepEqual(env.get(codeOf('A')).body, { error: 'unavailable' });

  const broken = setup({ props: { MONDAY_API_TOKEN: '' } }).env;
  assert.deepEqual(broken.get(codeOf('A')).body, { error: 'unavailable' });

  const failing = createGasEnv({ props: BASE_PROPS, fetch: () => { throw new Error('boom with secret detail'); } });
  const out = failing.get(codeOf('A')).body;
  assert.deepEqual(out, { error: 'unavailable' });
  assert.ok(!failing.logText().includes('secret detail'));
});

// ============================================================ refresh guards and setup

test('refresh does nothing when another run holds the lock, or when properties are missing', () => {
  const busy = setup({ fa: emptyRows(2) });
  busy.env.lockAvailable = false;
  assert.equal(busy.env.call('refresh'), undefined);
  assert.equal(busy.env.requests.length, 0);

  const bad = setup({ fa: emptyRows(2), props: { SITE_URL: 'http://insecure.example' } });
  assert.equal(bad.env.call('refresh'), undefined);
  assert.equal(bad.env.requests.length, 0);
  assert.match(bad.env.logText(), /SITE_URL must be an https/);
  assert.ok(!bad.env.logText().includes('insecure.example'), 'values are never logged');
});

test('SITE_URL gets a trailing slash, so links are always SITE_URL/#code', () => {
  const { fake, env } = setup({ fa: emptyRows(1), props: { SITE_URL: 'https://org.github.io/fa-status' } });
  env.call('refresh');
  assert.match(JSON.parse(fake.cell(1000, LINK_COL).value).url, /^https:\/\/org\.github\.io\/fa-status\/#[A-Za-z0-9_-]{22}$/);
});

test('setup: names the missing properties, then creates the trigger once and runs refresh', () => {
  const empty = createGasEnv({ props: {} });
  assert.throws(() => empty.call('setup'), (err) => /MONDAY_API_TOKEN/.test(err.message) && /STATUS_LINK_COLUMN_ID/.test(err.message) && /SITE_URL/.test(err.message));

  const emailOn = setup({ fa: emptyRows(1), props: { SEND_LINK_EMAIL: 'true' } });
  assert.throws(() => emailOn.env.call('setup'), /EMAIL_NEW_ROWS_FROM/);

  const { env } = setup({ fa: emptyRows(2) });
  const stats = env.call('setup');
  env.call('setup');
  assert.equal(env.triggers.length, 1);
  assert.deepEqual(env.triggers[0], { handler: 'refresh', minutes: 10 });
  assert.equal(stats.linksWritten, 2);
});

test('setup refuses a Status link column that is not a Link column', () => {
  const { env } = setup({ fa: emptyRows(1), props: { STATUS_LINK_COLUMN_ID: 'text_somethingelse' } });
  assert.throws(() => env.call('setup'), /not a Link column|does not name a column/);
});
