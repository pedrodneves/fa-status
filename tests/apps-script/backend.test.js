'use strict';
/**
 * Backend tests: apps-script/Code.gs in Node, with mocked Google services
 * (tests/support/gas-env.js) and a fake Monday (tests/support/fake-monday.js).
 * Synthetic data only. Run with `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGasEnv } = require('../support/gas-env');
const { createFakeMonday, faItem, dvpItem, label, FA, DVP, SENTINELS } = require('../support/fake-monday');

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const PROPS = { MONDAY_API_TOKEN: 'test-token-xyz', SITE_URL: 'https://status.example.org', LINK_SECRET: SECRET };

const ALLOWED_FA = ['text_mm4k2vch', 'color_mm4kmej3', 'color_mm4kpp3q', 'date_mm4kw11a', 'date_mm4kpckv',
  'numeric_mm4k6919', 'color_mm6be9ge', 'long_text_mm4kq322', 'link_mm4kmq24', 'link_mm6hfp5g', 'color_mm6eay19', 'color_mm8z4ket', 'color_mm8a49an'];
const EMAIL_COLUMNS = ['email_mm4ke170', 'text_mm4kvrar'];
const ALLOWED_DVP = ['date_mm8dsx4y', 'date_mm8dm7a0', 'link_mm8rp25j', 'color_mm8dhgvr'];
const APP_KEYS = ['id', 'name', 'institution', 'type', 'faType', 'dvpStatus', 'submitted', 'state', 'lock', 'testing', 'partyId',
  'website', 'announcement', 'update', 'updated', 'dvp', 'history'];
const DVP_KEYS = ['id', 'name', 'state', 'submitted', 'finalApproval', 'requestUrl', 'requestRef', 'updated'];

/** Seven FA rows and four DVP requests covering the interesting cases. */
function fixture() {
  return {
    fa: [
      faItem({
        id: 101, name: 'Harbor Swap', institution: 'Harbor Labs', email: 'Alice@Harbor.example',
        responsible: 'bob@harbor.example; Carol <carol@harbor.example>', status: '1b-FAAC Approved-waiting on tokenomics',
        statusChangedAt: '2026-10-20T10:00:00Z', type: 'Non-Issuer', submitted: '2026-09-01', lockVerified: '2026-09-10',
        lockedAmount: 1.5, testing: 'Done', partyId: 'harbor::1220abcd', website: 'https://harbor.example',
        announcement: 'https://lists.example/announce/1', sendEmail: 'Office Hour Request', sendEmailChangedAt: '2026-11-12T09:30:00Z',
        faType: 'Basic Featured App', dvpStatus: 'FAAC Approved'
      }),
      faItem({
        id: 102, name: 'Harbor Vault', institution: 'Harbor Labs', email: 'alice@harbor.example', status: '2-Approved',
        submitted: '2026-10-01', announcement: 'https://lists.example/vault', website: 'javascript:alert(1)'
      }),
      faItem({ id: 103, name: 'Orbit Ledger', institution: 'Orbit Inc', email: 'dev@orbit.example', status: '4-No', submitted: '2026-08-01', sendEmail: 'Working on it' }),
      faItem({ id: 104, name: 'No Contact App', institution: 'Ghost Co', status: '1-Needs Review' }),
      faItem({ id: 105, name: 'Lumen Wallet', institution: 'Lumen Labs', responsible: 'ops@lumen.example and cto@lumen.example', status: '2-Approved' }),
      faItem({ id: 106, name: 'Lumen Pay', institution: 'Lumen Labs', email: 'ops@lumen.example', status: 'Some New Label' }),
      faItem({ id: 107, name: 'Quillpoint Vaults', institution: 'Quillpoint', email: 'hi@quillpoint.example', status: '1-Needs Review' })
    ],
    dvp: [
      dvpItem({ id: 9001, name: 'Orbit Ledger', status: 'Denied', submitted: '2026-08-23', finalApproval: '2026-11-03', requestUrl: 'https://lists.sync.global/g/accountability/message/116', requestText: '#116 – Orbit Ledger' }),
      dvpItem({ id: 9002, name: 'Lumen Wallet / Lumen Pay (Lumen Labs)', status: 'Tokenomics Apporval', submitted: '2026-08-24', finalApproval: '2026-11-03', requestUrl: 'https://lists.sync.global/g/accountability/message/120' }),
      dvpItem({ id: 9003, name: 'Harbor Swap (Aug request)', status: 'FAAC Approval', submitted: '2026-08-20' }),
      dvpItem({ id: 9004, name: 'Quillpoint', status: 'New Submission', submitted: '2026-08-21' })
    ]
  };
}

const ADDRESSES = ['alice@harbor.example', 'bob@harbor.example', 'carol@harbor.example', 'dev@orbit.example',
  'ops@lumen.example', 'cto@lumen.example', 'hi@quillpoint.example'];

function setupEnv(data, props) {
  const monday = createFakeMonday(data || fixture());
  const env = createGasEnv({ props: Object.assign({}, PROPS, props || {}), fetch: monday.handle });
  return { env, monday };
}

/** Refreshes, then returns the apps an address sees (or null when not found). */
function appsOf(env, email) {
  const { body } = env.get(env.tokenFor(email));
  return body.found ? body.apps : null;
}

function shardKeys(env) {
  return env.cache.keys().filter((key) => /^fa2:\d+$/.test(key));
}

// ---------------------------------------------------------------------------
// Tokens and addresses
// ---------------------------------------------------------------------------

test('tokens: 22 base64url characters, an HMAC of the address, different per address and per secret', () => {
  const { env } = setupEnv();
  const token = env.call('tokenFor_', SECRET, 'alice@harbor.example');
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  const expected = crypto.createHmac('sha256', SECRET).update('alice@harbor.example').digest('base64url').slice(0, 22);
  assert.equal(token, expected);
  assert.equal(env.call('tokenFor_', SECRET, 'alice@harbor.example'), token, 'stable');
  assert.notEqual(env.call('tokenFor_', SECRET, 'bob@harbor.example'), token);
  assert.notEqual(env.call('tokenFor_', SECRET + 'x', 'alice@harbor.example'), token);
});

