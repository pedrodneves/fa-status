/**
 * =============================================================================
 *  FA Status Portal: Google Apps Script backend (Code.gs)
 * =============================================================================
 *
 * WHAT THIS IS
 * ------------
 * Every Featured App (FA) application gets a private link of the form
 *
 *     https://status.<domain>/#<code>
 *
 * The page behind that address is a static site on GitHub Pages (docs/). It is
 * the same for everyone and holds no applicant data and no secrets. This script
 * is the only part that talks to Monday (it holds the API token). It has two
 * jobs:
 *
 *   1. answer one link at a time for the page          -> doGet(e)
 *   2. every 10 minutes, give new FA rows a link and
 *      rebuild the cache the page is answered from     -> refresh()
 *
 * FLOW 1: A PAGE VIEW (browser -> doGet)
 * --------------------------------------
 *   The browser opens https://status.<domain>/#<code>.
 *     -> status.js reads <code> from location.hash. (Browsers never send the
 *        part after '#' to GitHub.)
 *     -> status.js calls GET <this web app's /exec URL>?link=<code>.
 *     -> doGet(e):
 *          a. Checks the code's format (22 base64url characters). A bad format
 *             gets {"found": false} straight away, without touching the cache.
 *          b. Reads ONE cache shard: the one for the code's first character.
 *          c. If the shard is there, answers {"found": true, "app": {...}} or
 *             {"found": false}.
 *          d. If the shard is missing (expired or evicted), takes the script
 *             lock and reads the shard again, since another request may have
 *             refilled it. If it is still missing, rebuilds the cache from
 *             Monday in READ-ONLY mode (no codes issued, nothing written to
 *             Monday) and answers from the result.
 *          e. Any failure: {"error": "unavailable"} and nothing else.
 *
 * FLOW 2: THE 10-MINUTE JOB (time-driven trigger -> refresh)
 * ----------------------------------------------------------
 *   refresh():
 *     1. Takes the script lock so two runs never overlap.
 *     2. Reads the Script Properties (below) and stops if they are incomplete.
 *     3. Reads the FA board: only the allow-listed columns, plus Status link
 *        and Send Email. In phase 2 it also reads the DVP board.
 *     4. For every FA row whose Status link cell is EMPTY, it makes a new code
 *        and writes {url: SITE_URL + "#" + code, text: "Status link"} back to
 *        Monday: at most 200 rows per run, 20 writes per request. For new rows
 *        it can also set Send Email to "Status link" in the same write, so a
 *        Monday automation emails the link (see chooseEmailRows_).
 *     5. Builds the applicant views (allow-listed fields only) for every row
 *        whose code is valid, unique and saved in Monday.
 *     6. Writes all 64 cache shards in one call, with a 6-hour expiry.
 *     7. Logs ONE JSON line of counts. Never codes, names, URLs or Monday
 *        error messages.
 *
 * SCRIPT PROPERTIES (Project Settings -> Script Properties)
 * ---------------------------------------------------------
 *   MONDAY_API_TOKEN       Required. API token of the Monday account the
 *                          script uses. Never logged, never returned.
 *   STATUS_LINK_COLUMN_ID  Required. Id of the "Status link" Link column on the
 *                          FA board, e.g. link_mm95vm0.
 *   SITE_URL               Required. The page's https address, e.g.
 *                          https://status.example.org. A trailing "/" is added
 *                          unless it ends in ".html".
 *   SEND_LINK_EMAIL        Optional. Exactly "true" switches the automatic email
 *                          on; anything else, or unset, means off. Keep it off
 *                          until the Gmail automation on "Send Email = Status
 *                          link" exists.
 *   EMAIL_NEW_ROWS_FROM    Needed when SEND_LINK_EMAIL is "true". An ISO date
 *                          such as 2026-12-01. Only rows created on or after it
 *                          get the automatic email; the team sends older rows
 *                          their link by hand.
 *   FA_BOARD_ID            Optional. Defaults to the production FA board. Point
 *                          it at the sandbox copy for testing.
 *   DVP_BOARD_ID           Optional. Defaults to the production DVP board.
 *   DVP_LINK_COLUMN_ID     Optional (phase 2). Id of the Connect boards column
 *                          on the DVP board that points at FA rows. While it is
 *                          unset, the DVP board is not read and "dvp" is [].
 *
 * SETUP (once)
 * ------------
 *   1. script.google.com -> New project. Paste this file into Code.gs. In
 *      Project Settings, tick "Show appsscript.json manifest file in editor",
 *      then replace that file with apps-script/appsscript.json.
 *   2. Project Settings -> Script Properties: add the properties above.
 *   3. In the editor, pick "setup" in the function menu and press Run. Approve
 *      the two permissions (external requests and triggers). setup() checks
 *      the properties, checks the columns on Monday, creates the 10-minute
 *      trigger (only once) and runs refresh().
 *   4. Deploy -> New deployment -> Web app. Execute as: Me (the shared ops
 *      account). Who has access: Anyone. Put the /exec URL in docs/config.js
 *      (apiUrl).
 *   5. After any code change: Deploy -> Manage deployments -> Edit -> Version:
 *      New version. The trigger always runs the latest saved code, but the web
 *      app runs the deployed version.
 *
 * DESIGN NOTES
 * ------------
 *   "Appendix A" and "Appendix B #n" in the comments below refer to DESIGN.md
 *   in the repo: A lists the Monday API facts verified on a sandbox board,
 *   B the decisions made while building.
 *
 * PRIVACY RULES THIS FILE FOLLOWS
 * -------------------------------
 *   - Only allow-listed columns are requested from Monday, and the page's
 *     answer is built field by field in toApplicantView(), so nothing else can
 *     leak.
 *   - Logs carry counts, unknown board labels and Monday error codes only.
 *   - The browser only ever sees {"found": ...} or {"error": "unavailable"}.
 *
 * APPS SCRIPT NOTES FOR NEWCOMERS
 * -------------------------------
 *   - doGet(e) is the function Apps Script calls for each GET on the web app.
 *   - The services used here are global objects provided by Apps Script:
 *     PropertiesService (settings), CacheService (a shared key/value cache),
 *     LockService (a script-wide mutex), UrlFetchApp (HTTP), Utilities
 *     (hashing, base64, sleep), ContentService (HTTP responses) and ScriptApp
 *     (triggers).
 *   - Functions whose names end in "_" are private: they are hidden from the
 *     editor's Run menu and cannot be called from outside.
 *   - This file has no top-level side effects (only constants and functions),
 *     so the Node tests can load it in a vm context with mocked services. The
 *     syntax stays at ES2017.
 */

// =============================================================================
// 2. Constants
// =============================================================================

// -----------------------------------------------------------------------------
// Boards and columns
// -----------------------------------------------------------------------------

/** Production FA board, "Featured App Submissions". Override with FA_BOARD_ID. */
const DEFAULT_FA_BOARD_ID = '18420896395';

/** Production DVP board, "Asset Moving Status Requests". Override with DVP_BOARD_ID. */
const DEFAULT_DVP_BOARD_ID = '18436778970';

/**
 * FA board columns the portal reads: the allow-list, plus Send Email.
 * STATUS_LINK_COLUMN_ID is added at run time. Nothing else is ever requested.
 */
const FA_COLUMNS = {
  institution: 'text_mm4k2vch',     // Institution (text)
  status: 'color_mm4kmej3',         // FA Status (status), mapped to a state key
  type: 'color_mm4kpp3q',           // Type (status): Non-Issuer / Asset Issuer
  submitted: 'date_mm4kw11a',       // "Time stamp" (date)
  lockVerified: 'date_mm4kpckv',    // Lock verified (date)
  lockedAmount: 'numeric_mm4k6919', // Locked amount (numbers), millions of CC
  testing: 'color_mm6be9ge',        // Testing Process (status)
  partyId: 'long_text_mm4kq322',    // Party ID (long text)
  website: 'link_mm4kmq24',         // Product site (link)
  announcement: 'link_mm6hfp5g',    // "FA Link" (link): sent only when approved
  sendEmail: 'color_mm6eay19'       // Send Email (status): email rule only, never sent to the page
};

/** DVP board columns the portal reads. DVP_LINK_COLUMN_ID is added at run time. */
const DVP_COLUMNS = {
  submitted: 'date_mm8dsx4y',     // Submission Date
  finalApproval: 'date_mm8dm7a0', // Final Approval Date
  requestLink: 'link_mm8rp25j',   // Request Link
  status: 'color_mm8dhgvr'        // Status
};

/** Extra GraphQL selection for the DVP read: how Connect boards cells expose linked item ids. */
const DVP_RELATION_FRAGMENT = '... on BoardRelationValue { linked_item_ids }';

// -----------------------------------------------------------------------------
// Monday API
// -----------------------------------------------------------------------------

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2026-10';

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

const WRITE_CAP_PER_RUN = 200;         // link writes per run; the backfill spreads over runs
const BATCH_SIZE = 20;                 // aliased mutations per request
const EMAIL_BRAKE = 20;                // more qualifying rows than this in one run: no email labels at all
const PAGE_LIMIT = 500;                // items per items_page / next_items_page call (Monday's maximum)
const MAX_PAGES = 50;                  // pagination safety stop (25,000 items)
const MAX_RETRIES = 2;                 // retries per request on HTTP 429 or 5xx
const RETRY_AFTER_MAX_S = 10;          // longest Retry-After honoured, in seconds
const CACHE_TTL_S = 21600;             // 6 hours, CacheService's maximum
const CACHE_PREFIX = 'fa1:';           // cache key prefix; changing it orphans every old shard
const CACHE_VALUE_MAX_BYTES = 100000;  // CacheService allows 100 KB per value
const LOCK_WAIT_MS = 20000;            // doGet waits this long for the lock on a cache miss
const REFRESH_LOCK_WAIT_MS = 5000;     // refresh gives up quickly: the next run is 10 minutes away
const CODE_ATTEMPTS = 5;               // newCode_ tries this many times to avoid a taken code

// Text caps for the applicant view.
const NAME_MAX = 200;        // app name, DVP request name
const INSTITUTION_MAX = 200; // institution
const LABEL_MAX = 200;       // the Type label
const PARTY_ID_MAX = 2000;   // party id
const URL_MAX = 2000;        // website, announcement, DVP request link
const LOG_LABEL_MAX = 60;    // unknown labels as written to the log

// -----------------------------------------------------------------------------
// Labels -> state keys (all wording lives in docs/status.js)
// -----------------------------------------------------------------------------

