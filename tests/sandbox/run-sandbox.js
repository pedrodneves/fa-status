'use strict';
/**
 * run-sandbox.js: end-to-end check of apps-script/Code.gs against the REAL
 * Monday API, on the two SANDBOX boards only (synthetic rows, no applicant data).
 *
 *   MONDAY_API_TOKEN=... node tests/sandbox/run-sandbox.js
 *
 * Google services are mocked (tests/support/gas-env.js); only UrlFetchApp is
 * real, built on curl. Safety:
 *   - Every request is inspected before it is sent. A board id other than the
 *     two sandbox boards, or any mutation other than change_multiple_column_values,
 *     aborts the run. Production boards can't be touched.
 *   - The token is handed to curl on stdin (its --config), never on the command
 *     line and never written to disk.
 * The sandbox has no Gmail automation for the "Status link" label, so setting
 * it sends nothing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createGasEnv } = require('../support/gas-env');

const SANDBOX_FA = '18440148669';
const SANDBOX_DVP = '18440148702';
const SANDBOX_IDS = new Set([SANDBOX_FA, SANDBOX_DVP]);
const LINK_COL = 'link_mm95vm0';
const REL_COL = 'board_relation_mm95ygkj';
const SEND_EMAIL = 'color_mm6eay19';
const SITE = 'https://status.example.org/';
const TOKEN = process.env.MONDAY_API_TOKEN || '';

if (!TOKEN) {
  console.error('Set MONDAY_API_TOKEN (a token that can edit the sandbox boards).');
  process.exit(2);
}

// ---------------------------------------------------------------- guarded, real UrlFetchApp
let mutationRequests = 0;

function guard(payload) {
  const query = String(payload.query || '');
  const vars = payload.variables || {};
  (query.match(/\b\d{9,}\b/g) || []).forEach((id) => {
    if (!SANDBOX_IDS.has(id)) throw new Error('SAFETY: non-sandbox id in query');
  });
  if (Object.prototype.hasOwnProperty.call(vars, 'b') && !SANDBOX_IDS.has(String(vars.b))) {
    throw new Error('SAFETY: board ' + vars.b + ' is not a sandbox board');
  }
  if (/^\s*mutation/.test(query)) {
    const others = query.replace(/change_multiple_column_values/g, '');
    if (/\b(create|delete|archive|duplicate|move|update|change|add|remove|set)_[a-z_]+\s*\(/.test(others)) {
      throw new Error('SAFETY: only change_multiple_column_values is allowed');
    }
    if (!SANDBOX_IDS.has(String(vars.b))) throw new Error('SAFETY: mutation without a sandbox board variable');
    mutationRequests++;
  }
}

function realFetch(req) {
  guard(req.payload);
  const tmp = path.join(os.tmpdir(), 'fa-sandbox-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp + '.json', JSON.stringify(req.payload));
  const config = [
    'url = "https://api.monday.com/v2"',
    'request = "POST"',
    'header = "Authorization: ' + TOKEN + '"',
    'header = "API-Version: ' + req.options.headers['API-Version'] + '"',
    'header = "Content-Type: application/json"',
    'data-binary = "@' + tmp + '.json"',
    'dump-header = "' + tmp + '.headers"',
    'silent',
    'show-error',
    'max-time = 60',
    'write-out = "\\n%{http_code}"'
  ].join('\n');
  const run = spawnSync('curl', ['--config', '-'], { input: config, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const headersText = fs.existsSync(tmp + '.headers') ? fs.readFileSync(tmp + '.headers', 'utf8') : '';
  [tmp + '.json', tmp + '.headers'].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
  if (run.status !== 0) throw new Error('curl failed (' + run.status + ')');
  const out = run.stdout;
  const cut = out.lastIndexOf('\n');
  const headers = {};
  headersText.split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return { code: Number(out.slice(cut + 1)), body: out.slice(0, cut), headers: headers };
}

// ---------------------------------------------------------------- helpers
const props = {
  MONDAY_API_TOKEN: TOKEN,
  STATUS_LINK_COLUMN_ID: LINK_COL,
  SITE_URL: SITE,
  FA_BOARD_ID: SANDBOX_FA,
  DVP_BOARD_ID: SANDBOX_DVP,
  DVP_LINK_COLUMN_ID: REL_COL
};
const env = createGasEnv({ props: props, fetch: realFetch, realSleep: true });
let failures = 0;

function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!condition) failures++;
}

/** Direct GraphQL through the same guarded fetch (for setup and read-backs). */
function gql(query, variables) {
  const res = realFetch({ payload: { query: query, variables: variables || {} }, options: { headers: { 'API-Version': '2026-10' } } });
  const body = JSON.parse(res.body);
  if (res.code !== 200 || body.errors) throw new Error('gql failed: HTTP ' + res.code + ' ' + JSON.stringify((body.errors || []).map((e) => e.extensions && e.extensions.code)));
  return body.data;
}