test('normaliseEmail_ trims and lower-cases, and rejects anything that is not one address', () => {
  const { env } = setupEnv();
  assert.equal(env.call('normaliseEmail_', '  Alice@Harbor.Example '), 'alice@harbor.example');
  ['', 'nope', 'a@b', 'a b@c.com', 'a@b.com, c@d.com', 'mailto:a@b.com', 'x'.repeat(250) + '@a.com', null, 42]
    .forEach((bad) => assert.equal(env.call('normaliseEmail_', bad), '', String(bad)));
});

test('emailsOfRow_ reads the Email column and every address in "Emails for Responsible Persons"', () => {
  const { env } = setupEnv();
  const rows = fixture().fa;
  assert.deepEqual(Array.from(env.call('emailsOfRow_', rows[0])), ['alice@harbor.example', 'bob@harbor.example', 'carol@harbor.example']);
  assert.deepEqual(Array.from(env.call('emailsOfRow_', rows[4])), ['ops@lumen.example', 'cto@lumen.example']);
  assert.deepEqual(Array.from(env.call('emailsOfRow_', rows[3])), []);
  const same = faItem({ id: 1, name: 'x', email: 'a@x.example', responsible: 'A@X.example, a@x.example' });
  assert.deepEqual(Array.from(env.call('emailsOfRow_', same)), ['a@x.example'], 'no duplicates');
  const many = faItem({ id: 2, name: 'y', responsible: Array.from({ length: 15 }, (_, i) => 'p' + i + '@y.example').join(' ') });
  assert.equal(env.call('emailsOfRow_', many).length, 10, 'capped');
});

// ---------------------------------------------------------------------------
// Labels and DVP matching
// ---------------------------------------------------------------------------

test('board labels map to state keys; unknown labels fall back and are counted', () => {
  const { env } = setupEnv();
  const fa = {
    '0-Locked+Needs Review': 'in_review', '1-Needs Review': 'in_review', '1b-FAAC Approved-waiting on tokenomics': 'with_tokenomics',
    '2-Approved': 'approved', '2b-Provisional': 'provisional', '3-CIP-0116-paused': 'on_hold', '4-No': 'not_approved', '5-Revoked': 'revoked',
    '6-Withdrawn': 'withdrawn', '7-Closed-new-process': 'closed_process'
  };
  Object.keys(fa).forEach((label) => assert.equal(env.call('faState_', label), fa[label], label));
  assert.equal(env.call('faState_', null), 'received');
  const stats = env.call('newStats_', 'test');
  assert.equal(env.call('faState_', 'Brand New', stats), 'in_review');
  assert.equal(stats.unknownLabels.fa['Brand New'], 1);
  assert.equal(env.call('faState_', 'toString', stats), 'in_review', 'no prototype lookups');

  assert.equal(env.call('testingState_', 'Sent Email'), 'action_needed');
  assert.equal(env.call('testingState_', 'Done'), 'complete');
  assert.equal(env.call('testingState_', null), 'not_started');

  assert.equal(env.call('dvpState_', 'Tokenomics Apporval'), 'approved');
  assert.equal(env.call('dvpState_', 'Tokenomics Approval'), 'approved');
  assert.equal(env.call('dvpState_', 'FAAC Approval'), 'with_tokenomics');
  assert.equal(env.call('dvpState_', 'Denied'), 'not_approved');
  assert.equal(env.call('dvpState_', 'Closed'), 'closed');
  assert.equal(env.call('dvpState_', 'New Submission'), 'in_review');
});

test('Send Email labels become the latest committee email; labels that send nothing show nothing', () => {
  const { env } = setupEnv();
  const update = (label, changedAt, stats) => {
    const column = { id: 'color_mm6eay19', type: 'status', text: label, value: label ? JSON.stringify({ index: 1, changed_at: changedAt || null }) : null };
    const out = env.call('emailUpdate_', column, stats);
    return out ? JSON.parse(JSON.stringify(out)) : out;
  };
  assert.deepEqual(update('Office Hour Request', '2026-11-16T15:40:00Z'), { kind: 'office_hours', date: '2026-11-16' });
  assert.deepEqual(update('Endorsements'), { kind: 'endorsements', date: null });
  assert.equal(update('FA Type Email').kind, 'fa_type_info');
  assert.equal(update('Locking Check').kind, 'locking_check');
  assert.equal(update('Updated Process').kind, 'resubmit');
  assert.equal(update('Decline').kind, 'declined');
  ['Working on it', 'Done', 'Stuck', '', null].forEach((label) => assert.equal(update(label), null, String(label)));
  const stats = env.call('newStats_', 'test');
  assert.equal(update('Brand New Email', null, stats), null);
  assert.equal(stats.unknownLabels.email['Brand New Email'], 1);

  env.call('refresh');
  assert.equal(appsOf(env, 'dev@orbit.example')[0].update, null, '"Working on it" sends no email');
});

test('DVP Status on the FA board maps to a key; empty and unknown labels give null', () => {
  const { env } = setupEnv();
  const status = (label, stats) => env.call('dvpStatusOf_', { id: 'color_mm8a49an', type: 'status', text: label, value: null }, stats);
  assert.equal(status('Needs Review'), 'in_review');
  assert.equal(status('FAAC Approved'), 'faac_approved');
  assert.equal(status('Declined'), 'declined');
  assert.equal(status(null), null);
  const stats = env.call('newStats_', 'test');
  assert.equal(status('Something Else', stats), null);
  assert.equal(stats.unknownLabels.dvpStatus['Something Else'], 1);
});

test('DVP name keys: cut at the first qualifier, split on "/", exact matches only', () => {
  const { env } = setupEnv();
  const keys = (name) => Array.from(env.call('dvpNameKeys_', name));
  assert.deepEqual(keys('Tidewater DEX (Tidewater Labs)'), ['tidewater dex']);
  assert.deepEqual(keys('Lumen Wallet / Lumen Pay (Lumen Labs)'), ['lumen wallet', 'lumen pay']);
  assert.deepEqual(keys('Fernway – FW Wallet + RFQ DEX / Harbor'), ['fernway']);
  assert.deepEqual(keys('Copperleaf (Oct request – multi-collateral)'), ['copperleaf']);
  assert.deepEqual(keys('  Orbit   Exchange  (Orbit-Ventures-1)'), ['orbit exchange']);
  assert.equal(env.call('baseNameKey_', 'Copperleaf Markets - Copperleaf Labs LLC'), 'copperleaf markets');
  assert.equal(env.call('baseNameKey_', 'Harbor Swap (copy)'), 'harbor swap');
  assert.equal(env.call('nameKey_', 'The  Vault'), 'the vault');
});

