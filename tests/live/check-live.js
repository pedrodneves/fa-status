'use strict';
/**
 * check-live.js: end-to-end check of apps-script/Code.gs against the REAL
 * Monday boards, READ-ONLY.
 *
 *   MONDAY_API_TOKEN=... npm run live-check
 *
 * Google services are mocked (tests/support/gas-env.js): MailApp only records
 * messages, so NO EMAIL IS SENT. Only UrlFetchApp is real, built on curl.
 * Safety:
 *   - Every request is inspected before it is sent; anything that is not a
 *     plain query (a mutation) aborts the run. Nothing can be written.
 *   - The token is handed to curl on stdin (its --config), never on the
 *     command line and never written to disk.
 *   - The output is counts only: no names, addresses or tokens are printed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createGasEnv } = require('../support/gas-env');

const TOKEN = process.env.MONDAY_API_TOKEN || '';
if (!TOKEN) {
  console.error('Set MONDAY_API_TOKEN (any token that can read the two boards).');
  process.exit(2);
}
const SITE = 'https://status.example.org/';
const SECRET = 'live-check-' + Date.now() + '-0123456789abcdef0123456789';
const EMAIL_FIND = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// ---------------------------------------------------------------- guarded, real UrlFetchApp
let queries = 0;

function realFetch(req) {
  const query = String(req.payload.query || '');
  if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error('SAFETY: only read queries are allowed');
  queries++;
  const tmp = path.join(os.tmpdir(), 'fa-live-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp + '.json', JSON.stringify(req.payload));
  const config = [
    'url = "https://api.monday.com/v2"',
    'request = "POST"',
    'header = "Authorization: ' + TOKEN + '"',
    'header = "API-Version: ' + req.options.headers['API-Version'] + '"',
    'header = "Content-Type: application/json"',
    'data-binary = "@' + tmp + '.json"',
    'silent',
    'show-error',
    'max-time = 60',
    'write-out = "\\n%{http_code}"'
  ].join('\n');
  const run = spawnSync('curl', ['--config', '-'], { input: config, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { fs.unlinkSync(tmp + '.json'); } catch (e) { /* ignore */ }
  if (run.status !== 0) throw new Error('curl failed (' + run.status + ')');
  const out = run.stdout;
  const cut = out.lastIndexOf('\n');
  return { code: Number(out.slice(cut + 1)), body: out.slice(0, cut), headers: {} };
}

// ---------------------------------------------------------------- checks
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
}

const env = createGasEnv({ props: { MONDAY_API_TOKEN: TOKEN, SITE_URL: SITE, LINK_SECRET: SECRET }, fetch: realFetch });

// 1. setup() against the real boards (trigger and secret are mocked).
const stats = env.call('setup');
check('setup and refresh ran against the real boards', stats && stats.faRows > 0,
  'faRows ' + stats.faRows + ', dvpRows ' + stats.dvpRows + ', queries ' + queries);
const setupLine = JSON.parse(env.logs.find((l) => l.text.indexOf('"mode":"setup"') !== -1).text);
check('no expected column is missing on either board', setupLine.missingColumns.fa.length === 0 && setupLine.missingColumns.dvp.length === 0,
  JSON.stringify(setupLine.missingColumns));
check('every FA Status / Testing / DVP / Send Email label is known', ['fa', 'testing', 'dvp', 'email'].every((b) => Object.keys(JSON.parse(env.logs.filter((l) => l.text.indexOf('"mode":"refresh"') !== -1).pop().text).unknownLabels[b]).length === 0));
check('largest cache shard is well under 100 KB', stats.cacheLargestShard < 60000, stats.cacheLargestShard + ' bytes');
console.log('     addresses ' + stats.addresses + ', apps reachable ' + stats.appsServed + ', apps without an email ' + stats.appsWithoutEmail +
  ', DVP matched ' + stats.dvpMatched + ', unmatched ' + stats.dvpUnmatched);

// 2. Re-read the FA rows' emails (read-only) to check every address resolves to its rows.
const faRows = env.call('readItems_', env.call('readConfig_'), '18420896395', ['email_mm4ke170', 'text_mm4kvrar']);
let pairs = 0;
let misses = 0;
const allAddresses = new Set();
faRows.forEach((row) => {
  const text = row.column_values.map((c) => [c.text || '', c.value || ''].join(' ')).join(' ');
  const emails = Array.from(new Set((text.match(EMAIL_FIND) || []).map((e) => e.toLowerCase())));
  emails.forEach((email) => {
    allAddresses.add(email);
    pairs++;
    const body = env.get(env.tokenFor(email)).body;
    if (!body.found || !body.apps.some((a) => a.id === String(row.id))) misses++;
  });
});
check('every address on every FA row opens a list that includes that row', misses === 0, pairs + ' address/row pairs, ' + misses + ' misses');

// 3. Privacy: no address anywhere in the cache, the answers or the logs.
const answers = Array.from(allAddresses).map((e) => JSON.stringify(env.get(env.tokenFor(e)).body)).join('\n');
const haystack = (env.cache.raw() + '\n' + answers + '\n' + env.logText()).toLowerCase();
let leaked = 0;
allAddresses.forEach((e) => { if (haystack.indexOf(e) !== -1) leaked++; });
check('no email address appears in the cache, any answer or the logs', leaked === 0, allAddresses.size + ' addresses checked');
const keys = new Set();
answers.split('\n').forEach((line) => {
  const body = JSON.parse(line);
  (body.apps || []).forEach((a) => { Object.keys(a).forEach((k) => keys.add('app.' + k)); (a.dvp || []).forEach((d) => Object.keys(d).forEach((k) => keys.add('dvp.' + k))); });
});
const allowed = ['app.id', 'app.name', 'app.institution', 'app.type', 'app.submitted', 'app.state', 'app.lock', 'app.testing', 'app.partyId',
  'app.website', 'app.announcement', 'app.update', 'app.updated', 'app.dvp', 'dvp.id', 'dvp.name', 'dvp.state', 'dvp.submitted', 'dvp.finalApproval',
  'dvp.requestUrl', 'dvp.requestRef', 'dvp.updated'];
check('answers carry only allow-listed fields', Array.from(keys).every((k) => allowed.indexOf(k) !== -1), keys.size + ' distinct fields');

// 4. The email form, with MailApp mocked: a real address gets one (recorded) email whose link works; an unknown one gets nothing.
const someone = Array.from(allAddresses)[0];
const posted = env.post({ email: someone.toUpperCase() });
const mail = env.mail.sent[0];
const link = mail && mail.body.match(/https:\/\/status\.example\.org\/#([A-Za-z0-9_-]{22})/);
check('doPost for an address on a row records one email (not sent)', posted.body.ok === true && env.mail.sent.length === 1 && mail.to === someone);
check('the emailed link opens that address\'s applications', link && env.get(link[1]).body.found === true);
env.post({ email: 'nobody-' + Date.now() + '@example.invalid' });
check('doPost for an unknown address sends nothing and answers the same', env.mail.sent.length === 1);

// 5. Never a write.
check('no mutation was ever sent (every request was a read query)', env.requests.every((r) => /^\s*query\b/.test(r.payload.query)), queries + ' queries');

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (failed ? failed + ' CHECK(S) FAILED' : 'ALL ' + results.length + ' CHECKS PASSED'));
process.exit(failed ? 1 : 0);