function readFa() {
  const data = gql('query ($b: ID!, $c: [String!]) { boards(ids: [$b]) { items_page(limit: 100) { items { id name column_values(ids: $c) { id text value } } } } }',
    { b: SANDBOX_FA, c: [LINK_COL, SEND_EMAIL] });
  return data.boards[0].items_page.items.map((item) => {
    const cols = {};
    item.column_values.forEach((c) => { cols[c.id] = c; });
    const link = cols[LINK_COL] && cols[LINK_COL].value ? JSON.parse(cols[LINK_COL].value) : null;
    return { id: item.id, name: item.name, link: link, code: link && link.url.indexOf('#') !== -1 ? link.url.split('#')[1] : null, sendEmail: cols[SEND_EMAIL] ? cols[SEND_EMAIL].text : null };
  });
}

function write(itemId, values) {
  gql('mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }',
    { b: SANDBOX_FA, i: itemId, v: JSON.stringify(values) });
}
const clearLink = (id) => { const v = {}; v[LINK_COL] = null; write(id, v); };
const byName = (rows, name) => rows.find((r) => r.name === name);

// ---------------------------------------------------------------- scenario
console.log('Sandbox run against FA ' + SANDBOX_FA + ' and DVP ' + SANDBOX_DVP);

// 0. Reset: no Status links and no Send Email on any sandbox row.
readFa().forEach((row) => { const v = {}; v[LINK_COL] = null; v[SEND_EMAIL] = null; write(row.id, v); });
let rows = readFa();
check('reset: every Status link and Send Email is empty', rows.every((r) => !r.link && !r.sendEmail), rows.length + ' rows');