test('refresh attaches DVP requests to the FA apps with the same name', () => {
  const { env } = setupEnv();
  const stats = env.call('refresh');
  assert.equal(stats.dvpMatched, 3);
  assert.equal(stats.dvpUnmatched, 1, '"Quillpoint" does not match "Quillpoint Vaults"');

  const harbor = appsOf(env, 'bob@harbor.example')[0];
  assert.deepEqual(harbor.dvp.map((d) => d.id), ['9003']);
  const orbit = appsOf(env, 'dev@orbit.example')[0];
  assert.deepEqual(orbit.dvp.map((d) => d.id), ['9001']);
  const lumen = appsOf(env, 'ops@lumen.example');
  assert.deepEqual(lumen.map((a) => [a.name, a.dvp.map((d) => d.id)]), [['Lumen Pay', ['9002']], ['Lumen Wallet', ['9002']]]);
  assert.deepEqual(appsOf(env, 'hi@quillpoint.example')[0].dvp, []);
});

// ---------------------------------------------------------------------------
// refresh, the cache and the answer
// ---------------------------------------------------------------------------

test('refresh: each address sees exactly the applications that list it, newest first', () => {
  const { env } = setupEnv();
  const stats = env.call('refresh');
  assert.equal(stats.faRows, 7);
  assert.equal(stats.dvpRows, 4);
  assert.equal(stats.appsServed, 6);
  assert.equal(stats.appsWithoutEmail, 1);
  assert.equal(stats.addresses, ADDRESSES.length);

  assert.deepEqual(appsOf(env, 'alice@harbor.example').map((a) => a.name), ['Harbor Vault', 'Harbor Swap']);
  assert.deepEqual(appsOf(env, 'ALICE@harbor.example ').map((a) => a.name), ['Harbor Vault', 'Harbor Swap'], 'case and spaces ignored');
  assert.deepEqual(appsOf(env, 'bob@harbor.example').map((a) => a.name), ['Harbor Swap']);
  assert.deepEqual(appsOf(env, 'carol@harbor.example').map((a) => a.name), ['Harbor Swap']);
  assert.deepEqual(appsOf(env, 'cto@lumen.example').map((a) => a.name), ['Lumen Wallet']);
  assert.equal(appsOf(env, 'stranger@nowhere.example'), null);
  ADDRESSES.forEach((email) => assert.ok(!appsOf(env, email).some((a) => a.name === 'No Contact App')));
});

test('the answer holds only allow-listed fields, links are https-only, approval-only fields stay hidden', () => {
  const { env } = setupEnv();
  env.call('refresh');
  const [vault, swap] = appsOf(env, 'alice@harbor.example');
  [vault, swap].forEach((app) => assert.deepEqual(Object.keys(app), APP_KEYS));

  assert.deepEqual(swap, {
    id: '101', name: 'Harbor Swap', institution: 'Harbor Labs', type: 'Non-Issuer', faType: 'Basic Featured App', dvpStatus: 'faac_approved', submitted: '2026-09-01',
    state: 'with_tokenomics', lock: { verified: '2026-09-10', amountMillions: 1.5, confirmed: false }, testing: 'complete',
    partyId: 'harbor::1220abcd', website: 'https://harbor.example', announcement: null,
    update: { kind: 'office_hours', date: '2026-11-12' }, updated: '2026-10-20',
    dvp: [{ id: '9003', name: 'Harbor Swap (Aug request)', state: 'with_tokenomics', submitted: '2026-08-20', finalApproval: null, requestUrl: null, requestRef: null, updated: null }],
    history: []
  });
  assert.equal(vault.state, 'approved');
  assert.equal(vault.announcement, 'https://lists.example/vault');
  assert.equal(vault.website, null, 'javascript: URL dropped');

  const orbit = appsOf(env, 'dev@orbit.example')[0];
  assert.deepEqual(Object.keys(orbit.dvp[0]), DVP_KEYS);
  assert.equal(orbit.dvp[0].state, 'not_approved');
  assert.equal(orbit.dvp[0].finalApproval, null, 'final approval date only when approved');
  assert.equal(orbit.dvp[0].requestRef, '116');
  const wallet = appsOf(env, 'cto@lumen.example')[0];
  assert.equal(wallet.dvp[0].finalApproval, '2026-11-03');
});

test('privacy: forbidden columns are never requested; addresses and sentinels appear nowhere', () => {
  const { env, monday } = setupEnv();
  env.call('refresh');
  const allowed = new Set(ALLOWED_FA.concat(EMAIL_COLUMNS, ALLOWED_DVP));
  monday.requestedColumnIds.forEach((id) => assert.ok(allowed.has(id), 'requested ' + id));

  const answers = ADDRESSES.map((email) => JSON.stringify(env.get(env.tokenFor(email)).body)).join('\n');
  const everything = [env.cache.raw(), answers, env.logText()].join('\n').toLowerCase();
  ADDRESSES.forEach((email) => assert.ok(everything.indexOf(email) === -1, email + ' leaked'));
  assert.ok(everything.indexOf('@') === -1, 'no address-like text anywhere');
  Object.values(SENTINELS).concat(['SENTINEL-DVP-ANSWER']).forEach((s) => assert.ok(everything.indexOf(s.toLowerCase()) === -1, s));

  const logs = env.logText();
  ADDRESSES.forEach((email) => assert.ok(logs.indexOf(env.tokenFor(email)) === -1, 'token in log'));
  ['Harbor Swap', 'Orbit Inc', 'harbor.example'].forEach((s) => assert.ok(logs.indexOf(s) === -1, s + ' in log'));
  assert.ok(logs.indexOf(PROPS.MONDAY_API_TOKEN) === -1);
});

test('nothing is ever written to Monday', () => {
  const { env, monday } = setupEnv(fixture(), { LINK_SECRET: '' });
  env.call('setup');
  env.call('refresh');
  env.get(env.tokenFor('alice@harbor.example'));
  env.post({ email: 'alice@harbor.example' });
  env.cache.clear();
  env.get(env.tokenFor('bob@harbor.example'));
  assert.equal(monday.mutations, 0);
  assert.ok(monday.queries > 0);
  env.requests.forEach((r) => assert.match(r.payload.query, /^query /));
  env.requests.forEach((r) => assert.equal(r.options.headers['API-Version'], '2026-10'));
});