/** The Status link's link text, and the Send Email label that triggers the email. */
const STATUS_LINK_TEXT = 'Status link';

/** FA Status label -> state. Empty: FA_STATE_EMPTY. Any other label: FA_STATE_UNKNOWN (logged). */
const FA_STATE_BY_LABEL = {
  '0-Locked+Needs Review': 'in_review',
  '1-Needs Review': 'in_review',
  '1b-FAAC Approved-waiting on tokenomics': 'with_tokenomics',
  '2-Approved': 'approved',
  '3-CIP-0116-paused': 'on_hold',
  '4-No': 'not_approved',
  '5-Revoked': 'revoked',
  '6-Withdrawn': 'withdrawn',
  '7-Closed-new-process': 'closed_process'
};
const FA_STATE_EMPTY = 'received';
const FA_STATE_UNKNOWN = 'in_review';

/** Testing Process label -> state. Empty: not_started. Unknown: in_progress (logged). */
const TESTING_STATE_BY_LABEL = {
  'Sent Email': 'action_needed',
  'Pending Review': 'in_progress',
  'Stuck': 'in_progress',
  'Done': 'complete'
};
const TESTING_STATE_EMPTY = 'not_started';
const TESTING_STATE_UNKNOWN = 'in_progress';

/** DVP Status label -> state. The board's label really is spelled "Apporval"; both spellings are accepted. */
const DVP_STATE_BY_LABEL = {
  'New Submission': 'in_review',
  'FAAC Approval': 'with_tokenomics',
  'Tokenomics Apporval': 'approved',
  'Tokenomics Approval': 'approved',
  'Denied': 'not_approved',
  'Closed': 'closed'
};
const DVP_STATE_EMPTY = 'in_review';
const DVP_STATE_UNKNOWN = 'in_review';

// -----------------------------------------------------------------------------
// Codes and formats
// -----------------------------------------------------------------------------

/** A status code: 22 base64url characters (about 132 random bits). */
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const CODE_LENGTH = 22;

/** The 64 base64url characters. A code's first character picks its cache shard. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Monday column ids (e.g. link_mm95vm0) and board ids (digits). */
const COLUMN_ID_RE = /^[A-Za-z0-9_]{1,100}$/;
const BOARD_ID_RE = /^[0-9]{1,20}$/;

/** SITE_URL after normalisation: https, a host, an optional path, no query or fragment. */
const SITE_URL_RE = /^https:\/\/[^\s\/?#@\\]+(\/[^\s?#]*)?$/i;

/** Links sent to the page: https with a host, and no spaces or control characters. */
const HTTPS_URL_RE = /^https:\/\/[^\s\/?#@\\\u0000-\u001f\u007f]+([\/?#][^\s\u0000-\u001f\u007f]*)?$/i;

/** Dates: YYYY-MM-DD at the start of a cell's text, and full ISO timestamps. */
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

/** DVP request reference: "/message/<n>" in the link URL, or a leading "#<n>" in its text. */
const REQUEST_REF_URL_RE = /\/message\/(\d{1,20})/;
const REQUEST_REF_TEXT_RE = /^\s*#(\d{1,20})/;

/** Monday error codes that mean "rate or complexity limit reached: stop for this run". */
const RATE_LIMIT_CODE_RE = /rate.?limit|complexity|budget|concurrency|daily.?limit/i;

/** The "event" field on every log line, to filter the logs. */
const LOG_EVENT = 'fa-status';

// =============================================================================
// 3. Entry points
// =============================================================================

/**
 * Web app entry point: answers one status link for the page.
 *
 * Checks the code's format, looks it up in the cache (rebuilding the cache
 * read-only on a miss, see lookupCode_) and replies with JSON. Error details
 * never reach the browser: any failure becomes {"error": "unavailable"}.
 *
 * @param {Object=} e The request event. It is undefined when the function is
 *     run from the editor. e.parameter.link carries the code.
 * @return {TextOutput} JSON: {found: true, app}, {found: false} or
 *     {error: 'unavailable'}.
 */
function doGet(e) {
  let body;
  try {
    const code = e && e.parameter && typeof e.parameter.link === 'string' ? e.parameter.link : '';
    // A malformed code can never be in the cache, so answer without touching it.
    body = CODE_RE.test(code) ? lookupCode_(code) : { found: false };
  } catch (err) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doGet', error: errorKind_(err) }));
    body = { error: 'unavailable' };
  }
  return jsonOutput_(body);
}

/**
 * The 10-minute job: issues links for FA rows that have none, then rebuilds
 * the cache. Runs from the time-driven trigger that setup() creates.
 *
 * If Monday cannot be read or the cache cannot be written, the run logs its
 * counts with a short error kind and throws a data-free Error, so the
 * execution shows as failed. The previous cache is then left as it was.
 *
 * @return {Object|undefined} The run's stats (counts only; see newStats_), or
 *     undefined when the run was skipped because another run holds the lock
 *     or the Script Properties are incomplete.
 */
function refresh() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(REFRESH_LOCK_WAIT_MS)) {
    console.log(JSON.stringify({ event: LOG_EVENT, mode: 'refresh', skipped: 'lock_busy' }));
    return;
  }
  const started = Date.now();
  const stats = newStats_('refresh');
  try {
    const cfg = readConfig_();
    const problems = validateConfig_(cfg);
    if (problems.length) {
      // Problems name properties, never their values, so they are safe to log.
      console.error(JSON.stringify({ event: LOG_EVENT, mode: 'refresh', error: 'config_invalid', problems: problems }));
      return;
    }
    const built = buildFromMonday_(cfg, { write: true, stats: stats });
    stats.stage = 'write_cache';
    stats.cacheLargestShard = writeCache_(built.views);
    stats.stage = 'done';
    stats.ms = Date.now() - started;
    logRun_(stats);
    return stats;
  } catch (err) {
    stats.ms = Date.now() - started;
    const kind = errorKind_(err);
    logRun_(stats, kind);
    // A fresh Error, so no message from Monday or the runtime ends up in the logs.
    throw new Error('refresh failed: ' + kind);
  } finally {
    lock.releaseLock();
  }
}

/**
 * One-time setup, run by hand from the editor. It:
 *   1. checks the Script Properties;
 *   2. checks on Monday that STATUS_LINK_COLUMN_ID is a Link column on the FA
 *      board, that DVP_LINK_COLUMN_ID (if set) is a Connect boards column on
 *      the DVP board, and, if SEND_LINK_EMAIL is "true", that Send Email has
 *      an active "Status link" label;
 *   3. creates the 10-minute trigger for refresh(), unless one exists;
 *   4. runs refresh() and logs a summary.
 * Safe to run again at any time.
 *
 * @return {Object|undefined} The stats of the refresh() it ran, or undefined
 *     if that run was skipped.
 * @throws {Error} Listing what to fix (property names, never values).
 */
function setup() {
  const cfg = readConfig_();
  const problems = validateConfig_(cfg).concat(emailConfigProblems_(cfg));
  if (problems.length) {
    throw new Error('Fix these Script Properties, then run setup again: ' + problems.join('; '));
  }
  const check = checkMondaySetup_(cfg);
  if (check.problems.length) {
    throw new Error('Fix these, then run setup again: ' + check.problems.join('; '));
  }
  const triggerCreated = ensureRefreshTrigger_();
  const stats = refresh();
  console.log(JSON.stringify({
    event: LOG_EVENT,
    mode: 'setup',
    triggerCreated: triggerCreated,
    emailOn: cfg.sendLinkEmail,
    dvpOn: cfg.dvpLinkColumnId !== '',
    missingColumns: check.missingColumns, // column ids only: warnings, not errors
    refreshed: Boolean(stats),
    faRows: stats ? stats.faRows : 0,
    served: stats ? stats.served : 0,
    linksWritten: stats ? stats.linksWritten : 0
  }));
  return stats;
}

// -----------------------------------------------------------------------------
// Entry-point helpers
// -----------------------------------------------------------------------------

/**
 * Looks one code up in the cache. On a miss (Appendix B #9): takes the script
 * lock, reads the shard again, and if it is still missing rebuilds the cache
 * from Monday in read-only mode. Without the lock it reads the shard once
 * more and otherwise gives up.
 *
 * @param {string} code A code that already matched CODE_RE.
 * @return {Object} {found: true, app}, {found: false} or {error: 'unavailable'}.
 */
function lookupCode_(code) {
  const shard = readShard_(code);
  if (shard) return answerFromMap_(shard, code);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    // Someone else (refresh, or another request) is busy; one more look, then give up.
    const again = readShard_(code);
    if (again) return answerFromMap_(again, code);
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doGet', error: 'lock_busy' }));
    return { error: 'unavailable' };
  }
  try {
    const filled = readShard_(code);
    if (filled) return answerFromMap_(filled, code);
    const views = rebuildReadOnly_();
    return views ? answerFromMap_(views, code) : { error: 'unavailable' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rebuilds the whole cache from Monday without writing anything to Monday:
 * no codes are issued, no links or labels are written. Rows without a saved
 * code are simply not served. The caller must hold the script lock.
 *
 * @return {?Object<string, Object>} The views (code -> app), or null when the
 *     Script Properties are incomplete.
 */
function rebuildReadOnly_() {
  const started = Date.now();
  const cfg = readConfig_();
  const problems = validateConfig_(cfg);
  if (problems.length) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'rebuild', error: 'config_invalid', problems: problems }));
    return null;
  }
  const stats = newStats_('rebuild');
  const built = buildFromMonday_(cfg, { write: false, stats: stats });
  stats.cacheLargestShard = writeCache_(built.views);
  stats.stage = 'done';
  stats.ms = Date.now() - started;
  logRun_(stats);
  return built.views;
}

/**
 * Builds the answer for one code from a map of code -> app (a cache shard,
 * or the views of a rebuild).
 *
 * @param {Object<string, Object>} map Code -> app object.
 * @param {string} code The code asked for.
 * @return {Object} {found: true, app} or {found: false}.
 */
function answerFromMap_(map, code) {
  const app = hasOwn_(map, code) ? map[code] : null;
  return app && typeof app === 'object' ? { found: true, app: app } : { found: false };
}

/**
 * Wraps an object as a JSON response for the web app.
 *
 * @param {Object} body The object to send.
 * @return {TextOutput} The JSON text output.
 */