// 1. setup(): checks the columns on the real board, creates the trigger, runs refresh.
const first = env.call('setup');
check('setup() passed its Monday checks and created one trigger', env.triggers.length === 1);
check('first refresh wrote a link for every row', first.linksWritten === rows.length && first.served === rows.length, first.linksWritten + ' written, ' + first.served + ' served');
rows = readFa();
check('links read back as {url: SITE_URL#code, text: "Status link"}', rows.every((r) => r.link && r.link.text === 'Status link' && /^https:\/\/status\.example\.org\/#[A-Za-z0-9_-]{22}$/.test(r.link.url)));
check('no Send Email label without SEND_LINK_EMAIL', rows.every((r) => !r.sendEmail));

// 2. doGet answers every code with the right content.
const harbor = env.get(byName(rows, 'Harbor Swap').code).body;
check('Harbor Swap: with_tokenomics, lock 1.5M, testing complete', harbor.found && harbor.app.state === 'with_tokenomics' && harbor.app.lock.amountMillions === 1.5 && harbor.app.lock.verified === '2026-10-18' && harbor.app.testing === 'complete');
check('Harbor Swap: its two DVP requests via the Connect boards column', harbor.found && harbor.app.dvp.length === 2, harbor.found && harbor.app.dvp.map((d) => d.state).join(','));
const fernway = env.get(byName(rows, 'Fernway USD').code).body;
check('Fernway USD: approved with its announcement link', fernway.found && fernway.app.state === 'approved' && /^https:\/\/lists\.example\.org\//.test(fernway.app.announcement));
check('Fernway USD: approved DVP request carries its final approval date', fernway.found && fernway.app.dvp.length === 1 && fernway.app.dvp[0].state === 'approved' && fernway.app.dvp[0].finalApproval === '2026-10-15' && fernway.app.dvp[0].requestRef === '131');
check('Copperleaf Markets: empty FA Status reads as received', env.get(byName(rows, 'Copperleaf Markets').code).body.app.state === 'received');
check('Orbit Ledger: revoked', env.get(byName(rows, 'Orbit Ledger').code).body.app.state === 'revoked');
check('unknown code: found false', JSON.stringify(env.get('AAAAAAAAAAAAAAAAAAAAAA').body) === '{"found":false}');

// 3. Clearing a cell retires the link and issues a new one.
const lumenOld = byName(rows, 'Lumen Wallet').code;
clearLink(byName(rows, 'Lumen Wallet').id);
env.call('refresh');
rows = readFa();
const lumenNew = byName(rows, 'Lumen Wallet').code;
check('cleared cell gets a new code', lumenNew && lumenNew !== lumenOld);
check('old link is no longer valid', env.get(lumenOld).body.found === false);
check('new link works', env.get(lumenNew).body.found === true);

// 4. The same code on two rows: neither is served until fixed.
const harborCode = byName(rows, 'Harbor Swap').code;
const copperId = byName(rows, 'Copperleaf Markets').id;
(function () { const v = {}; v[LINK_COL] = { url: SITE + '#' + harborCode, text: 'Status link' }; write(copperId, v); })();
let stats = env.call('refresh');
check('duplicate code is counted and not served', stats.duplicateCodes === 1 && env.get(harborCode).body.found === false);
clearLink(copperId);
env.call('refresh');
rows = readFa();
check('after clearing the copy, the original works again and the copy gets its own code', env.get(harborCode).body.found === true && byName(rows, 'Copperleaf Markets').code && byName(rows, 'Copperleaf Markets').code !== harborCode);

// 5. A hand-typed link is never overwritten.
const tideId = byName(rows, 'Tidewater DEX').id;
(function () { const v = {}; v[LINK_COL] = { url: 'https://example.org/somewhere', text: 'hand typed' }; write(tideId, v); })();
stats = env.call('refresh');
rows = readFa();
check('unreadable link left untouched and counted', stats.unreadableLinks === 1 && byName(rows, 'Tidewater DEX').link.url === 'https://example.org/somewhere');
clearLink(tideId);
env.call('refresh');

// 6. Automatic email: a new row gets link + Send Email label in one write.
env.props.SEND_LINK_EMAIL = 'true';
env.props.EMAIL_NEW_ROWS_FROM = '2026-11-16T00:00:00Z';
rows = readFa();
const quillId = byName(rows, 'Quillpoint Vault').id;
(function () { const v = {}; v[LINK_COL] = null; v[SEND_EMAIL] = null; write(quillId, v); })();
stats = env.call('refresh');
rows = readFa();
check('new row: link written with Send Email = "Status link"', stats.emailLabelsSet === 1 && byName(rows, 'Quillpoint Vault').sendEmail === 'Status link' && /#[A-Za-z0-9_-]{22}$/.test(byName(rows, 'Quillpoint Vault').link.url), 'labels set: ' + stats.emailLabelsSet);
env.props.SEND_LINK_EMAIL = 'false';

// 7. Evicted cache: doGet rebuilds read-only from the real board, with zero writes.
env.cache.clear();
const before = mutationRequests;
const quill = env.get(byName(rows, 'Quillpoint Vault').code).body;
check('evicted cache: doGet rebuilds and answers', quill.found === true && quill.app.state === 'in_review');
check('evicted cache: no writes during the page view', mutationRequests === before);

// 8. The logs never contain codes, names or URLs.
const logs = env.logText();
const leaks = rows.filter((r) => r.code && logs.includes(r.code)).length + (logs.includes('Harbor') ? 1 : 0) + (logs.includes('https://') ? 1 : 0);
check('logs hold counts only (no codes, names or URLs)', leaks === 0);

console.log('\nLast refresh stats: ' + JSON.stringify(stats));
console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASSED');
process.exit(failures ? 1 : 0);