test('the cache: 64 shards in one putAll, 6-hour expiry, removed addresses lose access on the next run', () => {
  const data = fixture();
  const { env, monday } = setupEnv(data);
  env.call('refresh');
  assert.equal(shardKeys(env).length, 64);
  assert.equal(env.putAllCalls, 1);
  shardKeys(env).forEach((key) => assert.equal(env.cache.ttlOf(key), 21600));
  assert.ok(appsOf(env, 'bob@harbor.example'));

  // Bob is taken off the row on Monday.
  monday.boards[FA].items[0] = faItem({ id: 101, name: 'Harbor Swap', email: 'alice@harbor.example', status: '1-Needs Review' });
  env.call('refresh');
  assert.equal(appsOf(env, 'bob@harbor.example'), null);
  assert.equal(appsOf(env, 'alice@harbor.example').length, 2);
});

test('reads every page of a large board', () => {
  const fa = Array.from({ length: 1203 }, (_, i) => faItem({ id: 5000 + i, name: 'App ' + i, email: 'u' + i + '@many.example', status: '2-Approved' }));
  const { env } = setupEnv({ fa: fa, dvp: [] });
  const stats = env.call('refresh');
  assert.equal(stats.faRows, 1203);
  assert.equal(env.requests.filter((r) => /next_items_page/.test(r.payload.query)).length, 2);
  assert.equal(appsOf(env, 'u1202@many.example')[0].name, 'App 1202');
});

// ---------------------------------------------------------------------------
// The public list (GET ?view=featured)
// ---------------------------------------------------------------------------

const PID_A = 'harborvault-1::1220' + 'a'.repeat(64);
const PID_B = 'lumen_wallet::1220' + '0123456789abcdef'.repeat(4);
const PID_C = 'lumen-ops::1220' + 'f'.repeat(64);
const PID_D = 'copper-bridge::1220' + '9'.repeat(64);
const PUBLIC_KEYS = ['name', 'type', 'status', 'since', 'sinceExact', 'partyIds', 'record'];

/** The fixture with Party IDs, FA Types, a provisional and a revoked app, for the public list. */
function publicFixture() {
  const data = fixture();
  data.fa[1] = faItem({
    id: 102, name: 'Harbor Vault', institution: 'Harbor Labs', email: 'alice@harbor.example', status: '2-Approved',
    statusChangedAt: '2026-11-13T15:00:00Z', faType: 'Featured Asset-Moving App', partyId: '  ' + PID_A + '\n',
    submitted: '2026-10-01', announcement: 'https://lists.example/vault', website: 'javascript:alert(1)'
  });
  data.fa[4] = faItem({
    id: 105, name: 'Lumen Wallet', institution: 'Lumen Labs', responsible: 'ops@lumen.example and cto@lumen.example',
    status: '2-Approved', createdAt: '2026-07-07T09:12:00Z', partyId: PID_B + ', ' + PID_C + ', ' + PID_B,
    announcement: 'http://insecure.example/announce'
  });
  data.fa.push(faItem({
    id: 108, name: 'Tidepool DEX', institution: 'Larkspur Labs', email: 'team@tidepool.example', status: '2b-Provisional',
    statusChangedAt: '2026-11-14T16:40:00Z', faType: 'Basic Featured App', partyId: 'see our docs', announcement: 'https://lists.example/tidepool'
  }));
  data.fa.push(faItem({
    id: 110, name: 'Copper Bridge', institution: 'Copperfield Labs', email: 'team@copper.example', status: '5-Revoked',
    statusChangedAt: '2026-11-18T10:00:00Z', faType: 'Featured Asset', partyId: PID_D, announcement: 'https://lists.example/copper'
  }));
  return data;
}

test('partyIdsOf_ finds well-formed Canton party IDs only, in order, without repeats', () => {
  const { env } = setupEnv();
  const ids = (text) => Array.from(env.call('partyIdsOf_', text));
  assert.deepEqual(ids(PID_A), [PID_A]);
  assert.deepEqual(ids(' ' + PID_B + ',\n' + PID_C + '; ' + PID_B + ' '), [PID_B, PID_C]);
  assert.deepEqual(ids('a::b::1220' + 'c'.repeat(64)), ['b::1220' + 'c'.repeat(64)], 'a hint never contains "::"');
  assert.deepEqual(ids('x:y::1220' + 'c'.repeat(64)), ['x:y::1220' + 'c'.repeat(64)], 'a single ":" is fine');
  const glued = 'dead-beef::1220' + 'c'.repeat(64);
  assert.deepEqual(ids(PID_A + glued), [PID_A, glued], 'two IDs typed with no separator');
  assert.deepEqual(ids('Mod-Vault ::1220' + 'd'.repeat(64)), [], 'a space before "::" is not an ID');
  assert.deepEqual(ids('x::1220' + 'e'.repeat(63)), [], 'too short');
  assert.deepEqual(ids('x::1220' + 'e'.repeat(65)), [], 'too long');
  assert.deepEqual(ids('x::1220' + 'e'.repeat(65) + ' y::1220' + 'f'.repeat(64)), ['y::1220' + 'f'.repeat(64)], 'a bad one is skipped, the next kept');
  assert.deepEqual(ids('x::1220' + 'E'.repeat(64)), [], 'upper-case hex is not how Canton prints it');
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids(null), []);
  const six = Array.from({ length: 6 }, (_, i) => 'p' + i + '::1220' + String(i).repeat(64)).join(' ');
  assert.equal(ids(six).length, 5, 'capped');
});

test('"2b-Provisional" (if the committee adds it) is provisional, and its announcement is sent', () => {
  const { env } = setupEnv(publicFixture());
  assert.equal(env.call('faState_', '2b-Provisional'), 'provisional');
  env.call('refresh');
  const tidepool = appsOf(env, 'team@tidepool.example')[0];
  assert.equal(tidepool.state, 'provisional');
  assert.equal(tidepool.announcement, 'https://lists.example/tidepool');
  assert.equal(appsOf(env, 'team@copper.example')[0].announcement, 'https://lists.example/copper', 'revoked: on the public list, so its announcement too');
  assert.equal(appsOf(env, 'dev@orbit.example')[0].announcement, null, 'not approved: no announcement');
});