function jsonOutput_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * setup() helper: checks the configured columns on Monday.
 *
 * @param {Object} cfg Config from readConfig_().
 * @return {{problems: Array<string>, missingColumns: {fa: Array<string>, dvp: Array<string>}}}
 *     Problems that must be fixed, plus allow-listed column ids that were not
 *     found (warnings only: those fields will read as null).
 */
function checkMondaySetup_(cfg) {
  const problems = [];
  const missingColumns = { fa: [], dvp: [] };

  let faColumns;
  try {
    faColumns = readColumns_(cfg, cfg.faBoardId, faReadColumnIds_(cfg));
  } catch (err) {
    problems.push('could not read the FA board (' + errorKind_(err) + '): check MONDAY_API_TOKEN and FA_BOARD_ID');
    return { problems: problems, missingColumns: missingColumns };
  }
  const linkColumn = findColumn_(faColumns, cfg.statusLinkColumnId);
  if (!linkColumn) {
    problems.push('STATUS_LINK_COLUMN_ID does not name a column on the FA board');
  } else if (linkColumn.type !== 'link') {
    problems.push('STATUS_LINK_COLUMN_ID names a column that is not a Link column');
  }
  if (cfg.sendLinkEmail && !hasActiveLabel_(findColumn_(faColumns, FA_COLUMNS.sendEmail), STATUS_LINK_TEXT)) {
    problems.push('SEND_LINK_EMAIL is "true" but the Send Email column has no active "Status link" label');
  }
  missingColumns.fa = faReadColumnIds_(cfg).filter((id) => id !== cfg.statusLinkColumnId && !findColumn_(faColumns, id));

  if (cfg.dvpLinkColumnId) {
    try {
      const dvpColumns = readColumns_(cfg, cfg.dvpBoardId, dvpReadColumnIds_(cfg));
      const relation = findColumn_(dvpColumns, cfg.dvpLinkColumnId);
      if (!relation) {
        problems.push('DVP_LINK_COLUMN_ID does not name a column on the DVP board');
      } else if (relation.type !== 'board_relation') {
        problems.push('DVP_LINK_COLUMN_ID names a column that is not a Connect boards column');
      }
      missingColumns.dvp = dvpReadColumnIds_(cfg).filter((id) => id !== cfg.dvpLinkColumnId && !findColumn_(dvpColumns, id));
    } catch (err) {
      problems.push('could not read the DVP board (' + errorKind_(err) + '): check DVP_BOARD_ID');
    }
  }
  return { problems: problems, missingColumns: missingColumns };
}

/**
 * setup() helper: creates the 10-minute trigger for refresh(), unless a
 * trigger for refresh() already exists.
 *
 * @return {boolean} True when a trigger was created.
 */
function ensureRefreshTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refresh') return false;
  }
  ScriptApp.newTrigger('refresh').timeBased().everyMinutes(10).create();
  return true;
}

// =============================================================================
// 4. Configuration
// =============================================================================

/**
 * Reads the Script Properties into a plain config object. Values are trimmed;
 * missing ones become ''. Nothing is validated here (see validateConfig_).
 *
 * @return {{token: string, statusLinkColumnId: string, siteUrl: string,
 *     sendLinkEmail: boolean, emailNewRowsFrom: ?number, faBoardId: string,
 *     dvpBoardId: string, dvpLinkColumnId: string}} siteUrl is normalised;
 *     sendLinkEmail is true only for the exact value "true"; emailNewRowsFrom
 *     is in epoch milliseconds, or null when unset or not a date.
 */
function readConfig_() {
  const store = PropertiesService.getScriptProperties();
  // getProperties() reads everything in one service call; getProperty() is the fallback.
  const all = typeof store.getProperties === 'function' ? store.getProperties() || {} : null;
  const get = (key) => {
    const value = all ? all[key] : store.getProperty(key);
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    token: get('MONDAY_API_TOKEN'),
    statusLinkColumnId: get('STATUS_LINK_COLUMN_ID'),
    siteUrl: normaliseSiteUrl_(get('SITE_URL')),
    sendLinkEmail: get('SEND_LINK_EMAIL') === 'true',
    emailNewRowsFrom: parseIsoMs_(get('EMAIL_NEW_ROWS_FROM')),
    faBoardId: get('FA_BOARD_ID') || DEFAULT_FA_BOARD_ID,
    dvpBoardId: get('DVP_BOARD_ID') || DEFAULT_DVP_BOARD_ID,
    dvpLinkColumnId: get('DVP_LINK_COLUMN_ID')
  };
}

/**
 * Normalises SITE_URL (Appendix B #4): it must end in "/" unless it ends in
 * ".html", so that SITE_URL + "#" + code is always a valid link.
 *
 * @param {string} url The trimmed SITE_URL ('' when unset).
 * @return {string} The normalised URL ('' stays '').
 */
function normaliseSiteUrl_(url) {
  if (!url || /\.html$/i.test(url) || url.charAt(url.length - 1) === '/') return url;
  return url + '/';
}

/**
 * Checks the config. refresh() logs the problems and stops, doGet answers
 * "unavailable", and setup() throws them.
 *
 * @param {Object} cfg Config from readConfig_().
 * @return {Array<string>} Problem descriptions that name properties, never
 *     their values. Empty when the config is usable.
 */
function validateConfig_(cfg) {
  const problems = [];
  if (!cfg.token) problems.push('MONDAY_API_TOKEN is not set');

  if (!cfg.statusLinkColumnId) {
    problems.push('STATUS_LINK_COLUMN_ID is not set');
  } else if (!COLUMN_ID_RE.test(cfg.statusLinkColumnId)) {
    problems.push('STATUS_LINK_COLUMN_ID is not a valid column id');
  } else if (faReadColumnIds_(null).indexOf(cfg.statusLinkColumnId) !== -1) {
    // Codes go into empty cells: pointing this at, say, Product site would fill it with links.
    problems.push('STATUS_LINK_COLUMN_ID must be the new Status link column, not a column the portal already reads');
  }

  if (!cfg.siteUrl) {
    problems.push('SITE_URL is not set');
  } else if (!SITE_URL_RE.test(cfg.siteUrl)) {
    problems.push('SITE_URL must be an https:// address without spaces, "?" or "#"');
  }

  if (!BOARD_ID_RE.test(cfg.faBoardId)) problems.push('FA_BOARD_ID must be a numeric board id');
  if (!BOARD_ID_RE.test(cfg.dvpBoardId)) problems.push('DVP_BOARD_ID must be a numeric board id');
  if (cfg.faBoardId === cfg.dvpBoardId) problems.push('FA_BOARD_ID and DVP_BOARD_ID must be different boards');

  if (cfg.dvpLinkColumnId) {
    if (!COLUMN_ID_RE.test(cfg.dvpLinkColumnId)) {
      problems.push('DVP_LINK_COLUMN_ID is not a valid column id');
    } else if (dvpReadColumnIds_(null).indexOf(cfg.dvpLinkColumnId) !== -1) {
      problems.push('DVP_LINK_COLUMN_ID must be the Connect boards column, not a column the portal already reads');
    }
  }
  return problems;
}

/**
 * Email settings that setup() insists on. refresh() does not stop for these:
 * it writes links without the email label and records 'email_from_invalid'.
 *
 * @param {Object} cfg Config from readConfig_().
 * @return {Array<string>} Problem descriptions (property names only).
 */
function emailConfigProblems_(cfg) {
  if (cfg.sendLinkEmail && cfg.emailNewRowsFrom === null) {
    return ['EMAIL_NEW_ROWS_FROM must be an ISO date such as 2026-12-01 while SEND_LINK_EMAIL is "true"'];
  }
  return [];
}

// =============================================================================
// 5. Monday client
// =============================================================================

/**
 * Sends one GraphQL request to Monday.
 *
 * It retries at most MAX_RETRIES times on HTTP 429 or 5xx, honouring
 * Retry-After up to RETRY_AFTER_MAX_S seconds (Appendix B #6). It never logs:
 * not the token, not the query, and not Monday's error messages, which can
 * echo column values.
 *
 * @param {Object} cfg Config from readConfig_() (for the token).
 * @param {string} query The GraphQL query or mutation.
 * @param {Object=} variables GraphQL variables.
 * @return {{data: ?Object, errors: Array<Object>, httpStatus: number,
 *     rateLimited: boolean}} httpStatus is 0 when the request could not be
 *     made at all. rateLimited is true on HTTP 429 or a rate, complexity or
 *     concurrency error code.
 */
function mondayRequest_(cfg, query, variables) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': cfg.token, 'API-Version': MONDAY_API_VERSION },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true // let the code read 4xx/5xx answers instead of throwing
  };

  let response = null;
  let attempt = 0;
  while (true) {
    try {
      response = UrlFetchApp.fetch(MONDAY_API_URL, options);
    } catch (err) {
      // Network-level failure (DNS, timeout...). Its message is deliberately dropped.
      return { data: null, errors: [], httpStatus: 0, rateLimited: false };
    }
    const status = response.getResponseCode();
    const retryable = status === 429 || status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) break;
    attempt++;
    Utilities.sleep(retryDelayMs_(response, attempt));
  }

  const httpStatus = response.getResponseCode();
  const body = parseJson_(contentText_(response));
  const data = body && body.data && typeof body.data === 'object' ? body.data : null;
  const errors = body && Array.isArray(body.errors) ? body.errors.slice() : [];
  if (body && typeof body.error_code === 'string') {
    // Older error format: fold it into errors[] so callers look in one place.
    errors.push({ extensions: { code: body.error_code } });
  }
  const rateLimited = httpStatus === 429 || errors.some((error) => RATE_LIMIT_CODE_RE.test(errorCodeOf_(error)));
  return { data: data, errors: errors, httpStatus: httpStatus, rateLimited: rateLimited };
}

/**
 * How long to wait before retrying a request: Retry-After (seconds) capped at
 * RETRY_AFTER_MAX_S, or 1 s then 2 s when the header is absent.
 *
 * @param {HTTPResponse} response The 429 or 5xx response.
 * @param {number} attempt The retry about to be made (1 or 2).
 * @return {number} Milliseconds to sleep.
 */
function retryDelayMs_(response, attempt) {
  const header = headerValue_(response, 'retry-after');
  const seconds = Number(header);
  if (header !== '' && isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, RETRY_AFTER_MAX_S) * 1000;
  }
  return 1000 * attempt;
}

/**
 * Reads a response header without caring about its case.
 *
 * @param {HTTPResponse} response The response.
 * @param {string} name Lower-case header name.
 * @return {string} The trimmed value, or '' when absent.
 */