test('public list: apps with Featured App status, newest first, then revoked ones, with only the public fields', () => {
  const { env } = setupEnv(publicFixture());
  const stats = env.call('refresh');
  assert.equal(stats.featured, 3);
  assert.equal(stats.revoked, 1);
  assert.equal(stats.partyIdUnreadable, 1);

  const out = env.call('doGet', { parameter: { view: 'featured' } });
  assert.equal(out.getMimeType(), 'application/json');
  const body = JSON.parse(out.getContent());
  assert.deepEqual(Object.keys(body), ['updated', 'apps']);
  assert.match(body.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  body.apps.forEach((app) => assert.deepEqual(Object.keys(app), PUBLIC_KEYS));
  assert.deepEqual(body.apps, [
    { name: 'Tidepool DEX', type: 'Basic Featured App', status: 'provisional', since: '2026-11-14', sinceExact: true, partyIds: [], record: 'https://lists.example/tidepool' },
    { name: 'Harbor Vault', type: 'Featured Asset-Moving App', status: 'featured', since: '2026-11-13', sinceExact: true, partyIds: [PID_A], record: 'https://lists.example/vault' },
    { name: 'Lumen Wallet', type: null, status: 'featured', since: '2026-07-07', sinceExact: false, partyIds: [PID_B, PID_C], record: null },
    { name: 'Copper Bridge', type: 'Featured Asset', status: 'revoked', since: '2026-11-18', sinceExact: true, partyIds: [PID_D], record: 'https://lists.example/copper' }
  ]);

  // Nothing private: no address, institution, sentinel, or anything not on the list.
  const text = JSON.stringify(body).toLowerCase();
  ['@', 'harbor labs', 'lumen labs', 'larkspur', 'copperfield', 'orbit', 'quillpoint', 'see our docs', 'sentinel', 'javascript'].forEach((s) => assert.ok(text.indexOf(s) === -1, s));
});

test('public list as CSV: one line per app, quoted where needed, never a spreadsheet formula', () => {
  const data = publicFixture();
  data.fa.push(faItem({ id: 109, name: '=HYPERLINK("https://evil.example","Win, now")', status: '2-Approved', statusChangedAt: '2026-01-02T00:00:00Z' }));
  const { env } = setupEnv(data);
  env.call('refresh');
  const out = env.call('doGet', { parameter: { view: 'featured', format: 'csv' } });
  assert.equal(out.getMimeType(), 'text/csv');
  assert.equal(out.getFileName(), 'featured-apps.csv');
  const lines = out.getContent().split('\r\n');
  assert.equal(lines[0], 'name,type,status,since,since_exact,party_ids,record');
  assert.equal(lines[1], 'Tidepool DEX,Basic Featured App,provisional,2026-11-14,true,,https://lists.example/tidepool');
  assert.equal(lines[3], 'Lumen Wallet,,featured,2026-07-07,false,' + PID_B + ' ' + PID_C + ',');
  assert.equal(lines[4], '"\'=HYPERLINK(""https://evil.example"",""Win, now"")",,featured,2026-01-02,true,,');
  assert.equal(lines[5], 'Copper Bridge,Featured Asset,revoked,2026-11-18,true,' + PID_D + ',https://lists.example/copper');
  assert.equal(lines[6], '', 'ends with a line break');
  assert.equal(lines.length, 7);
});

test('public list: cached in chunks with the shards; a missing chunk is rebuilt under the lock', () => {
  const fa = Array.from({ length: 600 }, (_, i) => faItem({
    id: 7000 + i, name: 'Featured app number ' + i, status: '2-Approved', statusChangedAt: '2026-10-01T00:00:00Z',
    partyId: 'app-' + i + '::1220' + 'b'.repeat(64), announcement: 'https://lists.example/' + 'x'.repeat(60) + '/' + i
  }));
  const { env, monday } = setupEnv({ fa: fa, dvp: [] });
  env.call('refresh');
  assert.equal(env.putAllCalls, 1, 'shards and the public list in one putAll');
  const index = env.cache.dump()['fa2:pub'];
  assert.ok(index.chunks >= 2, 'more than one chunk: ' + index.chunks);
  for (let i = 0; i < index.chunks; i++) {
    assert.ok(Buffer.byteLength(JSON.stringify(env.cache.dump()['fa2:pub:' + i])) <= 90000);
    assert.equal(env.cache.ttlOf('fa2:pub:' + i), 21600);
  }
  const featured = () => JSON.parse(env.call('doGet', { parameter: { view: 'featured' } }).getContent());
  assert.equal(featured().apps.length, 600);

  const queries = monday.queries;
  env.cache.evict('fa2:pub:1');
  const locks = env.lockAcquisitions;
  assert.equal(featured().apps.length, 600);
  assert.ok(monday.queries > queries, 'rebuilt from Monday');
  assert.equal(env.lockAcquisitions, locks + 1);

  env.lockAvailable = false;
  env.cache.clear();
  assert.deepEqual(featured(), { error: 'unavailable' });
  assert.equal(env.call('doGet', { parameter: { view: 'featured', format: 'csv' } }).getMimeType(), 'application/json', 'errors stay JSON');
});

// ---------------------------------------------------------------------------
// History (activity log, read per link)
// ---------------------------------------------------------------------------

const HISTORY_FA_COLUMNS = ['color_mm4kmej3', 'color_mm6be9ge', 'date_mm4kpckv', 'numeric_mm4k6919', 'color_mm6eay19', 'color_mm8z4ket', 'color_mm8a49an'];

/** The fixture plus activity-log entries for Harbor Swap (101), its DVP request (9003) and Orbit Ledger (103). */
function historyFixture() {
  const data = fixture();
  data.fa[0] = faItem(Object.assign({}, {
    id: 101, name: 'Harbor Swap', institution: 'Harbor Labs', email: 'Alice@Harbor.example', status: '0-Locked+Needs Review', submitted: '2026-09-01'
  }));
  data.logs = [
    { item: 101, column: 'color_mm4kmej3', at: '2026-11-17T12:35:07Z', previous: label('1-Needs Review'), value: label('0-Locked+Needs Review') },
    { item: 101, column: 'color_mm6eay19', at: '2026-11-17T11:26:43Z', previous: label('Locking Check'), value: label('FA Type Email') },
    { item: 101, column: 'color_mm8z4ket', at: '2026-11-17T11:26:31Z', previous: label('Basic Featured App'), value: label('Featured Asset-Moving App') },
    { item: 101, column: 'color_mm8a49an', at: '2026-11-17T11:26:27Z', previous: label('FAAC Approved'), value: label('Needs Review') },
    { item: 101, column: 'color_mm6be9ge', at: '2026-10-02T09:00:00Z', previous: label('Sent Email'), value: label('Done') },
    { item: 101, column: 'date_mm4kpckv', at: '2026-09-10T08:00:00Z', previous: null, value: { date: '2026-09-10', time: null, changed_at: '2026-09-10T08:00:00Z' } },
    { item: 101, column: 'numeric_mm4k6919', at: '2026-09-10T08:01:00Z', previous: { value: 0 }, value: { unit: { precision: 1 }, value: 1.5 } },
    { item: 101, column: 'date_mm4kpckv', at: '2026-11-16T05:19:41Z', previous: { date: '2026-11-15' }, value: { date: '2026-11-16' } },
    { item: 101, column: 'date_mm4kpckv', at: '2026-11-15T05:00:00Z', previous: { date: '2026-11-14' }, value: { date: '2026-11-15' } },
    { item: 101, column: 'numeric_mm4k6919', at: '2026-11-01T08:00:00Z', previous: { value: 1.5 }, value: { unit: { precision: 1 }, value: 2 } },
    { item: 101, column: 'color_mm6eay19', at: '2026-09-05T08:00:00Z', previous: null, value: label('Working on it') },
    { item: 101, column: 'color_mm4kmej3', at: '2026-09-04T08:00:00Z', previous: label('1-Needs Review'), value: label('1-Needs Review') },
    { item: 101, column: 'color_mm4kmej3', at: '2026-09-03T08:00:00Z', previous: null, value: null },
    { item: 101, column: 'text_mm54j2kf', at: '2026-09-02T08:00:00Z', previous: null, value: 'SENTINEL-FAAC-THOUGHTS' },
    { board: DVP, item: 9003, column: 'color_mm8dhgvr', at: '2026-10-15T10:00:00Z', previous: label('New Submission'), value: label('FAAC Approval') },
    { item: 103, column: 'color_mm4kmej3', at: '2026-10-01T10:00:00Z', previous: label('1-Needs Review'), value: label('4-No') }
  ];
  return data;
}

test('lock.confirmed: "0-Locked+Needs Review" means the lock is in place, even without a Lock Verified date', () => {
  const { env } = setupEnv(historyFixture());
  env.call('refresh');
  const swap = appsOf(env, 'alice@harbor.example').find((app) => app.id === '101');
  assert.equal(swap.state, 'in_review');
  assert.deepEqual(swap.lock, { verified: null, amountMillions: null, confirmed: true });
  const vault = appsOf(env, 'alice@harbor.example').find((app) => app.id === '102');
  assert.equal(vault.lock.confirmed, false);
});

test('history: the link\'s own changes, as keys and dates, newest first; nothing else leaves the script', () => {
  const { env, monday } = setupEnv(historyFixture());
  env.call('refresh');
  const apps = appsOf(env, 'alice@harbor.example');
  const swap = apps.find((app) => app.id === '101');
  assert.deepEqual(swap.history, [
    { at: '2026-11-17T12:35:07Z', kind: 'status', to: 'in_review_locked', from: 'in_review' },
    { at: '2026-11-17T11:26:43Z', kind: 'email', to: 'fa_type_info' },
    { at: '2026-11-17T11:26:31Z', kind: 'fa_type', text: 'Featured Asset-Moving App' },
    { at: '2026-11-17T11:26:27Z', kind: 'dvp_status', to: 'in_review' },
    { at: '2026-10-15T10:00:00Z', kind: 'dvp_state', to: 'with_tokenomics', request: '9003' },
    { at: '2026-10-02T09:00:00Z', kind: 'testing', to: 'complete' },
    { at: '2026-09-10T08:01:00Z', kind: 'lock_amount', amount: 1.5 },
    { at: '2026-09-10T08:00:00Z', kind: 'lock_verified', date: '2026-09-10' }
  ], 'no-op changes, cleared cells, labels that send nothing, daily lock re-stamps, amount updates and other columns are left out');
  assert.deepEqual(apps.find((app) => app.id === '102').history, []);

  // Only this link's items and the history columns were asked for, never an empty item list.
  const fa = monday.logRequests.filter((r) => r.board === FA);
  const dvp = monday.logRequests.filter((r) => r.board === DVP);
  assert.deepEqual(fa.map((r) => r.items.sort()), [['101', '102']]);
  assert.deepEqual(fa[0].columns, HISTORY_FA_COLUMNS);
  assert.deepEqual(dvp.map((r) => [r.items, r.columns]), [[['9003'], ['color_mm8dhgvr']]]);
  monday.logRequests.forEach((r) => assert.ok(r.items.length > 0));

  const text = JSON.stringify(apps) + env.cache.raw() + env.logText();
  ['SENTINEL-USER-7', 'SENTINEL-PULSE-NAME', 'SENTINEL-COLUMN-TITLE', 'SENTINEL-FAAC-THOUGHTS', '4-No', 'Locking Check'].forEach((s) => assert.ok(text.indexOf(s) === -1, s + ' leaked'));
});

test('history: cached per link for 10 minutes; another link never sees it', () => {
  const { env, monday } = setupEnv(historyFixture());
  env.call('refresh');
  const token = env.tokenFor('alice@harbor.example');
  env.get(token);
  const requests = monday.logRequests.length;
  env.get(token);
  assert.equal(monday.logRequests.length, requests, 'second load comes from the cache');
  assert.equal(env.cache.ttlOf('fa2:hist:' + token), 600);

  const orbit = appsOf(env, 'dev@orbit.example')[0];
  assert.deepEqual(orbit.history, [{ at: '2026-10-01T10:00:00Z', kind: 'status', to: 'not_approved', from: 'in_review' }]);
  assert.ok(JSON.stringify(orbit).indexOf('in_review_locked') === -1);
});

test('history: entries for other items are dropped even if Monday ignored item_ids', () => {
  const { env, monday } = setupEnv(historyFixture());
  monday.ignoreItemFilter = true;
  env.call('refresh');
  const orbit = appsOf(env, 'dev@orbit.example')[0];
  assert.equal(orbit.history.length, 1);
  assert.equal(orbit.history[0].to, 'not_approved');
});

test('history: if the activity log can\'t be read, the answer goes out without it', () => {
  const { env, monday } = setupEnv(historyFixture());
  env.call('refresh');
  monday.failNext.push({ code: 500, body: 'oops' }, { code: 500, body: 'oops' }, { code: 500, body: 'oops' });
  const body = env.get(env.tokenFor('alice@harbor.example')).body;
  assert.equal(body.found, true);
  assert.equal(body.apps.length, 2);
  body.apps.forEach((app) => assert.equal(app.history, undefined));
  assert.ok(env.logText().indexOf('"mode":"history"') !== -1);
  assert.ok(!env.cache.keys().some((key) => key.indexOf('fa2:hist:') === 0), 'a failure is not cached');
});

// ---------------------------------------------------------------------------
// doGet
// ---------------------------------------------------------------------------

test('doGet: a good token, an unknown one, a malformed one, none at all', () => {
  const { env, monday } = setupEnv();
  env.call('refresh');
  const hit = env.get(env.tokenFor('dev@orbit.example'));
  assert.equal(hit.mimeType, 'application/json');
  assert.equal(hit.body.found, true);
  assert.deepEqual(env.get(env.tokenFor('nobody@x.example')).body, { found: false });

  const queries = monday.queries;
  const locks = env.lockAcquisitions;
  assert.deepEqual(env.get('too-short').body, { found: false });
  assert.deepEqual(env.get('k7Qm2xV9pLr4TzN8wYc3E!').body, { found: false });
  assert.deepEqual(env.get(undefined).body, { found: false });
  assert.equal(monday.queries, queries, 'malformed tokens never reach Monday');
  assert.equal(env.lockAcquisitions, locks);
});

test('doGet: a missing shard is rebuilt from Monday under the lock', () => {
  const { env, monday } = setupEnv();
  env.call('refresh');
  const token = env.tokenFor('alice@harbor.example');
  env.cache.evict('fa2:' + token.charCodeAt(0));
  const queries = monday.queries;
  const locks = env.lockAcquisitions;
  assert.equal(env.get(token).body.found, true);
  assert.ok(monday.queries > queries, 'read Monday again');
  assert.equal(env.lockAcquisitions, locks + 1);
  assert.equal(env.lockReleases, env.lockAcquisitions);
  assert.equal(shardKeys(env).length, 64, 'cache refilled');
});

test('doGet: Monday down or lock busy on a cache miss gives {"error":"unavailable"} and no details', () => {
  const { env, monday } = setupEnv();
  monday.failNext = [1, 2, 3].map(() => ({ code: 500, body: 'secret internal detail' }));
  assert.deepEqual(env.get(env.tokenFor('alice@harbor.example')).body, { error: 'unavailable' });
  assert.ok(env.logText().indexOf('monday_http_500') !== -1);
  assert.ok(env.logText().indexOf('secret internal detail') === -1);

  const second = setupEnv();
  second.env.lockAvailable = false;
  assert.deepEqual(second.env.get(second.env.tokenFor('alice@harbor.example')).body, { error: 'unavailable' });
});

// ---------------------------------------------------------------------------
// doPost: emailing the link
// ---------------------------------------------------------------------------

test('doPost: an address on an application gets one email with its link', () => {
  const { env } = setupEnv();
  env.call('refresh');
  const res = env.post({ email: '  Alice@Harbor.Example ' });
  assert.equal(res.mimeType, 'application/json');
  assert.deepEqual(res.body, { ok: true });
  assert.equal(env.mail.sent.length, 1);
  const mail = env.mail.sent[0];
  const link = 'https://status.example.org/#' + env.tokenFor('alice@harbor.example');
  assert.equal(mail.to, 'alice@harbor.example');
  assert.equal(mail.subject, 'Your Featured App status link');
  assert.equal(mail.name, 'Featured App Status');
  assert.ok(mail.body.indexOf(link) !== -1);
  assert.ok(mail.htmlBody.indexOf('href="' + link + '"') !== -1);
  // The emailed link opens exactly that address's applications.
  const token = link.split('#')[1];
  assert.deepEqual(env.get(token).body.apps.map((a) => a.name), ['Harbor Vault', 'Harbor Swap']);
});

test('doPost: an unknown address gets the same answer and no email, after a similar pause', () => {
  const { env } = setupEnv();
  env.call('refresh');
  assert.deepEqual(env.post({ email: 'stranger@nowhere.example' }).body, { ok: true });
  assert.equal(env.mail.sent.length, 0);
  const pause = env.sleeps[env.sleeps.length - 1];
  assert.ok(pause >= 600 && pause < 1400, 'paused ' + pause);
});

test('doPost: anything that is not one address is refused as invalid_email', () => {
  const { env } = setupEnv();
  env.call('refresh');
  [{ email: 'not-an-email' }, { email: '' }, { email: 'a@b.com, c@d.com' }, {}, 'garbage', JSON.stringify({ email: 'x'.repeat(3000) + '@a.com' })]
    .forEach((body) => assert.deepEqual(env.post(body).body, { ok: false, error: 'invalid_email' }, JSON.stringify(body).slice(0, 40)));
  assert.equal(env.mail.sent.length, 0);
  // A plain form post works too.
  const out = env.call('doPost', { parameter: { email: 'dev@orbit.example' }, postData: { contents: 'email=dev%40orbit.example', type: 'application/x-www-form-urlencoded' } });
  assert.deepEqual(JSON.parse(out.getContent()), { ok: true });
  assert.equal(env.mail.sent.length, 1);
});

test('doPost: one email per address per 15 minutes, at most 3 per 6 hours', () => {
  const { env } = setupEnv();
  env.call('refresh');
  const token = env.tokenFor('bob@harbor.example');
  const key = 'fa2:mail:' + token;
  const setRecord = (record) => env.eval('CacheService.getScriptCache().put(' + JSON.stringify(key) + ', ' + JSON.stringify(JSON.stringify(record)) + ', 21600)');

  env.post({ email: 'bob@harbor.example' });
  env.post({ email: 'bob@harbor.example' });
  assert.equal(env.mail.sent.length, 1, 'cooldown');

  const now = Date.now();
  setRecord({ first: now - 3600000, count: 1, last: now - 16 * 60000 });
  env.post({ email: 'bob@harbor.example' });
  assert.equal(env.mail.sent.length, 2, 'cooldown over');

  setRecord({ first: now - 3600000, count: 3, last: now - 16 * 60000 });
  env.post({ email: 'bob@harbor.example' });
  assert.equal(env.mail.sent.length, 2, 'window full');

  setRecord({ first: now - 7 * 3600000, count: 3, last: now - 16 * 60000 });
  env.post({ email: 'bob@harbor.example' });
  assert.equal(env.mail.sent.length, 3, 'new window');
  assert.ok(env.cache.raw().indexOf('bob@') === -1, 'the limit is kept under the token, not the address');
});

test('doPost: keeps a reserve of the email quota; a failed send is logged without the address', () => {
  const { env } = setupEnv();
  env.call('refresh');
  env.mail.remainingQuota = 10;
  assert.deepEqual(env.post({ email: 'dev@orbit.example' }).body, { ok: true });
  assert.equal(env.mail.sent.length, 0);
  assert.ok(env.logText().indexOf('mail_quota_low') !== -1);

  env.mail.remainingQuota = 100;
  env.mail.failNext = true;
  assert.deepEqual(env.post({ email: 'hi@quillpoint.example' }).body, { ok: true });
  assert.ok(env.logText().indexOf('mail_failed') !== -1);
  assert.ok(env.logText().indexOf('hi@quillpoint.example') === -1);
});

test('doPost: Monday down on a cache miss gives {"ok":false,"error":"unavailable"}', () => {
  const { env, monday } = setupEnv();
  monday.failNext = [1, 2, 3].map(() => ({ code: 503, body: 'down' }));
  assert.deepEqual(env.post({ email: 'alice@harbor.example' }).body, { ok: false, error: 'unavailable' });
  assert.equal(env.mail.sent.length, 0);
});

// ---------------------------------------------------------------------------
// refresh guards, config and setup
// ---------------------------------------------------------------------------

test('refresh: skips without the lock, stops on bad settings, keeps the old cache when Monday fails', () => {
  const busy = setupEnv();
  busy.env.lockAvailable = false;
  assert.equal(busy.env.call('refresh'), undefined);
  assert.ok(busy.env.logText().indexOf('lock_busy') !== -1);

  const bad = setupEnv(fixture(), { MONDAY_API_TOKEN: '', LINK_SECRET: 'short' });
  assert.equal(bad.env.call('refresh'), undefined);
  const log = bad.env.logText();
  assert.ok(log.indexOf('MONDAY_API_TOKEN is not set') !== -1);
  assert.ok(log.indexOf('LINK_SECRET is too short') !== -1);
  assert.ok(log.indexOf('short"') === -1, 'values are never logged');

  const { env, monday } = setupEnv();
  env.call('refresh');
  const before = env.cache.raw();
  monday.failNext = [1, 2, 3].map(() => ({ code: 500, body: 'x' }));
  assert.throws(() => env.call('refresh'), /refresh failed: monday_http_500/);
  assert.equal(env.cache.raw(), before);
  assert.equal(env.lockReleases, env.lockAcquisitions);
});

test('SITE_URL gets a trailing slash unless it ends in .html', () => {
  const { env } = setupEnv();
  assert.equal(env.call('normaliseSiteUrl_', 'https://x.example/fa-status'), 'https://x.example/fa-status/');
  assert.equal(env.call('normaliseSiteUrl_', 'https://x.example/'), 'https://x.example/');
  assert.equal(env.call('normaliseSiteUrl_', 'https://x.example/index.html'), 'https://x.example/index.html');
  const props = setupEnv(fixture(), { SITE_URL: 'http://insecure.example' });
  assert.equal(props.env.call('refresh'), undefined);
  assert.ok(props.env.logText().indexOf('SITE_URL must be an https://') !== -1);
});

test('setup: creates the secret and the trigger once, checks the boards, runs refresh', () => {
  const { env } = setupEnv(fixture(), { LINK_SECRET: undefined });
  delete env.props.LINK_SECRET;
  env.call('setup');
  const secret = env.props.LINK_SECRET;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.deepEqual(env.triggers, [{ handler: 'refresh', minutes: 10 }]);
  assert.ok(appsOf(env, 'alice@harbor.example'));
  const line = JSON.parse(env.logs.find((l) => l.text.indexOf('"mode":"setup"') !== -1).text);
  assert.equal(line.secretCreated, true);
  assert.equal(line.mailQuota, 100);
  assert.equal(line.addresses, ADDRESSES.length);
  assert.equal(line.dvpMatched, 3);

  env.call('setup');
  assert.equal(env.props.LINK_SECRET, secret, 'never replaced');
  assert.equal(env.triggers.length, 1);
});

test('setup: refuses incomplete settings (names only) and a board without email columns', () => {
  const missing = setupEnv(fixture(), { SITE_URL: '' });
  assert.throws(() => missing.env.call('setup'), (err) => /SITE_URL is not set/.test(err.message) && err.message.indexOf('test-token-xyz') === -1);
  assert.equal(missing.env.triggers.length, 0);

  const noEmail = setupEnv(Object.assign(fixture(), { missingColumns: EMAIL_COLUMNS }));
  assert.throws(() => noEmail.env.call('setup'), /neither email column/);

  const oneMissing = setupEnv(Object.assign(fixture(), { missingColumns: ['link_mm6hfp5g'] }));
  oneMissing.env.call('setup');
  const line = JSON.parse(oneMissing.env.logs.find((l) => l.text.indexOf('"mode":"setup"') !== -1).text);
  assert.deepEqual(line.missingColumns, { fa: ['link_mm6hfp5g'], dvp: [] });

  const unreadable = setupEnv();
  unreadable.monday.failNext = [{ code: 401, body: '{"errors":[{"message":"Not Authenticated"}]}' }];
  assert.throws(() => unreadable.env.call('setup'), /Could not read the FA board \(monday_unauthorized\)/);
});

test('the DVP board id is read from DVP_BOARD_ID when set', () => {
  const data = fixture();
  const monday = createFakeMonday(data);
  monday.boards['777'] = monday.boards[DVP];
  delete monday.boards[DVP];
  const env = createGasEnv({ props: Object.assign({}, PROPS, { DVP_BOARD_ID: '777' }), fetch: monday.handle });
  assert.equal(env.call('refresh').dvpRows, 4);
});