function headerValue_(response, name) {
  const headers = typeof response.getHeaders === 'function' ? response.getHeaders() || {} : {};
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name) return String(headers[keys[i]]).trim();
  }
  return '';
}

/**
 * Reads a response body without letting an odd body throw.
 *
 * @param {HTTPResponse} response The response.
 * @return {string} The body text, or '' when it cannot be read.
 */
function contentText_(response) {
  try {
    return String(response.getContentText());
  } catch (err) {
    return '';
  }
}

/**
 * Extracts the machine-readable code from one GraphQL error. Only this code
 * is ever logged; the message is not.
 *
 * @param {Object} error One entry of errors[].
 * @return {string} extensions.code (or extensions.error_code), or ''.
 */
function errorCodeOf_(error) {
  const ext = error && typeof error === 'object' && error.extensions && typeof error.extensions === 'object' ? error.extensions : null;
  if (ext && typeof ext.code === 'string') return ext.code;
  if (ext && typeof ext.error_code === 'string') return ext.error_code;
  return '';
}

/**
 * Throws a data-free Error unless a read request fully succeeded. Reads are
 * all or nothing: a partial board must never replace a good cache.
 *
 * @param {Object} res Result of mondayRequest_().
 * @throws {Error} With kind monday_rate_limited, monday_unauthorized,
 *     monday_error:<code> or monday_http_<status>.
 */
function assertRead_(res) {
  if (res.httpStatus === 200 && res.data && res.errors.length === 0) return;
  if (res.rateLimited) throw fail_('monday_rate_limited');
  if (res.httpStatus === 401 || res.httpStatus === 403) throw fail_('monday_unauthorized');
  const code = res.errors.length ? errorCodeOf_(res.errors[0]) : '';
  throw fail_(code ? 'monday_error:' + safeCode_(code) : 'monday_http_' + res.httpStatus);
}

/**
 * Reads every item of a board: items_page first, then next_items_page until
 * the cursor is null (PAGE_LIMIT items per call).
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} boardId The board to read.
 * @param {Array<string>} columnIds The only column ids to request.
 * @param {string=} fragmentSuffix Extra selection inside column_values, e.g.
 *     DVP_RELATION_FRAGMENT.
 * @param {string=} itemFields Item fields to request; defaults to 'id name'.
 *     The FA read passes 'id name created_at'.
 * @return {Array<Object>} Raw items: {id, name, created_at?, column_values:
 *     [{id, type, text, value, linked_item_ids?}]}.
 * @throws {Error} When any page cannot be read (see assertRead_), when the
 *     board is not found, or after MAX_PAGES pages.
 */
function readItems_(cfg, boardId, columnIds, fragmentSuffix, itemFields) {
  const fields = (itemFields || 'id name') +
      ' column_values(ids: $c) { id type text value ' + (fragmentSuffix || '') + ' }';
  const firstQuery = 'query ($b: ID!, $c: [String!], $l: Int!) { boards(ids: [$b]) { ' +
      'items_page(limit: $l) { cursor items { ' + fields + ' } } } }';
  const nextQuery = 'query ($cur: String!, $c: [String!], $l: Int!) { ' +
      'next_items_page(cursor: $cur, limit: $l) { cursor items { ' + fields + ' } } }';

  let res = mondayRequest_(cfg, firstQuery, { b: String(boardId), c: columnIds, l: PAGE_LIMIT });
  assertRead_(res);
  const boards = res.data.boards;
  if (!Array.isArray(boards) || !boards.length || !boards[0] || !boards[0].items_page) {
    throw fail_('monday_board_not_found');
  }

  const items = [];
  let page = boards[0].items_page;
  for (let pages = 1; ; pages++) {
    (Array.isArray(page.items) ? page.items : []).forEach((item) => items.push(item));
    if (!page.cursor) break;
    if (pages >= MAX_PAGES) throw fail_('monday_too_many_pages');
    res = mondayRequest_(cfg, nextQuery, { cur: page.cursor, c: columnIds, l: PAGE_LIMIT });
    assertRead_(res);
    page = res.data.next_items_page;
    if (!page) throw fail_('monday_read_failed');
  }
  return items;
}

/**
 * Reads column definitions (id, type, settings) from a board. Status column
 * settings list the labels in settings.labels[] ({label, is_deactivated}).
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} boardId The board.
 * @param {Array<string>} columnIds Column ids to look up. Unknown ids are
 *     simply absent from the result.
 * @return {Array<{id: string, type: string, settings: ?Object}>} One entry
 *     per column found.
 * @throws {Error} When the request fails or the board is not found.
 */
function readColumns_(cfg, boardId, columnIds) {
  const query = 'query ($b: ID!, $c: [String!]) { boards(ids: [$b]) { columns(ids: $c) { id type settings } } }';
  const res = mondayRequest_(cfg, query, { b: String(boardId), c: columnIds });
  assertRead_(res);
  const boards = res.data.boards;
  if (!Array.isArray(boards) || !boards.length || !boards[0]) throw fail_('monday_board_not_found');
  const columns = Array.isArray(boards[0].columns) ? boards[0].columns : [];
  return columns.filter((column) => column && typeof column === 'object').map((column) => ({
    id: column.id,
    type: column.type,
    settings: parseValue_(column.settings) // a JSON object; parsed in case it comes as a string
  }));
}

/**
 * Finds a column by id in the result of readColumns_().
 *
 * @param {Array<Object>} columns Columns from readColumns_().
 * @param {string} id Column id.
 * @return {?Object} The column, or null.
 */
function findColumn_(columns, id) {
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].id === id) return columns[i];
  }
  return null;
}

/**
 * Tells whether a status column has a given label that is not deactivated.
 * Handles the current settings shape (labels: [{label, is_deactivated}]) and
 * the older one (labels: {index: text}, deactivated_labels: [index]).
 *
 * @param {?Object} column A column from readColumns_().
 * @param {string} label The label text, e.g. 'Status link'.
 * @return {boolean} True when the label exists and is active.
 */
function hasActiveLabel_(column, label) {
  const settings = column && column.settings && typeof column.settings === 'object' ? column.settings : null;
  if (!settings || !settings.labels) return false;
  const labels = settings.labels;
  if (Array.isArray(labels)) {
    return labels.some((entry) => entry && typeof entry.label === 'string' &&
        entry.label.trim() === label && !entry.is_deactivated);
  }
  if (typeof labels === 'object') {
    const off = Array.isArray(settings.deactivated_labels) ? settings.deactivated_labels.map(String) : [];
    return Object.keys(labels).some((index) => typeof labels[index] === 'string' &&
        labels[index].trim() === label && off.indexOf(String(index)) === -1);
  }
  return false;
}

/**
 * Writes column values to many items of one board, BATCH_SIZE aliased
 * mutations per request:
 *
 *   mutation ($b: ID!, $i0: ID!, $v0: JSON!, $i1: ID!, $v1: JSON!, ...) {
 *     w0: change_multiple_column_values(board_id: $b, item_id: $i0, column_values: $v0) { id }
 *     w1: ...
 *   }
 *
 * Each $vN is the JSON-encoded column values. Monday answers HTTP 200 even
 * when some aliases fail; a failed alias has data.wN = null and an error whose
 * path[0] is "wN". Labels are never created: create_labels_if_missing is left
 * at its default (false).
 *
 * After a request that is rate limited, or that fails outright even after the
 * retries, no further batches are sent. Their items are reported as
 * 'not_sent', and the next run carries on.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} boardId The board the items belong to.
 * @param {Array<{itemId: string, values: Object}>} writes Column id -> value,
 *     per item.
 * @return {{results: Array<{itemId: string, ok: boolean, errorCode: ?string,
 *     missingLabel: boolean}>, rateLimited: boolean, stopped: boolean}} One
 *     result per write, in the same order as writes.
 */
function writeColumnBatches_(cfg, boardId, writes) {
  const results = [];
  let rateLimited = false;
  let stopped = false;

  for (let start = 0; start < writes.length; start += BATCH_SIZE) {
    const batch = writes.slice(start, start + BATCH_SIZE);
    if (stopped) {
      batch.forEach((write) => results.push(writeResult_(write.itemId, false, 'not_sent', false)));
      continue;
    }

    const variables = { b: String(boardId) };
    batch.forEach((write, n) => {
      variables['i' + n] = String(write.itemId);
      variables['v' + n] = JSON.stringify(write.values); // JSON variables travel as JSON-encoded strings
    });
    const res = mondayRequest_(cfg, writeMutation_(batch.length), variables);
    const data = res.httpStatus === 200 && res.data ? res.data : null;
    if (res.rateLimited) rateLimited = true;
    if (res.rateLimited || !data) stopped = true;

    // The code for aliases that failed without an error of their own.
    const requestCode = res.rateLimited ? 'rate_limited'
        : firstUnpathedCode_(res.errors) || (data ? 'no_result' : 'http_' + res.httpStatus);

    batch.forEach((write, n) => {
      const alias = 'w' + n;
      const aliasError = errorForAlias_(res.errors, alias);
      if (data && data[alias] && !aliasError) {
        results.push(writeResult_(write.itemId, true, null, false));
      } else {
        const code = aliasError ? safeCode_(errorCodeOf_(aliasError)) : requestCode;
        results.push(writeResult_(write.itemId, false, code, isMissingLabel_(aliasError)));
      }
    });
  }
  return { results: results, rateLimited: rateLimited, stopped: stopped };
}

/**
 * Builds the aliased mutation text for a batch of the given size.
 *
 * @param {number} count Number of items in the batch (1..BATCH_SIZE).
 * @return {string} The GraphQL mutation.
 */
function writeMutation_(count) {
  const params = ['$b: ID!'];
  const fields = [];
  for (let n = 0; n < count; n++) {
    params.push('$i' + n + ': ID!', '$v' + n + ': JSON!');
    fields.push('w' + n + ': change_multiple_column_values(board_id: $b, item_id: $i' + n +
        ', column_values: $v' + n + ') { id }');
  }
  return 'mutation (' + params.join(', ') + ') { ' + fields.join(' ') + ' }';
}

/**
 * Makes one per-item write result.
 *
 * @param {string} itemId The item.
 * @param {boolean} ok Whether Monday saved the values.
 * @param {?string} errorCode Monday's extensions.code, or our own code
 *     ('not_sent', 'rate_limited', 'http_<status>', 'no_result').
 * @param {boolean} missingLabel Whether the failure was a missing status label.
 * @return {{itemId: string, ok: boolean, errorCode: ?string, missingLabel: boolean}}
 */
function writeResult_(itemId, ok, errorCode, missingLabel) {
  return { itemId: String(itemId), ok: ok, errorCode: errorCode, missingLabel: missingLabel };
}

/**
 * Finds the error that belongs to one alias (error.path[0] === alias).
 *
 * @param {Array<Object>} errors errors[] from the response.
 * @param {string} alias E.g. 'w3'.
 * @return {?Object} The error, or null.
 */
function errorForAlias_(errors, alias) {
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i];
    if (error && Array.isArray(error.path) && error.path[0] === alias) return error;
  }
  return null;
}

/**
 * The code of the first error that is not tied to an alias (a request-level
 * error), if any.
 *
 * @param {Array<Object>} errors errors[] from the response.
 * @return {string} A sanitised code, or ''.
 */
function firstUnpathedCode_(errors) {
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i];
    if (!(error && Array.isArray(error.path) && error.path.length)) {
      const code = errorCodeOf_(error);
      return code ? safeCode_(code) : '';
    }
  }
  return '';
}

/**
 * Tells whether an error is Monday's "status label does not exist" error
 * (ColumnValueException with column_validation_error_code "missingLabel").
 *
 * @param {?Object} error One entry of errors[], or null.
 * @return {boolean} True for a missing-label error.
 */
function isMissingLabel_(error) {
  const ext = error && error.extensions;
  const data = ext && ext.error_data;
  return Boolean(data && data.column_validation_error_code === 'missingLabel');
}

// =============================================================================
// 6. Links
// =============================================================================

/**
 * Makes a new status code: the first 22 characters of the base64url SHA-256
 * of two random UUIDs (about 132 bits). It tries again in the
 * astronomically unlikely case that the code is already taken.
 *
 * @param {Object<string, boolean>|Set<string>} taken Codes already in use.
 *     Not modified: the caller records the new code.
 * @return {string} A code matching CODE_RE.
 * @throws {Error} 'code_generation_failed' if CODE_ATTEMPTS tries all fail.
 */
function newCode_(taken) {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        Utilities.getUuid() + Utilities.getUuid(),
        Utilities.Charset.UTF_8);
    const code = Utilities.base64EncodeWebSafe(digest).slice(0, CODE_LENGTH);
    if (CODE_RE.test(code) && !isTaken_(taken, code)) return code;
  }
  throw fail_('code_generation_failed');
}

/**
 * Checks a code against a set of taken codes (a plain object or a Set).
 *
 * @param {Object<string, boolean>|Set<string>} taken Codes in use.
 * @param {string} code The candidate code.
 * @return {boolean} True when the code is already in use.
 */
function isTaken_(taken, code) {
  if (!taken) return false;
  if (typeof taken.has === 'function') return taken.has(code);
  return hasOwn_(taken, code);
}

/**
 * Reads the code out of a Status link cell (Appendix B #2): take value.url,
 * then the part after '#', then drop anything after a '/'.
 *
 * @param {?Object} column The raw Status link column value {id, type, text, value}.
 * @return {?string} The code when it matches CODE_RE; '' when the cell is
 *     empty (it gets a new code); null when the cell is not empty but cannot
 *     be read, or the column is missing or is not a link column. A null cell
 *     is never overwritten.
 */
function codeFromCell_(column) {
  if (!column || typeof column !== 'object') return null;
  if (column.type && column.type !== 'link') return null;
  if (isEmptyLinkCell_(column)) return '';
  const value = parseValue_(column.value);
  const url = value && typeof value === 'object' ? trimmed_(value.url) : '';
  const hash = url.indexOf('#');
  if (hash === -1) return null;
  const code = url.slice(hash + 1).split('/')[0];
  return CODE_RE.test(code) ? code : null;
}

/**
 * Tells whether a link cell is empty: no text, and a value that is null or
 * has neither a url nor a text. An unparseable value counts as NOT empty, so
 * it is never overwritten.
 *
 * @param {Object} column A raw link column value.
 * @return {boolean} True when the cell is empty.
 */
function isEmptyLinkCell_(column) {
  if (trimmed_(column.text)) return false;
  const raw = column.value;
  if (raw === null || raw === undefined || raw === '' || raw === 'null') return true;
  const value = parseValue_(raw);
  return Boolean(value) && typeof value === 'object' && !trimmed_(value.url) && !trimmed_(value.text);
}

/**
 * The Status link value for a code (Appendix B #4).
 *
 * @param {Object} cfg Config from readConfig_() (siteUrl is normalised).
 * @param {string} code The code.
 * @return {{url: string, text: string}} {url: SITE_URL + '#' + code, text: 'Status link'}.
 */
function linkFor_(cfg, code) {
  return { url: cfg.siteUrl + '#' + code, text: STATUS_LINK_TEXT };
}

/**
 * The column values written for one row: the link, plus the Send Email label
 * when the row's link should be emailed.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} code The new code.
 * @param {boolean} withLabel Also set Send Email to "Status link".
 * @return {Object} Column id -> value, ready for change_multiple_column_values.
 */
function linkValues_(cfg, code, withLabel) {
  const values = {};
  values[cfg.statusLinkColumnId] = linkFor_(cfg, code);
  if (withLabel) values[FA_COLUMNS.sendEmail] = { label: STATUS_LINK_TEXT };
  return values;
}

// =============================================================================
// 7. Views
// =============================================================================

// -----------------------------------------------------------------------------
// Small parsers for raw Monday column values ({id, type, text, value}).
// "value" arrives as a JSON string, e.g. '{"date":"2026-10-18"}' or '"1.5"'.
// -----------------------------------------------------------------------------

/**
 * Indexes an item's column values by column id.
 *
 * @param {Object} row A raw Monday item.
 * @return {Object<string, Object>} Column id -> raw column value.
 */
function columnMap_(row) {
  const map = {};
  const list = row && Array.isArray(row.column_values) ? row.column_values : [];
  list.forEach((column) => {
    if (column && typeof column.id === 'string' && !hasOwn_(map, column.id)) map[column.id] = column;
  });
  return map;
}

/**
 * JSON.parse that returns null instead of throwing. Parse errors can quote the
 * input, so they must never reach a log.
 *
 * @param {*} text Text to parse.
 * @return {*} The parsed value, or null.
 */
function parseJson_(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/**
 * Parses a column's "value" field. It is normally a JSON string, but an
 * already-parsed value is accepted too.
 *
 * @param {*} raw The value field.
 * @return {*} The parsed value, or null when empty or unparseable.
 */
function parseValue_(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  return typeof raw === 'string' ? parseJson_(raw) : raw;
}

/**
 * Trims a string; anything else becomes ''.
 *
 * @param {*} value Anything.
 * @return {string} The trimmed string, or ''.
 */
function trimmed_(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A status column's label. Monday sends null when the status is empty.
 *
 * @param {?Object} column Raw status column value.
 * @return {?string} The trimmed label, or null when empty.
 */
function statusText_(column) {
  const text = column ? trimmed_(column.text) : '';
  return text || null;
}

/**
 * A text column's text (from text, or else from the JSON-string value).
 *
 * @param {?Object} column Raw text column value.
 * @return {string} The text, or ''.
 */
function textOf_(column) {
  if (!column) return '';
  const text = trimmed_(column.text);
  if (text) return text;
  const value = parseValue_(column.value);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A long text column's text (from text, or else from value.text).
 *
 * @param {?Object} column Raw long_text column value.
 * @return {string} The text, or ''.
 */
function longTextOf_(column) {
  if (!column) return '';
  const text = trimmed_(column.text);
  if (text) return text;
  const value = parseValue_(column.value);
  return value && typeof value === 'object' ? trimmed_(value.text) : '';
}

/**
 * A date column's date: value.date, or else a YYYY-MM-DD text. Any time part
 * is ignored.
 *
 * @param {?Object} column Raw date column value.
 * @return {?string} 'YYYY-MM-DD', or null.
 */
function dateOf_(column) {
  if (!column) return null;
  const value = parseValue_(column.value);
  const candidates = [value && typeof value === 'object' ? value.date : null, column.text];
  for (let i = 0; i < candidates.length; i++) {
    const match = DATE_PREFIX_RE.exec(trimmed_(candidates[i]));
    if (match && isIsoDate_(match[1])) return match[1];
  }
  return null;
}

/**
 * Tells whether a string is a real calendar date in YYYY-MM-DD form.
 *
 * @param {string} text The candidate.
 * @return {boolean} True for e.g. '2026-10-18'; false for '2026-02-30'.
 */
function isIsoDate_(text) {
  if (!ISO_DATE_RE.test(text)) return false;
  const ms = Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)));
  return new Date(ms).toISOString().slice(0, 10) === text;
}

/**
 * Parses an ISO date ('2026-11-16', taken as UTC midnight) or timestamp
 * ('2026-11-16T12:52:32Z'; one without a zone is taken as UTC).
 *
 * @param {*} text The candidate.
 * @return {?number} Epoch milliseconds, or null.
 */
function parseIsoMs_(text) {
  const t = trimmed_(text);
  if (!t) return null;
  if (isIsoDate_(t)) {
    return Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)));
  }
  const m = ISO_DATETIME_RE.exec(t);
  if (!m || !isIsoDate_(m[1])) return null;
  // Rebuild a strict ISO string: seconds present, milliseconds at most 3 digits, explicit zone.
  let zone = (m[4] || 'Z').toUpperCase();
  if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
  const iso = m[1] + 'T' + m[2] + (m[2].length === 5 ? ':00' : '') +
      (m[3] ? '.' + (m[3] + '00').slice(0, 3) : '') + zone;
  const ms = Date.parse(iso);
  return isFinite(ms) ? ms : null;
}

/**
 * A numbers column's value: from the JSON-string value (e.g. '"1.5"'), or
 * else from the text.
 *
 * @param {?Object} column Raw numbers column value.
 * @return {?number} A finite number, or null.
 */
function numberOf_(column) {
  if (!column) return null;
  const candidates = [parseValue_(column.value), column.text];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (typeof candidate === 'number' && isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const n = Number(candidate.trim());
      if (isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * A link column's url and text. The url is always taken from value.url (the
 * text field mixes text and url).
 *
 * @param {?Object} column Raw link column value.
 * @return {{url: string, text: string}} '' for missing parts.
 */
function linkOf_(column) {
  if (!column) return { url: '', text: '' };
  const value = parseValue_(column.value);
  const object = value && typeof value === 'object' ? value : {};
  return {
    url: trimmed_(object.url),
    text: typeof object.text === 'string' ? object.text.trim() : trimmed_(column.text)
  };
}

/**
 * When a column last changed, from value.changed_at.
 *
 * @param {?Object} column Raw column value.
 * @return {?number} Epoch milliseconds, or null.
 */
function changedAtMs_(column) {
  const value = column ? parseValue_(column.value) : null;
  return value && typeof value === 'object' ? parseIsoMs_(value.changed_at) : null;
}

/**
 * The latest changed_at among some columns, as a UTC date.
 *
 * @param {Array<?Object>} columns Raw column values (missing ones allowed).
 * @return {?string} 'YYYY-MM-DD', or null when none has a changed_at.
 */
function latestChangeDate_(columns) {
  let latest = null;
  columns.forEach((column) => {
    const ms = changedAtMs_(column);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  });
  return latest === null ? null : new Date(latest).toISOString().slice(0, 10);
}

/**
 * Lets a URL through only if it is https with a host, has no spaces or
 * control characters, and is at most URL_MAX characters long.
 *
 * @param {*} url The candidate.
 * @return {?string} The URL, or null.
 */
function httpsUrl_(url) {
  const u = trimmed_(url);
  if (!u || u.length > URL_MAX) return null;
  return HTTPS_URL_RE.test(u) ? u : null;
}

/**
 * Trims a text and caps its length, without cutting a surrogate pair in half.
 *
 * @param {*} text The candidate.
 * @param {number} max The maximum length.
 * @return {?string} The capped text, or null when empty.
 */
function capText_(text, max) {
  let t = trimmed_(text);
  if (!t) return null;
  if (t.length > max) {
    t = t.slice(0, max);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  }
  return t;
}

/**
 * The DVP request reference: the digits of "/message/<n>" in the link URL,
 * or else of a leading "#<n>" in the link text.
 *
 * @param {string} url The Request Link url (raw).
 * @param {string} text The Request Link text.
 * @return {?string} The digits, or null.
 */
function requestRef_(url, text) {
  const fromUrl = REQUEST_REF_URL_RE.exec(url || '');
  if (fromUrl) return fromUrl[1];
  const fromText = REQUEST_REF_TEXT_RE.exec(text || '');
  return fromText ? fromText[1] : null;
}

/**
 * hasOwnProperty that is safe for any object. Label maps are plain objects,
 * so a label like "toString" must not hit Object.prototype.
 *
 * @param {Object} object The object.
 * @param {string} key The key.
 * @return {boolean} True for an own property.
 */
function hasOwn_(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// -----------------------------------------------------------------------------
// Labels -> state keys
// -----------------------------------------------------------------------------

/**
 * Maps the FA Status label to a state key. Empty: 'received'. An unknown
 * label is treated as 'in_review' and counted in stats.unknownLabels.fa.
 *
 * @param {?string} label The label (null when empty).
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {string} The state key.
 */
function faState_(label, stats) {
  return stateFor_(label, FA_STATE_BY_LABEL, FA_STATE_EMPTY, FA_STATE_UNKNOWN, stats, 'fa');
}

/**
 * Maps the Testing Process label to a testing key. Empty: 'not_started'. An
 * unknown label is treated as 'in_progress' and counted.
 *
 * @param {?string} label The label (null when empty).
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {string} The testing key.
 */
function testingState_(label, stats) {
  return stateFor_(label, TESTING_STATE_BY_LABEL, TESTING_STATE_EMPTY, TESTING_STATE_UNKNOWN, stats, 'testing');
}

/**
 * Maps a DVP Status label to a state key. Empty or unknown: 'in_review';
 * unknown labels are counted.
 *
 * @param {?string} label The label (null when empty).
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {string} The state key.
 */
function dvpState_(label, stats) {
  return stateFor_(label, DVP_STATE_BY_LABEL, DVP_STATE_EMPTY, DVP_STATE_UNKNOWN, stats, 'dvp');
}

/**
 * Shared label lookup for the three state maps.
 *
 * @param {?string} label The label (null when empty).
 * @param {Object<string, string>} map Label -> state.
 * @param {string} emptyState State for an empty label.
 * @param {string} unknownState State for a label not in the map.
 * @param {Object=} stats Run stats (optional).
 * @param {string} bucket 'fa', 'testing' or 'dvp' in stats.unknownLabels.
 * @return {string} The state key.
 */
function stateFor_(label, map, emptyState, unknownState, stats, bucket) {
  const key = trimmed_(label);
  if (!key) return emptyState;
  if (hasOwn_(map, key)) return map[key];
  noteUnknownLabel_(stats, bucket, key);
  return unknownState;
}

// -----------------------------------------------------------------------------
// The applicant view (the allow-list, field by field)
// -----------------------------------------------------------------------------

/**
 * Builds the "app" object of the response contract from a raw FA item. This
 * is the allow-list: only these fields ever leave Apps Script.
 *
 *   name, institution, type, submitted, state,
 *   lock {verified, amountMillions}, testing, partyId,
 *   website, announcement, updated, dvp[]
 *
 * Details (Appendix B #7): texts are capped (name and institution 200,
 * partyId 2,000) and empty ones become null. Links are https-only, otherwise
 * null. announcement is only sent when the state is 'approved'. lock is
 * always present; amountMillions is only set when it is above 0. updated is
 * the latest changed_at among FA Status, Testing Process, Lock verified and
 * FA Link. dvp is sorted newest submission first.
 *
 * @param {Object} row Raw FA item {id, name, created_at, column_values}.
 * @param {Array<Object>=} dvpRows Raw DVP items connected to this row.
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {Object} The app object.
 */
function toApplicantView(row, dvpRows, stats) {
  const cols = columnMap_(row);
  const state = faState_(statusText_(cols[FA_COLUMNS.status]), stats);
  const amount = numberOf_(cols[FA_COLUMNS.lockedAmount]);
  const dvp = (Array.isArray(dvpRows) ? dvpRows : [])
      .map((dvpRow) => toDvpView_(dvpRow, stats))
      .sort(compareDvpViews_);

  return {
    name: capText_(row && row.name, NAME_MAX),
    institution: capText_(textOf_(cols[FA_COLUMNS.institution]), INSTITUTION_MAX),
    type: capText_(statusText_(cols[FA_COLUMNS.type]), LABEL_MAX),
    submitted: dateOf_(cols[FA_COLUMNS.submitted]),
    state: state,
    lock: {
      verified: dateOf_(cols[FA_COLUMNS.lockVerified]),
      amountMillions: amount !== null && amount > 0 ? amount : null
    },
    testing: testingState_(statusText_(cols[FA_COLUMNS.testing]), stats),
    partyId: capText_(longTextOf_(cols[FA_COLUMNS.partyId]), PARTY_ID_MAX),
    website: httpsUrl_(linkOf_(cols[FA_COLUMNS.website]).url),
    announcement: state === 'approved' ? httpsUrl_(linkOf_(cols[FA_COLUMNS.announcement]).url) : null,
    updated: latestChangeDate_([
      cols[FA_COLUMNS.status],
      cols[FA_COLUMNS.testing],
      cols[FA_COLUMNS.lockVerified],
      cols[FA_COLUMNS.announcement]
    ]),
    dvp: dvp
  };
}

/**
 * Builds one DVP item of the contract from a raw DVP item:
 * {id, name, state, submitted, finalApproval, requestUrl, requestRef, updated}.
 * finalApproval is only set when the state is 'approved'. requestUrl is
 * https-only. updated is the latest changed_at among Status, Final Approval
 * Date and Request Link (the same idea as the FA rule).
 *
 * @param {Object} row Raw DVP item {id, name, column_values}.
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {Object} The DVP view.
 */
function toDvpView_(row, stats) {
  const cols = columnMap_(row);
  const state = dvpState_(statusText_(cols[DVP_COLUMNS.status]), stats);
  const link = linkOf_(cols[DVP_COLUMNS.requestLink]);
  return {
    id: row && row.id !== undefined && row.id !== null ? String(row.id) : null,
    name: capText_(row && row.name, NAME_MAX),
    state: state,
    submitted: dateOf_(cols[DVP_COLUMNS.submitted]),
    finalApproval: state === 'approved' ? dateOf_(cols[DVP_COLUMNS.finalApproval]) : null,
    requestUrl: httpsUrl_(link.url),
    requestRef: requestRef_(link.url, link.text),
    updated: latestChangeDate_([
      cols[DVP_COLUMNS.status],
      cols[DVP_COLUMNS.finalApproval],
      cols[DVP_COLUMNS.requestLink]
    ])
  };
}

/**
 * Sort order for DVP views: newest submission first, undated ones last, and
 * ties broken by the higher (newer) item id first.
 *
 * @param {Object} a A DVP view.
 * @param {Object} b A DVP view.
 * @return {number} Negative when a comes first.
 */
function compareDvpViews_(a, b) {
  if (a.submitted !== b.submitted) {
    if (!a.submitted) return 1;
    if (!b.submitted) return -1;
    return a.submitted < b.submitted ? 1 : -1;
  }
  const x = String(a.id || '');
  const y = String(b.id || '');
  if (x.length !== y.length) return y.length - x.length; // numeric ids: longer is larger
  if (x === y) return 0;
  return x < y ? 1 : -1;
}

// =============================================================================
// 8. Build pipeline
// =============================================================================

/**
 * Reads Monday and builds the views. This is shared by refresh() (write mode)
 * and doGet's cache rebuild (read-only mode).
 *
 *   1. Read the FA board: allow-listed columns + Status link + Send Email.
 *   2. Read the DVP board, only when DVP_LINK_COLUMN_ID is set, and group its
 *      items by the FA item they are connected to.
 *   3. Read every Status link cell: a code, empty, or unreadable. Count the
 *      unreadable ones and the codes found on more than one row.
 *   4. Write mode only: give empty cells a code and write the links (with
 *      the email rule, the brake and the write cap). Read-only mode never
 *      sends a mutation.
 *   5. Build a view for each row whose code is valid, unique and saved.
 *
 * @param {Object} cfg Config from readConfig_() (already validated).
 * @param {{write: boolean, stats: Object}=} opts write: true to issue codes;
 *     stats: a stats object to fill (one is created when absent).
 * @return {{views: Object<string, Object>, stats: Object}} views maps code ->
 *     app object.
 * @throws {Error} When a board cannot be read; nothing has been written then.
 */
function buildFromMonday_(cfg, opts) {
  const options = opts || {};
  const write = options.write === true;
  const stats = options.stats || newStats_(write ? 'refresh' : 'rebuild');
  const started = Date.now();

  // 1. The FA board.
  stats.stage = 'read_fa';
  const faRows = uniqueById_(readItems_(cfg, cfg.faBoardId, faReadColumnIds_(cfg), '', 'id name created_at'));
  stats.faRows = faRows.length;

  // 2. The DVP board (phase 2), grouped by connected FA item id.
  stats.stage = 'read_dvp';
  let dvpByFaId = {};
  if (cfg.dvpLinkColumnId) {
    const dvpRows = readItems_(cfg, cfg.dvpBoardId, dvpReadColumnIds_(cfg), DVP_RELATION_FRAGMENT, 'id name');
    stats.dvpRows = dvpRows.length;
    dvpByFaId = groupDvpByFaId_(dvpRows, cfg.dvpLinkColumnId, stats);
  }

  // 3. Status link cells.
  stats.stage = 'read_codes';
  const entries = faRows.map((row) => linkEntry_(cfg, row));
  const codeCounts = {}; // code -> number of rows carrying it
  entries.forEach((entry) => {
    if (entry.code === null) {
      if (entry.columnMissing) countInto_(stats.errorCodes, 'status_link_column_missing');
      else stats.unreadableLinks++;
    } else if (entry.code === '') {
      stats.rowsWithoutLink++;
    } else {
      codeCounts[entry.code] = (codeCounts[entry.code] || 0) + 1;
    }
  });
  Object.keys(codeCounts).forEach((code) => {
    if (codeCounts[code] > 1) {
      // Appendix B #3: none of these rows is served until the team clears the extra copies.
      stats.duplicateCodes++;
      stats.duplicateRows += codeCounts[code];
    }
  });

  // 4. New links (refresh only).
  if (write) {
    stats.stage = 'write_links';
    writeNewLinks_(cfg, entries, codeCounts, stats);
  }

  // 5. Views for rows whose code is valid, unique and saved.
  stats.stage = 'build_views';
  const views = {};
  entries.forEach((entry) => {
    if (entry.code && CODE_RE.test(entry.code) && codeCounts[entry.code] === 1) {
      const id = String(entry.row.id);
      views[entry.code] = toApplicantView(entry.row, hasOwn_(dvpByFaId, id) ? dvpByFaId[id] : [], stats);
    }
  });
  stats.served = Object.keys(views).length;
  stats.stage = 'built';
  stats.ms = Date.now() - started;
  return { views: views, stats: stats };
}

/**
 * A fresh stats object. It holds counts, flags, unknown board labels and
 * error codes only: never codes, names or URLs. logRun_ prints it.
 *
 * @param {string=} mode 'refresh' or 'rebuild'.
 * @return {Object} The stats object.
 */
function newStats_(mode) {
  return {
    mode: mode || 'refresh',
    stage: 'start',             // last pipeline step reached (to locate failures)
    faRows: 0,                  // FA items read
    dvpRows: 0,                 // DVP items read (0 while DVP_LINK_COLUMN_ID is unset)
    dvpUnlinked: 0,             // DVP items connected to no FA item
    served: 0,                  // views written to the cache
    rowsWithoutLink: 0,         // FA rows whose Status link was empty when read
    unreadableLinks: 0,         // non-empty Status links without a readable code (never overwritten)
    duplicateCodes: 0,          // codes found on more than one row
    duplicateRows: 0,           // rows carrying those codes (none of them served)
    linksPlanned: 0,            // links this run tried to write (at most WRITE_CAP_PER_RUN)
    linksWritten: 0,            // links Monday saved
    linkWriteFailures: 0,       // links sent but not saved (see errorCodes)
    rowsNotSent: 0,             // planned links not sent because writing stopped early
    rowsDeferredByCap: 0,       // empty rows left for later runs by WRITE_CAP_PER_RUN
    emailQualified: 0,          // rows meeting every email condition (before the brake)
    emailLabelsSet: 0,          // rows saved with Send Email = "Status link"
    emailBrakeTripped: false,   // more than EMAIL_BRAKE rows qualified: no labels this run
    emailSkippedAlreadyLabelled: 0, // new rows whose Send Email already said "Status link"
    rateLimited: false,         // Monday rate-limited a write this run
    cacheLargestShard: 0,       // bytes in the largest cache shard (limit about 100 KB)
    unknownLabels: { fa: {}, testing: {}, dvp: {} }, // board label -> count
    errorCodes: {},             // error code -> count
    ms: 0                       // run time in milliseconds
  };
}

/**
 * The FA column ids to request: the allow-list plus Send Email, plus
 * STATUS_LINK_COLUMN_ID when a config is given.
 *
 * @param {?Object} cfg Config from readConfig_(), or null for the fixed list.
 * @return {Array<string>} Column ids.
 */
function faReadColumnIds_(cfg) {
  const ids = Object.keys(FA_COLUMNS).map((key) => FA_COLUMNS[key]);
  if (cfg && cfg.statusLinkColumnId && ids.indexOf(cfg.statusLinkColumnId) === -1) ids.push(cfg.statusLinkColumnId);
  return ids;
}

/**
 * The DVP column ids to request, plus DVP_LINK_COLUMN_ID when a config is
 * given.
 *
 * @param {?Object} cfg Config from readConfig_(), or null for the fixed list.
 * @return {Array<string>} Column ids.
 */
function dvpReadColumnIds_(cfg) {
  const ids = Object.keys(DVP_COLUMNS).map((key) => DVP_COLUMNS[key]);
  if (cfg && cfg.dvpLinkColumnId && ids.indexOf(cfg.dvpLinkColumnId) === -1) ids.push(cfg.dvpLinkColumnId);
  return ids;
}

/**
 * Drops repeated items (same id), keeping the first. Pagination should never
 * repeat an item, but a repeat would otherwise look like a duplicate code.
 *
 * @param {Array<Object>} rows Raw items.
 * @return {Array<Object>} Items with unique ids.
 */
function uniqueById_(rows) {
  const seen = {};
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const id = String(row.id);
    if (hasOwn_(seen, id)) return false;
    seen[id] = true;
    return true;
  });
}

/**
 * Groups DVP items by the FA item ids in their Connect boards cell. An item
 * connected to two FA rows appears under both.
 *
 * @param {Array<Object>} dvpRows Raw DVP items.
 * @param {string} linkColumnId DVP_LINK_COLUMN_ID.
 * @param {Object} stats Run stats (dvpUnlinked is counted here).
 * @return {Object<string, Array<Object>>} FA item id -> raw DVP items.
 */
function groupDvpByFaId_(dvpRows, linkColumnId, stats) {
  const byFaId = {};
  dvpRows.forEach((row) => {
    const column = columnMap_(row)[linkColumnId];
    const ids = column && Array.isArray(column.linked_item_ids) ? column.linked_item_ids : [];
    const seen = {};
    ids.forEach((rawId) => {
      const id = String(rawId);
      if (!id || hasOwn_(seen, id)) return;
      seen[id] = true;
      if (!hasOwn_(byFaId, id)) byFaId[id] = [];
      byFaId[id].push(row);
    });
    if (!Object.keys(seen).length) stats.dvpUnlinked++;
  });
  return byFaId;
}

/**
 * What the pipeline needs to know about one FA row's link.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {Object} row Raw FA item.
 * @return {{row: Object, code: ?string, columnMissing: boolean,
 *     sendEmail: ?string, createdMs: ?number}} code follows codeFromCell_
 *     (a code, '' for empty, null for unreadable).
 */
function linkEntry_(cfg, row) {
  const cols = columnMap_(row);
  const cell = hasOwn_(cols, cfg.statusLinkColumnId) ? cols[cfg.statusLinkColumnId] : null;
  return {
    row: row,
    code: codeFromCell_(cell),
    columnMissing: cell === null,
    sendEmail: statusText_(cols[FA_COLUMNS.sendEmail]),
    createdMs: parseIsoMs_(row.created_at)
  };
}

/**
 * Write mode: gives every empty Status link a new code and writes it to
 * Monday (Appendix B #5 and #6).
 *
 *   - Only empty cells get codes; unreadable ones are never overwritten.
 *   - At most WRITE_CAP_PER_RUN rows per run, newest rows first, so new
 *     applicants are never held back by the backfill of old rows.
 *   - Rows chosen by chooseEmailRows_ get Send Email = "Status link" in the
 *     same write. If such a write fails with missingLabel, that row's link is
 *     retried on its own.
 *   - A row whose write failed keeps its empty cell: it is not served this
 *     run and is tried again next run.
 *
 * Updates entries[].code and codeCounts in place for rows whose link was
 * saved, so the views step serves them straight away.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {Array<Object>} entries From linkEntry_(), one per FA row.
 * @param {Object<string, number>} codeCounts Code -> rows carrying it.
 * @param {Object} stats Run stats.
 */
function writeNewLinks_(cfg, entries, codeCounts, stats) {
  if (cfg.sendLinkEmail && cfg.emailNewRowsFrom === null) countInto_(stats.errorCodes, 'email_from_invalid');

  const candidates = entries.filter((entry) => entry.code === '').sort(newestFirst_);
  const planned = candidates.slice(0, WRITE_CAP_PER_RUN);
  stats.linksPlanned = planned.length;
  stats.rowsDeferredByCap = candidates.length - planned.length;
  if (!planned.length) return;

  const emailIds = chooseEmailRows_(cfg, planned, stats);

  // Every code already on the board (duplicates included) counts as taken.
  const taken = {};
  Object.keys(codeCounts).forEach((code) => { taken[code] = true; });

  const plans = planned.map((entry) => {
    const code = newCode_(taken);
    taken[code] = true;
    const itemId = String(entry.row.id);
    const withLabel = hasOwn_(emailIds, itemId);
    return { entry: entry, itemId: itemId, code: code, withLabel: withLabel };
  });

  const first = writeColumnBatches_(cfg, cfg.faBoardId, plans.map((plan) => ({
    itemId: plan.itemId,
    values: linkValues_(cfg, plan.code, plan.withLabel)
  })));
  if (first.rateLimited) stats.rateLimited = true;
  const finals = first.results.slice();
  const labelled = plans.map((plan) => plan.withLabel);

  // A missing "Status link" label fails the whole combined write: retry the link alone.
  const retryIndexes = [];
  first.results.forEach((result, i) => {
    if (!result.ok && result.missingLabel && plans[i].withLabel) retryIndexes.push(i);
  });
  if (retryIndexes.length) {
    countInto_(stats.errorCodes, 'missingLabel', retryIndexes.length);
    if (!first.stopped) {
      const retry = writeColumnBatches_(cfg, cfg.faBoardId, retryIndexes.map((i) => ({
        itemId: plans[i].itemId,
        values: linkValues_(cfg, plans[i].code, false)
      })));
      if (retry.rateLimited) stats.rateLimited = true;
      retry.results.forEach((result, k) => {
        finals[retryIndexes[k]] = result;
        labelled[retryIndexes[k]] = false;
      });
    }
  }

  // Tally. Only saved codes are served.
  plans.forEach((plan, i) => {
    const result = finals[i];
    if (result.ok) {
      plan.entry.code = plan.code;
      codeCounts[plan.code] = 1;
      stats.linksWritten++;
      if (labelled[i]) stats.emailLabelsSet++;
    } else if (result.errorCode === 'not_sent') {
      stats.rowsNotSent++;
    } else {
      stats.linkWriteFailures++;
      countInto_(stats.errorCodes, result.errorCode || 'unknown');
    }
  });
}

/**
 * Decides which rows get Send Email = "Status link" with their new link
 * (Appendix B #5). A row qualifies only when all of these hold:
 *   - SEND_LINK_EMAIL is "true" and EMAIL_NEW_ROWS_FROM parses as a date;
 *   - its link is being written in this run (it is in `planned`);
 *   - it was created on or after EMAIL_NEW_ROWS_FROM;
 *   - its Send Email is not already "Status link" (an unchanged label would
 *     not fire the automation);
 *   - Send Email has an active "Status link" label (read once per run, and
 *     only when some row would qualify).
 * Brake: if more than EMAIL_BRAKE rows qualify, no row gets the label (their
 * links are still written) and 'email_brake' is logged. This prevents a mass
 * email caused by a mis-set date.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {Array<Object>} planned Entries whose links are written this run.
 * @param {Object} stats Run stats.
 * @return {Object<string, boolean>} Item id -> true for rows to label.
 */
function chooseEmailRows_(cfg, planned, stats) {
  const chosen = {};
  if (!cfg.sendLinkEmail || cfg.emailNewRowsFrom === null) return chosen;

  const recent = planned.filter((entry) => entry.createdMs !== null && entry.createdMs >= cfg.emailNewRowsFrom);
  const qualifying = recent.filter((entry) => entry.sendEmail !== STATUS_LINK_TEXT);
  stats.emailSkippedAlreadyLabelled = recent.length - qualifying.length;
  if (!qualifying.length) return chosen;

  if (!sendEmailLabelReady_(cfg, stats)) return chosen;
  stats.emailQualified = qualifying.length;
  if (qualifying.length > EMAIL_BRAKE) {
    stats.emailBrakeTripped = true;
    countInto_(stats.errorCodes, 'email_brake');
    return chosen;
  }
  qualifying.forEach((entry) => { chosen[String(entry.row.id)] = true; });
  return chosen;
}

/**
 * Reads the Send Email column settings (once per run) and checks for an
 * active "Status link" label. Labels are never created through the API, so
 * without it links are written without the label.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {Object} stats Run stats (records 'status_link_label_missing' or
 *     'send_email_settings_unreadable').
 * @return {boolean} True when the label can be used.
 */
function sendEmailLabelReady_(cfg, stats) {
  let columns;
  try {
    columns = readColumns_(cfg, cfg.faBoardId, [FA_COLUMNS.sendEmail]);
  } catch (err) {
    countInto_(stats.errorCodes, 'send_email_settings_unreadable');
    return false;
  }
  if (hasActiveLabel_(findColumn_(columns, FA_COLUMNS.sendEmail), STATUS_LINK_TEXT)) return true;
  countInto_(stats.errorCodes, 'status_link_label_missing');
  return false;
}

/**
 * Sort order for link writes: newest created_at first, rows without a
 * created_at last. Ties keep the board order (the sort is stable).
 *
 * @param {Object} a An entry from linkEntry_().
 * @param {Object} b An entry from linkEntry_().
 * @return {number} Negative when a comes first.
 */
function newestFirst_(a, b) {
  if (a.createdMs === b.createdMs) return 0;
  if (a.createdMs === null) return 1;
  if (b.createdMs === null) return -1;
  return b.createdMs - a.createdMs;
}

// =============================================================================
// 9. Cache
// =============================================================================

/**
 * The cache key of the shard that holds a code: CACHE_PREFIX plus the char
 * code of its first character (64 shards; char codes avoid any question of
 * key case-sensitivity).
 *
 * @param {string} code A code matching CODE_RE.
 * @return {string} E.g. 'fa1:65' for a code starting with 'A'.
 */
function shardKeyFor_(code) {
  return CACHE_PREFIX + code.charCodeAt(0);
}

/**
 * Writes all 64 shards in one putAll, {} for empty ones, so codes that were
 * cleared on Monday disappear from the cache. Each value is a JSON map of
 * code -> app object, and expires after CACHE_TTL_S.
 *
 * @param {Object<string, Object>} views Code -> app object.
 * @return {number} Size in bytes of the largest shard (for the log).
 * @throws {Error} 'cache_shard_too_large' if a shard exceeds the value limit.
 */
function writeCache_(views) {
  const shards = {};
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    shards[shardKeyFor_(BASE64URL_ALPHABET.charAt(i))] = {};
  }
  Object.keys(views).forEach((code) => {
    const key = shardKeyFor_(code);
    if (hasOwn_(shards, key)) shards[key][code] = views[code];
  });

  const values = {};
  let largest = 0;
  Object.keys(shards).forEach((key) => {
    values[key] = JSON.stringify(shards[key]);
    largest = Math.max(largest, utf8Length_(values[key]));
  });
  if (largest > CACHE_VALUE_MAX_BYTES) throw fail_('cache_shard_too_large');
  CacheService.getScriptCache().putAll(values, CACHE_TTL_S);
  return largest;
}

/**
 * Reads the shard that would hold a code.
 *
 * @param {string} code A code matching CODE_RE.
 * @return {?Object<string, Object>} The shard's code -> app map, or null when
 *     the shard is missing or unreadable (a cache miss).
 */
function readShard_(code) {
  const raw = CacheService.getScriptCache().get(shardKeyFor_(code));
  if (typeof raw !== 'string') return null;
  const map = parseJson_(raw);
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}

/**
 * UTF-8 byte length of a string (CacheService limits are in bytes).
 *
 * @param {string} text The string.
 * @return {number} Bytes.
 */
function utf8Length_(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // a surrogate pair is one 4-byte character
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// =============================================================================
// 10. Logging
// =============================================================================

/**
 * Prints one JSON line for a run: counts, flags, unknown board labels and
 * error codes only. Never codes, names, URLs or Monday error messages.
 * Failed runs go to console.error, with the error kind and the stage reached.
 *
 * @param {Object} stats Run stats from newStats_().
 * @param {string=} errorKind Short error kind when the run failed.
 */
function logRun_(stats, errorKind) {
  const line = { event: LOG_EVENT, mode: String(stats.mode) };
  Object.keys(stats).forEach((key) => {
    const value = stats[key];
    if (typeof value === 'number' || typeof value === 'boolean') line[key] = value;
  });
  line.unknownLabels = {
    fa: countsOnly_(stats.unknownLabels.fa),
    testing: countsOnly_(stats.unknownLabels.testing),
    dvp: countsOnly_(stats.unknownLabels.dvp)
  };
  line.errorCodes = countsOnly_(stats.errorCodes);
  if (errorKind) {
    line.error = errorKind;
    line.stage = String(stats.stage);
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

/**
 * Copies a key -> count map, keeping numeric counts only.
 *
 * @param {Object} map The map.
 * @return {Object<string, number>} The copy.
 */
function countsOnly_(map) {
  const copy = {};
  Object.keys(map || {}).forEach((key) => {
    if (typeof map[key] === 'number') copy[key] = map[key];
  });
  return copy;
}

/**
 * Adds to a key -> count map.
 *
 * @param {Object<string, number>} map The map (e.g. stats.errorCodes).
 * @param {string} key The key (an error code or a board label).
 * @param {number=} amount How much to add (default 1).
 */
function countInto_(map, key, amount) {
  const safeKey = key === '__proto__' ? '_proto_' : key; // never touch the prototype
  map[safeKey] = (hasOwn_(map, safeKey) ? map[safeKey] : 0) + (amount || 1);
}

/**
 * Counts a board label that has no mapping. Board labels are not applicant
 * data, so they may be logged (capped at LOG_LABEL_MAX characters).
 *
 * @param {Object=} stats Run stats (nothing happens without them).
 * @param {string} bucket 'fa', 'testing' or 'dvp'.
 * @param {string} label The unknown label.
 */
function noteUnknownLabel_(stats, bucket, label) {
  if (!stats || !stats.unknownLabels || !stats.unknownLabels[bucket]) return;
  countInto_(stats.unknownLabels[bucket], label.slice(0, LOG_LABEL_MAX));
}

/**
 * Makes an Error that carries only a short, data-free kind.
 *
 * @param {string} kind E.g. 'monday_rate_limited'.
 * @return {Error} The error (err.kind === kind).
 */
function fail_(kind) {
  const err = new Error(kind);
  err.kind = kind;
  return err;
}

/**
 * A short, loggable kind for any error: our own kind (from fail_), or else the
 * error's name (e.g. 'TypeError'). Never its message, which could quote data.
 *
 * @param {*} err Anything thrown.
 * @return {string} The kind.
 */
function errorKind_(err) {
  if (err && typeof err === 'object') {
    if (typeof err.kind === 'string' && err.kind) return safeCode_(err.kind);
    if (typeof err.name === 'string' && err.name) return safeCode_(err.name);
  }
  return 'unknown';
}

/**
 * Restricts a code to a short, safe set of characters before it is logged or
 * used as a key.
 *
 * @param {*} code An error code or kind.
 * @return {string} Letters, digits and _ . : - only, at most 80 characters,
 *     or 'unknown'.
 */
function safeCode_(code) {
  const cleaned = String(code === undefined || code === null ? '' : code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
  return cleaned || 'unknown';
}
