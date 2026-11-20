/**
 * =============================================================================
 *  FA Status Portal: Google Apps Script backend (Code.gs)
 * =============================================================================
 *
 * WHAT THIS IS
 * ------------
 * A public status page (docs/, on GitHub Pages) where Featured App applicants
 * see where their own FA applications and DVP requests stand, and nobody
 * else's. This script is the only part that talks to Monday. It only READS the
 * two boards: nothing is added to them and nothing is ever written to them.
 *
 * How an applicant gets in:
 *   1. On the page, they type the email address they applied with.
 *   2. If that address is on an FA application, this script emails it a
 *      private link:   https://<site>/#<token>
 *   3. The link shows every FA application that lists the address (in the
 *      "Email" column or in "Emails for Responsible Persons"), each with the
 *      DVP requests that belong to it.
 *
 * The token is an HMAC of the email address keyed with a secret (the
 * LINK_SECRET property), cut to 22 base64url characters (132 bits). It can't
 * be guessed, nothing has to be stored per applicant, and the same address
 * always gets the same link. Changing LINK_SECRET changes every link at once.
 *
 * THREE ENTRY POINTS
 * ------------------
 *   doPost(e)   the page's form: "email me my link"
 *   doGet(e)    the page asks for one token's applications, or (with
 *               ?view=featured) for the public list of featured apps
 *   refresh()   every 10 minutes: read both boards, rebuild the cache
 *
 * FLOW 1: REQUESTING A LINK (page form -> doPost)
 *   The page POSTs {"email": "..."} as text/plain (a CORS "simple" request).
 *     a. A malformed address gets {"ok": false, "error": "invalid_email"}.
 *     b. Otherwise: token = HMAC(LINK_SECRET, address). If the cache has
 *        applications for that token, the link is emailed (with a 15-minute
 *        cooldown and at most 3 emails per address per 6 hours).
 *     c. The answer is {"ok": true} either way, so the form can't be used to
 *        find out whether an address applied.
 *
 * FLOW 2: OPENING A LINK (page -> doGet)
 *   The page reads the token from location.hash (browsers never send the part
 *   after "#" to GitHub) and calls GET <exec URL>?link=<token>.
 *     a. A malformed token gets {"found": false} without touching the cache.
 *     b. Otherwise it reads ONE cache shard (the one for the token's first
 *        character) and answers {"found": true, "apps": [...]} or
 *        {"found": false}.
 *     c. If the shard is missing (expired or evicted), it rebuilds the cache
 *        from Monday under the script lock and answers from the result.
 *     d. Any failure: {"error": "unavailable"} and nothing else.
 *
 * FLOW 3: THE 10-MINUTE JOB (time-driven trigger -> refresh)
 *     1. Reads the FA board: the allow-listed columns plus the two email
 *        columns (used to decide who may see a row; never sent anywhere).
 *     2. Reads the DVP board and attaches each request to the FA app(s) with
 *        the same name (see matchDvpToApps_).
 *     3. Builds, for every email address found on the FA board, the list of
 *        that address's applications (allow-listed fields only).
 *     4. Builds the public list: every app with Featured App status, then
 *        every app whose status was revoked.
 *     5. Writes all 64 cache shards and the public list in one call (6-hour
 *        expiry).
 *     6. Logs ONE JSON line of counts. Never addresses, tokens or names.
 *
 * FLOW 4: THE PUBLIC LIST (page or anyone -> doGet ?view=featured)
 *   Anyone can read it: it is the same for everyone and holds no applicant
 *   data beyond what is already public once an app is featured.
 *     a. GET <exec URL>?view=featured answers {updated, apps: [...]}, one
 *        entry per app with Featured App status or whose status was
 *        revoked: name, FA Type, status, since, Party IDs and the
 *        announcement link (toPublicView_).
 *     b. Adding &format=csv answers the same list as a CSV file.
 *     c. A cache miss rebuilds from Monday under the lock, as in flow 2.
 *
 * SCRIPT PROPERTIES (Project Settings -> Script Properties)
 * ---------------------------------------------------------
 *   MONDAY_API_TOKEN  Required. A Monday API token from an account that can
 *                     see both boards. Never logged, never returned.
 *   SITE_URL          Required. The page's https address, e.g.
 *                     https://pedrodneves.github.io/fa-status/ . Used to build
 *                     the link in the email.
 *   LINK_SECRET       Created by setup(). Leave it alone: changing or deleting
 *                     it (then running setup again) changes every link.
 *   FA_BOARD_ID       Optional. Defaults to the production FA board.
 *   DVP_BOARD_ID      Optional. Defaults to the production DVP board.
 *
 * SETUP (once)
 * ------------
 *   1. script.google.com -> New project. Paste this file into Code.gs. In
 *      Project Settings, tick "Show appsscript.json manifest file in editor",
 *      and replace that file with apps-script/appsscript.json.
 *   2. Project Settings -> Script Properties: add MONDAY_API_TOKEN and SITE_URL.
 *   3. Pick "setup" in the function menu and press Run. Approve the
 *      permissions (connect to Monday, send email, run on a schedule).
 *   4. Deploy -> New deployment -> Web app. Execute as: Me. Who has access:
 *      Anyone. Put the /exec URL in docs/config.js (apiUrl).
 *   5. After any code change: Deploy -> Manage deployments -> Edit ->
 *      Version: New version (the URL stays the same).
 *
 * PRIVACY RULES THIS FILE FOLLOWS
 * -------------------------------
 *   - Only allow-listed columns (plus the two email columns) are requested
 *     from Monday, and the answer is built field by field in
 *     toApplicantView(), so nothing else can leak.
 *   - The public list holds only apps with Featured App status or whose
 *     status was revoked, and only
 *     their name, FA Type, status, date, Party IDs and announcement link
 *     (toPublicView_). The institution, the review's progress and everything
 *     else stay private.
 *   - Email addresses are only used to compute tokens and to send the link to
 *     that same address. They are never cached, logged or returned.
 *   - Logs carry counts, unknown board labels and short error kinds only.
 *
 * APPS SCRIPT NOTES FOR NEWCOMERS
 * -------------------------------
 *   - doGet(e) / doPost(e) are called by Apps Script for each GET / POST on
 *     the web app. refresh() is called by a time-driven trigger.
 *   - The services used here are globals provided by Apps Script:
 *     PropertiesService (settings), CacheService (shared key/value cache),
 *     LockService (a script-wide mutex), UrlFetchApp (HTTP), MailApp (email),
 *     Utilities (HMAC, base64, sleep), ContentService (HTTP responses) and
 *     ScriptApp (triggers).
 *   - Functions whose names end in "_" are private: they are hidden from the
 *     editor's Run menu and can't be called from outside.
 *   - The file has no top-level side effects (only constants and functions),
 *     so the Node tests can load it with mocked services.
 */

// =============================================================================
// 1. Constants
// =============================================================================

// -----------------------------------------------------------------------------
// Boards and columns
// -----------------------------------------------------------------------------

/** Production FA board, "Featured App Submissions". Override with FA_BOARD_ID. */
const DEFAULT_FA_BOARD_ID = '18420896395';

/** Production DVP board, "Asset Moving Status Requests". Override with DVP_BOARD_ID. */
const DEFAULT_DVP_BOARD_ID = '18436778970';

/** FA board columns that may be shown to the applicant (the allow-list). */
const FA_COLUMNS = {
  institution: 'text_mm4k2vch',     // Name of Applying Institution (text)
  status: 'color_mm4kmej3',         // FA Status (status), mapped to a state key
  type: 'color_mm4kpp3q',           // Type (status): Non-Issuer / Asset Issuer
  faType: 'color_mm8z4ket',         // FA Type (status): Basic Featured App / Featured Asset-Moving App / Featured Asset
  dvpStatus: 'color_mm8a49an',      // DVP Status (status): the app's DVP status, set on the FA board
  submitted: 'date_mm4kw11a',       // "Time stamp" (date)
  lockVerified: 'date_mm4kpckv',    // Lock Verified (date)
  lockedAmount: 'numeric_mm4k6919', // Locked amount (Million) (numbers)
  testing: 'color_mm6be9ge',        // Testing Process (status)
  partyId: 'long_text_mm4kq322',    // Party ID for the Featured Application (long text)
  website: 'link_mm4kmq24',         // Product Website (link)
  announcement: 'link_mm6hfp5g',    // "FA Link" (link): shown only once approved
  sendEmail: 'color_mm6eay19'       // Send Email (status): which email the committee last sent
};

/**
 * FA board columns that decide WHO may see a row. They are read, but never
 * cached, logged or sent to the page.
 */
const FA_EMAIL_COLUMNS = {
  email: 'email_mm4ke170',     // Email (email column)
  responsible: 'text_mm4kvrar' // Emails for Responsible Persons (free text, often several)
};

/** DVP board columns that may be shown. The board has no email column. */
const DVP_COLUMNS = {
  submitted: 'date_mm8dsx4y',     // Submission Date
  finalApproval: 'date_mm8dm7a0', // Final Approval Date
  requestLink: 'link_mm8rp25j',   // Request Link (post on the accountability list)
  status: 'color_mm8dhgvr'        // Status
};

/**
 * Columns whose changes make up an application's history (from Monday's
 * activity log, read when a link is opened). A subset of the allow-list.
 */
const FA_HISTORY_COLUMNS = [
  FA_COLUMNS.status, FA_COLUMNS.testing, FA_COLUMNS.lockVerified, FA_COLUMNS.lockedAmount,
  FA_COLUMNS.sendEmail, FA_COLUMNS.faType, FA_COLUMNS.dvpStatus
];
const DVP_HISTORY_COLUMNS = [DVP_COLUMNS.status];

// -----------------------------------------------------------------------------
// Monday API
// -----------------------------------------------------------------------------

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2026-10';

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

const PAGE_LIMIT = 500;               // items per items_page / next_items_page call (Monday's maximum)
const MAX_PAGES = 50;                 // pagination safety stop (25,000 items)
const MAX_RETRIES = 2;                // retries per request on HTTP 429 or 5xx
const RETRY_AFTER_MAX_S = 10;         // longest Retry-After honoured, in seconds
const CACHE_TTL_S = 21600;            // 6 hours, CacheService's maximum
const CACHE_PREFIX = 'fa2:';          // cache key prefix; changing it orphans every old shard
const CACHE_VALUE_MAX_BYTES = 100000; // CacheService allows 100 KB per value
const LOCK_WAIT_MS = 20000;           // a request waits this long for the lock on a cache miss
const REFRESH_LOCK_WAIT_MS = 5000;    // refresh gives up quickly: the next run is 10 minutes away
const HISTORY_KEY_PREFIX = CACHE_PREFIX + 'hist:'; // + token: that link's history, {appId: [events]}
const HISTORY_TTL_S = 600;            // history is read again at most every 10 minutes per link
const HISTORY_PAGE_LIMIT = 100;       // activity log entries per request
const HISTORY_MAX_PAGES = 5;          // per board and link (500 changes)
const HISTORY_MAX_PER_APP = 80;       // newest changes kept per application
const PUBLIC_KEY = CACHE_PREFIX + 'pub'; // the public list's index {updated, chunks}; its rows under PUBLIC_KEY + ':<n>'
const PUBLIC_CHUNK_MAX_BYTES = 90000; // rows per cache value stay under the 100 KB limit
const PUBLIC_CHUNKS_MAX = 50;         // an index naming more chunks than this is treated as a cache miss

// Link emails.
const MAIL_KEY_PREFIX = CACHE_PREFIX + 'mail:'; // + token: when this address was last emailed
const MAIL_COOLDOWN_S = 900;          // at most one email per address every 15 minutes...
const MAIL_WINDOW_S = 21600;          // ...and at most MAIL_MAX_PER_WINDOW per 6 hours
const MAIL_MAX_PER_WINDOW = 3;
const MAIL_QUOTA_RESERVE = 10;        // leave this much of the account's daily email quota unused
const PAUSE_MIN_MS = 600;             // when no email is sent, wait about as long as sending takes,
const PAUSE_SPREAD_MS = 800;          // so response times don't reveal whether an address applied

// Email addresses.
const EMAIL_MAX_LENGTH = 254;
const EMAILS_PER_ROW_MAX = 10;        // ignore anything past this in one row's cells

// Text caps for the applicant view.
const NAME_MAX = 200;        // app name, DVP request name
const INSTITUTION_MAX = 200; // institution
const LABEL_MAX = 200;       // the Type label
const PARTY_ID_MAX = 2000;   // party id
const PARTY_IDS_MAX = 5;     // party ids per app on the public list
const URL_MAX = 2000;        // website, announcement, DVP request link
const LOG_LABEL_MAX = 60;    // unknown labels as written to the log

// The public list as a CSV file (GET ?view=featured&format=csv).
const CSV_FILE_NAME = 'featured-apps.csv';
const CSV_COLUMNS = ['name', 'type', 'status', 'since', 'since_exact', 'party_ids', 'record'];

// -----------------------------------------------------------------------------
// The email that carries the link (the page's wording lives in docs/status.js)
// -----------------------------------------------------------------------------

const LINK_EMAIL = {
  senderName: 'Featured App Status',
  subject: 'Your Featured App status link',
  intro: 'Here is your private link to the status of your Featured App applications and DVP requests:',
  button: 'View my application status',
  keep: 'Anyone with this link can see these statuses, so keep it within your team. The link stays the same, so you can bookmark it.',
  why: "You're receiving this because this address was entered on the Featured App Status page. If that wasn't you, you can ignore this email."
};

// -----------------------------------------------------------------------------
// Labels -> state keys (all wording lives in docs/status.js)
// -----------------------------------------------------------------------------

/** FA Status label -> state. Empty: FA_STATE_EMPTY. Any other label: FA_STATE_UNKNOWN (logged). */
const FA_STATE_BY_LABEL = {
  '0-Locked+Needs Review': 'in_review',
  '1-Needs Review': 'in_review',
  '1b-FAAC Approved-waiting on tokenomics': 'with_tokenomics',
  '2-Approved': 'approved',
  // Featured App status with conditions. Not on the board yet: this is the
  // label proposed to the committee. It takes effect if they add it.
  '2b-Provisional': 'provisional',
  '3-CIP-0116-paused': 'on_hold',
  '4-No': 'not_approved',
  '5-Revoked': 'revoked',
  '6-Withdrawn': 'withdrawn',
  '7-Closed-new-process': 'closed_process'
};
const FA_STATE_EMPTY = 'received';
const FA_STATE_UNKNOWN = 'in_review';

/**
 * FA states on the public list -> their status there: apps with Featured App
 * status, and apps whose status was revoked (the committee decided on 20 Nov
 * 2026 to list those too). Only apps in these states are listed publicly,
 * and only they get their announcement link sent.
 */
const PUBLIC_STATUS_BY_STATE = {
  approved: 'featured',
  provisional: 'provisional',
  revoked: 'revoked'
};

/** FA Status labels that mean the Canton Coin lock is confirmed (lock.confirmed). */
const FA_LOCKED_LABELS = ['0-Locked+Needs Review'];

/**
 * FA Status label -> history step. The same as FA_STATE_BY_LABEL, except
 * that "0-Locked+Needs Review" is told apart from "1-Needs Review", so the
 * history shows the lock being confirmed.
 */
const FA_HISTORY_STATUS_BY_LABEL = Object.assign({}, FA_STATE_BY_LABEL, {
  '0-Locked+Needs Review': 'in_review_locked'
});

/** Testing Process label -> state. Empty: not_started. Unknown: in_progress (logged). */
const TESTING_STATE_BY_LABEL = {
  'Sent Email': 'action_needed',
  'Pending Review': 'in_progress',
  'Stuck': 'in_progress',
  'Done': 'complete'
};
const TESTING_STATE_EMPTY = 'not_started';
const TESTING_STATE_UNKNOWN = 'in_progress';

/** DVP Status label -> state. The board's label really is spelled "Apporval"; both spellings work. */
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

/** DVP Status label (on the FA board) -> state. Empty: null (not shown). Unknown: null (logged). */
const DVP_STATUS_BY_LABEL = {
  'Needs Review': 'in_review',
  'FAAC Approved': 'faac_approved',
  'Declined': 'declined'
};

/**
 * Send Email label -> the email the committee sent (a Monday automation
 * sends one email per label). The page shows the latest one, with the date
 * the label was set. "Working on it", "Done", "Stuck" and an empty cell send
 * nothing, so they show nothing. Any other label shows nothing and is logged.
 */
const EMAIL_UPDATE_BY_LABEL = {
  'Office Hour Request': 'office_hours',    // "FAAC Office Hours Request": book a slot
  'Endorsements': 'endorsements',           // how to get endorsements from your users
  'FA Type Email': 'fa_type_info',          // TBAR: FA type and App Operations PartyIDs
  'Locking Check': 'locking_check',         // the locking party lacks the full balance
  'Updated Process': 'resubmit',            // resubmit with the revised form
  'Decline': 'declined',                    // not ready; reapply after three months, or sooner with a substantially changed proposal live on MainNet
  'Working on it': null,
  'Done': null,
  'Stuck': null
};

// -----------------------------------------------------------------------------
// Formats
// -----------------------------------------------------------------------------

/** A link token: 22 base64url characters (132 bits of an HMAC-SHA256). */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_LENGTH = 22;

/** The 64 base64url characters. A token's first character picks its cache shard. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** LINK_SECRET must be at least this long (setup() makes a 64-character one). */
const SECRET_MIN_LENGTH = 32;

/** Email addresses: finding them inside a cell's text, and checking a typed one. */
const EMAIL_FIND_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_INPUT_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Where an app name stops and its qualifier starts, for DVP matching:
 * " (" or " [", a spaced dash (" - ", " – ", " — "), or ": ".
 * "Harbor Swap (RFQ request)" -> "harbor swap"; "Copperleaf - Copperleaf Labs" -> "copperleaf".
 */
const NAME_CUT_RE = /\s+[(\[]|\s+[-–—]\s+|:\s/;
const MATCH_KEY_MIN = 2; // ignore name keys shorter than this

/** Board ids (digits). */
const BOARD_ID_RE = /^[0-9]{1,20}$/;

/** SITE_URL after normalisation: https, a host, an optional path, no query or fragment. */
const SITE_URL_RE = /^https:\/\/[^\s\/?#@\\]+(\/[^\s?#]*)?$/i;

/** Links sent to the page: https with a host, and no spaces or control characters. */
const HTTPS_URL_RE = /^https:\/\/[^\s\/?#@\\\u0000-\u001f\u007f]+([\/?#][^\s\u0000-\u001f\u007f]*)?$/i;

/** Dates: YYYY-MM-DD at the start of a cell's text, and full ISO timestamps. */
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A Canton party ID inside the free-text "Party ID" cell: a hint (letters,
 * digits, "_", "-" and single ":"; never "::"; up to 185 characters), then
 * "::1220" and the 64 hex digits of the namespace fingerprint, then the end,
 * a character that isn't hex, or the next party ID (two IDs typed with no
 * separator). "a::1220…, b::1220…" gives two. Text not in this form (a
 * space before "::", a fingerprint of the wrong length) gives none, so the
 * public list never shows a malformed ID.
 */
const PARTY_HINT_SRC = '[A-Za-z0-9_-](?:[A-Za-z0-9_-]|:(?!:)){0,184}';
const PARTY_ID_FIND_RE = new RegExp(PARTY_HINT_SRC + '::1220[0-9a-f]{64}(?=$|[^0-9a-f]|' + PARTY_HINT_SRC + '::1220)', 'g');

/** DVP request reference: "/message/<n>" in the link URL, or a leading "#<n>" in its text. */
const REQUEST_REF_URL_RE = /\/message\/(\d{1,20})/;
const REQUEST_REF_TEXT_RE = /^\s*#(\d{1,20})/;

/** Monday error codes that mean "rate or complexity limit reached". */
const RATE_LIMIT_CODE_RE = /rate.?limit|complexity|budget|concurrency|daily.?limit/i;

/** The "event" field on every log line, to filter the logs. */
const LOG_EVENT = 'fa-status';

// =============================================================================
// 2. Entry points
// =============================================================================

/**
 * Web app GET: answers one link for the page, or the public list.
 *
 * @param {Object=} e The request event (undefined when run from the editor).
 *     e.parameter.link carries the token. e.parameter.view === 'featured'
 *     asks for the public list instead, as a CSV file with format=csv.
 * @return {TextOutput} For a link, JSON: {found: true, apps: [...]},
 *     {found: false} or {error: 'unavailable'}. For the public list, JSON
 *     {updated, apps: [...]} or {error: 'unavailable'}, or the CSV file.
 */
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  let body;
  try {
    if (params.view === 'featured') {
      body = featuredList_();
      if (params.format === 'csv' && !body.error) return csvOutput_(body);
    } else {
      const token = typeof params.link === 'string' ? params.link : '';
      // A malformed token can never be in the cache, so answer without touching it.
      body = TOKEN_RE.test(token) ? lookup_(token) : { found: false };
      // Each application's history, from Monday's activity log. Optional: if it
      // can't be read, the answer goes out without it.
      if (body.found) body = withHistory_(token, body);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doGet', error: errorKind_(err) }));
    body = { error: 'unavailable' };
  }
  return jsonOutput_(body);
}

/**
 * Web app POST: the page's "email me my link" form.
 *
 * The answer is the same whether or not the address is on an application, so
 * the form can't be used to test addresses. Error details never reach the
 * browser.
 *
 * @param {Object=} e The request event. e.postData.contents is the JSON text
 *     {"email": "..."}; a form-encoded email=... works too.
 * @return {TextOutput} JSON: {ok: true}, {ok: false, error: 'invalid_email'}
 *     or {ok: false, error: 'unavailable'}.
 */
function doPost(e) {
  let body;
  try {
    const email = normaliseEmail_(emailFromRequest_(e));
    body = email ? requestLink_(email) : { ok: false, error: 'invalid_email' };
  } catch (err) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doPost', error: errorKind_(err) }));
    body = { ok: false, error: 'unavailable' };
  }
  return jsonOutput_(body);
}

/**
 * The 10-minute job: reads both boards and rebuilds the cache. Runs from the
 * time-driven trigger that setup() creates.
 *
 * If Monday can't be read or the cache can't be written, the run logs its
 * counts with a short error kind and throws a data-free Error, so the
 * execution shows as failed. The previous cache then stays as it was.
 *
 * @return {Object|undefined} The run's stats (counts only), or undefined when
 *     the run was skipped (another run holds the lock, or the Script
 *     Properties are incomplete).
 */
function refresh() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(REFRESH_LOCK_WAIT_MS)) {
    console.log(JSON.stringify({ event: LOG_EVENT, mode: 'refresh', skipped: 'lock_busy' }));
    return;
  }
  try {
    const result = rebuild_('refresh');
    return result ? result.stats : undefined;
  } catch (err) {
    // A fresh Error, so no message from Monday or the runtime ends up in the logs.
    throw new Error('refresh failed: ' + errorKind_(err));
  } finally {
    lock.releaseLock();
  }
}

/**
 * One-time setup, run by hand from the editor. It:
 *   1. creates LINK_SECRET if it doesn't exist yet (never replaces one);
 *   2. checks the Script Properties;
 *   3. checks that both boards can be read and have the expected columns;
 *   4. reads the remaining email quota (this is also what makes Google ask
 *      for the "send email" permission now, not on the first request);
 *   5. creates the 10-minute trigger for refresh(), unless one exists;
 *   6. runs refresh() and logs a summary.
 * Safe to run again at any time.
 *
 * @return {Object|undefined} The stats of the refresh() it ran.
 * @throws {Error} Listing what to fix (property names, never values).
 */
function setup() {
  const secretCreated = ensureSecret_();
  const cfg = readConfig_();
  const problems = validateConfig_(cfg);
  if (problems.length) {
    throw new Error('Fix these Script Properties, then run setup again: ' + problems.join('; '));
  }
  const missing = checkColumns_(cfg);
  const mailQuota = MailApp.getRemainingDailyQuota();
  const triggerCreated = ensureRefreshTrigger_();
  const stats = refresh();
  console.log(JSON.stringify({
    event: LOG_EVENT,
    mode: 'setup',
    secretCreated: secretCreated,
    triggerCreated: triggerCreated,
    missingColumns: missing, // column ids only: those fields will read as empty
    mailQuota: mailQuota,
    refreshed: Boolean(stats),
    faRows: stats ? stats.faRows : 0,
    addresses: stats ? stats.addresses : 0,
    featured: stats ? stats.featured : 0,
    revoked: stats ? stats.revoked : 0,
    dvpMatched: stats ? stats.dvpMatched : 0,
    dvpUnmatched: stats ? stats.dvpUnmatched : 0
  }));
  return stats;
}

// =============================================================================
// 3. Answering the page
// =============================================================================

/**
 * Looks one token up in the cache, rebuilding it on a miss (see
 * fromCacheOrRebuild_).
 *
 * @param {string} token A token that already matched TOKEN_RE.
 * @return {Object} {found: true, apps}, {found: false} or {error: 'unavailable'}.
 */
function lookup_(token) {
  return fromCacheOrRebuild_('lookup', () => {
    const shard = readShard_(token);
    return shard ? answerFor_(shard, token) : null;
  }, (result) => answerFor_(result.views, token));
}

/**
 * The public list from the cache, rebuilding it on a miss (see
 * fromCacheOrRebuild_).
 *
 * @return {Object} {updated, apps} or {error: 'unavailable'}.
 */
function featuredList_() {
  return fromCacheOrRebuild_('featured', readPublicCache_, (result) => result.featured);
}

/**
 * Answers from the cache. On a miss: takes the script lock, reads again
 * (another request may have refilled the cache), and if it is still missing
 * rebuilds the cache from Monday. Without the lock it reads once more and
 * otherwise gives up.
 *
 * @param {string} mode 'lookup' or 'featured' (for the log line).
 * @param {function(): ?Object} read The answer from the cache, or null on a miss.
 * @param {function(Object): Object} fromRebuild The answer from rebuild_()'s result.
 * @return {Object} The answer, or {error: 'unavailable'}.
 */
function fromCacheOrRebuild_(mode, read, fromRebuild) {
  const hit = read();
  if (hit) return hit;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    const again = read();
    if (again) return again;
    console.error(JSON.stringify({ event: LOG_EVENT, mode: mode, error: 'lock_busy' }));
    return { error: 'unavailable' };
  }
  try {
    const filled = read();
    if (filled) return filled;
    const result = rebuild_('rebuild');
    return result ? fromRebuild(result) : { error: 'unavailable' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The answer for one token from a map of token -> entry (a cache shard, or
 * the views of a rebuild).
 *
 * @param {Object<string, {apps: Array<Object>}>} map Token -> entry.
 * @param {string} token The token asked for.
 * @return {Object} {found: true, apps} or {found: false}.
 */
function answerFor_(map, token) {
  const entry = hasOwn_(map, token) ? map[token] : null;
  const apps = entry && Array.isArray(entry.apps) ? entry.apps : [];
  return apps.length ? { found: true, apps: apps } : { found: false };
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
 * The public list as a CSV file: one header line (CSV_COLUMNS), then one
 * line per app. Several Party IDs are separated by a space (an ID never
 * contains one).
 *
 * @param {{apps: Array<Object>}} list From featuredList_().
 * @return {TextOutput} The CSV, downloaded as CSV_FILE_NAME.
 */
function csvOutput_(list) {
  const lines = [CSV_COLUMNS.join(',')];
  list.apps.forEach((app) => {
    lines.push([
      app.name, app.type, app.status, app.since, app.sinceExact ? 'true' : 'false',
      (Array.isArray(app.partyIds) ? app.partyIds : []).join(' '), app.record
    ].map(csvCell_).join(','));
  });
  return ContentService.createTextOutput(lines.join('\r\n') + '\r\n')
      .setMimeType(ContentService.MimeType.CSV)
      .downloadAsFile(CSV_FILE_NAME);
}

/**
 * One CSV cell: quoted when it holds a comma, quote or line break. A cell
 * that starts like a spreadsheet formula (=, +, -, @) gets a leading "'",
 * so opening the file never runs one.
 *
 * @param {*} value The value (null and undefined give an empty cell).
 * @return {string} The cell.
 */
function csvCell_(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// =============================================================================
// 4. Emailing the link
// =============================================================================

/**
 * Reads the email address from a POST: the JSON body {"email": "..."} the
 * page sends, or a form-encoded email=... parameter.
 *
 * @param {Object=} e The request event.
 * @return {string} The raw address ('' when there is none).
 */
function emailFromRequest_(e) {
  const contents = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  const parsed = contents.length <= 2000 ? parseJson_(contents) : null;
  if (parsed && typeof parsed === 'object' && typeof parsed.email === 'string') return parsed.email;
  return e && e.parameter && typeof e.parameter.email === 'string' ? e.parameter.email : '';
}

/**
 * Handles a valid address: emails the link if the address is on an
 * application and the limits allow it.
 *
 * @param {string} email A normalised address (see normaliseEmail_).
 * @return {Object} {ok: true}, or {ok: false, error: 'unavailable'} when the
 *     applications can't be looked up.
 */
function requestLink_(email) {
  const cfg = readConfig_();
  const problems = validateConfig_(cfg);
  if (problems.length) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doPost', error: 'config_invalid', problems: problems }));
    return { ok: false, error: 'unavailable' };
  }
  const token = tokenFor_(cfg.secret, email);
  const answer = lookup_(token);
  if (answer.error) return { ok: false, error: 'unavailable' };

  const outcome = answer.found ? sendLink_(cfg, email, token) : 'not_found';
  if (outcome !== 'sent') pause_();
  return { ok: true };
}

/**
 * Emails the link to one address, within the limits: one email per
 * MAIL_COOLDOWN_S, MAIL_MAX_PER_WINDOW per MAIL_WINDOW_S, and never the last
 * MAIL_QUOTA_RESERVE emails of the account's daily quota. The limits are kept
 * in the cache under the token, so no address is stored.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} email The address to send to.
 * @param {string} token Its token.
 * @return {string} 'sent', 'cooldown', 'window_full', 'quota_low' or 'mail_failed'.
 */
function sendLink_(cfg, email, token) {
  const cache = CacheService.getScriptCache();
  const key = MAIL_KEY_PREFIX + token;
  const now = Date.now();
  const record = parseJson_(cache.get(key));
  const inWindow = record && typeof record.first === 'number' && now - record.first < MAIL_WINDOW_S * 1000;
  const first = inWindow ? record.first : now;
  const count = inWindow && typeof record.count === 'number' ? record.count : 0;

  if (record && typeof record.last === 'number' && now - record.last < MAIL_COOLDOWN_S * 1000) return 'cooldown';
  if (count >= MAIL_MAX_PER_WINDOW) return 'window_full';
  if (MailApp.getRemainingDailyQuota() <= MAIL_QUOTA_RESERVE) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doPost', error: 'mail_quota_low' }));
    return 'quota_low';
  }

  // Note the send first, so two quick requests can't both send.
  cache.put(key, JSON.stringify({ first: first, count: count + 1, last: now }), MAIL_WINDOW_S);
  const link = cfg.siteUrl + '#' + token;
  try {
    MailApp.sendEmail({
      to: email,
      subject: LINK_EMAIL.subject,
      body: linkEmailText_(link),
      htmlBody: linkEmailHtml_(link),
      name: LINK_EMAIL.senderName
    });
  } catch (err) {
    // The error message can quote the address, so only its kind is logged.
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'doPost', error: 'mail_failed', kind: errorKind_(err) }));
    return 'mail_failed';
  }
  return 'sent';
}

/**
 * The plain-text body of the link email.
 *
 * @param {string} link The private link.
 * @return {string} The text.
 */
function linkEmailText_(link) {
  return [LINK_EMAIL.intro, '', link, '', LINK_EMAIL.keep, '', LINK_EMAIL.why].join('\n');
}

/**
 * The HTML body of the link email: the same text, with a button. Email
 * clients need inline styles.
 *
 * @param {string} link The private link.
 * @return {string} The HTML.
 */
function linkEmailHtml_(link) {
  const href = escapeHtml_(link);
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#15202B">' +
      '<p>' + escapeHtml_(LINK_EMAIL.intro) + '</p>' +
      '<p><a href="' + href + '" style="display:inline-block;padding:10px 18px;border-radius:6px;' +
      'background:#1F4F8F;color:#FFFFFF;font-weight:bold;text-decoration:none">' + escapeHtml_(LINK_EMAIL.button) + '</a></p>' +
      '<p style="font-size:13px;color:#5A6774;word-break:break-all"><a href="' + href + '" style="color:#1F4F8F">' + href + '</a></p>' +
      '<p>' + escapeHtml_(LINK_EMAIL.keep) + '</p>' +
      '<p style="font-size:13px;color:#5A6774">' + escapeHtml_(LINK_EMAIL.why) + '</p>' +
      '</div>';
}

/**
 * Escapes text for HTML.
 *
 * @param {string} text The text.
 * @return {string} The escaped text.
 */
function escapeHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Waits about as long as sending an email takes (see PAUSE_MIN_MS). */
function pause_() {
  Utilities.sleep(PAUSE_MIN_MS + Math.floor(Math.random() * PAUSE_SPREAD_MS));
}

// =============================================================================
// 5. Email addresses and tokens
// =============================================================================

/**
 * Normalises one email address: trimmed and lower-cased. Anything that isn't
 * a single plausible address becomes ''.
 *
 * @param {*} raw The address as typed or found.
 * @return {string} The normalised address, or ''.
 */
function normaliseEmail_(raw) {
  const email = trimmed_(raw).toLowerCase();
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_INPUT_RE.test(email) ? email : '';
}

/**
 * Every email address on an FA row: the Email column plus any addresses
 * written in "Emails for Responsible Persons" (separated by commas,
 * semicolons, spaces, "and"...). Normalised, without duplicates, at most
 * EMAILS_PER_ROW_MAX.
 *
 * @param {Object} row A raw FA item.
 * @return {Array<string>} The addresses (possibly none).
 */
function emailsOfRow_(row) {
  const cols = columnMap_(row);
  const found = [];
  const addFrom = (text) => {
    (String(text || '').match(EMAIL_FIND_RE) || []).forEach((raw) => {
      const email = normaliseEmail_(raw);
      if (email && found.indexOf(email) === -1 && found.length < EMAILS_PER_ROW_MAX) found.push(email);
    });
  };
  const emailColumn = cols[FA_EMAIL_COLUMNS.email];
  if (emailColumn) {
    const value = parseValue_(emailColumn.value);
    addFrom(value && typeof value === 'object' ? value.email : '');
    addFrom(emailColumn.text);
  }
  addFrom(textOf_(cols[FA_EMAIL_COLUMNS.responsible]));
  return found;
}

/**
 * The link token for an address: HMAC-SHA256(LINK_SECRET, address), base64url,
 * first TOKEN_LENGTH characters.
 *
 * @param {string} secret LINK_SECRET.
 * @param {string} email A normalised address.
 * @return {string} The token (matches TOKEN_RE).
 */
function tokenFor_(secret, email) {
  const bytes = Utilities.computeHmacSha256Signature(email, secret, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, TOKEN_LENGTH);
}

// =============================================================================
// 6. Configuration
// =============================================================================

/**
 * Reads the Script Properties into a plain config object. Values are trimmed;
 * missing ones become ''. Nothing is validated here (see validateConfig_).
 *
 * @return {{token: string, siteUrl: string, secret: string, faBoardId: string,
 *     dvpBoardId: string}} siteUrl is normalised (see normaliseSiteUrl_).
 */
function readConfig_() {
  const all = PropertiesService.getScriptProperties().getProperties() || {};
  const get = (key) => (typeof all[key] === 'string' ? all[key].trim() : '');
  return {
    token: get('MONDAY_API_TOKEN'),
    siteUrl: normaliseSiteUrl_(get('SITE_URL')),
    secret: get('LINK_SECRET'),
    faBoardId: get('FA_BOARD_ID') || DEFAULT_FA_BOARD_ID,
    dvpBoardId: get('DVP_BOARD_ID') || DEFAULT_DVP_BOARD_ID
  };
}

/**
 * SITE_URL must end in "/" unless it ends in ".html", so that
 * SITE_URL + "#" + token is always a valid link.
 *
 * @param {string} url The trimmed SITE_URL ('' when unset).
 * @return {string} The normalised URL ('' stays '').
 */
function normaliseSiteUrl_(url) {
  if (!url || /\.html$/i.test(url) || url.charAt(url.length - 1) === '/') return url;
  return url + '/';
}

/**
 * Checks the config. refresh() logs the problems and stops, doGet/doPost
 * answer "unavailable", and setup() throws them.
 *
 * @param {Object} cfg Config from readConfig_().
 * @return {Array<string>} Problems that name properties, never their values.
 */
function validateConfig_(cfg) {
  const problems = [];
  if (!cfg.token) problems.push('MONDAY_API_TOKEN is not set');
  if (!cfg.siteUrl) {
    problems.push('SITE_URL is not set');
  } else if (!SITE_URL_RE.test(cfg.siteUrl)) {
    problems.push('SITE_URL must be an https:// address without spaces, "?" or "#"');
  }
  if (!cfg.secret) {
    problems.push('LINK_SECRET is not set (run setup to create it)');
  } else if (cfg.secret.length < SECRET_MIN_LENGTH) {
    problems.push('LINK_SECRET is too short (delete it and run setup to create a new one; every link will change)');
  }
  if (!BOARD_ID_RE.test(cfg.faBoardId)) problems.push('FA_BOARD_ID must be a numeric board id');
  if (!BOARD_ID_RE.test(cfg.dvpBoardId)) problems.push('DVP_BOARD_ID must be a numeric board id');
  if (cfg.faBoardId === cfg.dvpBoardId) problems.push('FA_BOARD_ID and DVP_BOARD_ID must be different boards');
  return problems;
}

/**
 * setup() helper: creates LINK_SECRET (two random UUIDs, 64 hex characters)
 * unless the property exists. An existing secret is never replaced, because
 * that would change every link.
 *
 * @return {boolean} True when a secret was created.
 */
function ensureSecret_() {
  const store = PropertiesService.getScriptProperties();
  if (trimmed_(store.getProperty('LINK_SECRET'))) return false;
  store.setProperty('LINK_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  return true;
}

/**
 * setup() helper: checks that both boards can be read and have the columns
 * this script reads.
 *
 * @param {Object} cfg Config from readConfig_().
 * @return {{fa: Array<string>, dvp: Array<string>}} Column ids not found
 *     (warnings: those fields will read as empty).
 * @throws {Error} When a board can't be read, or the FA board has neither
 *     email column (then nobody could get a link).
 */
function checkColumns_(cfg) {
  const read = (boardId, ids, label) => {
    try {
      const found = readColumns_(cfg, boardId, ids).map((column) => column.id);
      return ids.filter((id) => found.indexOf(id) === -1);
    } catch (err) {
      throw new Error('Could not read the ' + label + ' board (' + errorKind_(err) + '): check MONDAY_API_TOKEN and ' + label + '_BOARD_ID');
    }
  };
  const missing = { fa: read(cfg.faBoardId, faReadColumnIds_(), 'FA'), dvp: read(cfg.dvpBoardId, dvpReadColumnIds_(), 'DVP') };
  const emailIds = Object.keys(FA_EMAIL_COLUMNS).map((key) => FA_EMAIL_COLUMNS[key]);
  if (emailIds.every((id) => missing.fa.indexOf(id) !== -1)) {
    throw new Error('The FA board has neither email column (' + emailIds.join(', ') + '), so nobody could get a link');
  }
  return missing;
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

/** @return {Array<string>} Every FA column id this script requests. */
function faReadColumnIds_() {
  return Object.keys(FA_COLUMNS).map((key) => FA_COLUMNS[key])
      .concat(Object.keys(FA_EMAIL_COLUMNS).map((key) => FA_EMAIL_COLUMNS[key]));
}

/** @return {Array<string>} Every DVP column id this script requests. */
function dvpReadColumnIds_() {
  return Object.keys(DVP_COLUMNS).map((key) => DVP_COLUMNS[key]);
}

// =============================================================================
// 7. Monday client (read-only: this file never sends a mutation)
// =============================================================================

/**
 * Sends one GraphQL query to Monday. Retries at most MAX_RETRIES times on
 * HTTP 429 or 5xx, honouring Retry-After up to RETRY_AFTER_MAX_S seconds. It
 * never logs: not the token, not the query, and not Monday's error messages,
 * which can echo column values.
 *
 * @param {Object} cfg Config from readConfig_() (for the token).
 * @param {string} query The GraphQL query.
 * @param {Object=} variables GraphQL variables.
 * @return {{data: ?Object, errors: Array<Object>, httpStatus: number,
 *     rateLimited: boolean}} httpStatus is 0 when the request could not be
 *     made at all.
 */
function mondayRequest_(cfg, query, variables) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': cfg.token, 'API-Version': MONDAY_API_VERSION },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true // read 4xx/5xx answers instead of throwing
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
    if (!(status === 429 || status >= 500) || attempt >= MAX_RETRIES) break;
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
 * How long to wait before a retry: Retry-After (seconds) capped at
 * RETRY_AFTER_MAX_S, or 1 s then 2 s when the header is absent.
 *
 * @param {HTTPResponse} response The 429 or 5xx response.
 * @param {number} attempt The retry about to be made (1 or 2).
 * @return {number} Milliseconds to sleep.
 */
function retryDelayMs_(response, attempt) {
  const header = headerValue_(response, 'retry-after');
  const seconds = Number(header);
  if (header !== '' && isFinite(seconds) && seconds >= 0) return Math.min(seconds, RETRY_AFTER_MAX_S) * 1000;
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
 * @return {string} The body text, or ''.
 */
function contentText_(response) {
  try {
    return String(response.getContentText());
  } catch (err) {
    return '';
  }
}

/**
 * The machine-readable code of one GraphQL error. Only this code is ever
 * logged; the message is not.
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
 * Throws a data-free Error unless a read fully succeeded. Reads are all or
 * nothing: a partial board must never replace a good cache.
 *
 * @param {Object} res Result of mondayRequest_().
 * @throws {Error} Kind monday_rate_limited, monday_unauthorized,
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
 * the cursor is null. Only the given column ids are requested.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} boardId The board to read.
 * @param {Array<string>} columnIds The only column ids to request.
 * @return {Array<Object>} Raw items: {id, name, created_at, column_values:
 *     [{id, type, text, value}]}.
 * @throws {Error} When any page can't be read, the board isn't found, or
 *     after MAX_PAGES pages.
 */
function readItems_(cfg, boardId, columnIds) {
  const fields = 'id name created_at column_values(ids: $c) { id type text value }';
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
 * Reads column definitions (id and type) from a board, for setup().
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} boardId The board.
 * @param {Array<string>} columnIds Column ids to look up; unknown ids are
 *     simply absent from the result.
 * @return {Array<{id: string, type: string}>} One entry per column found.
 * @throws {Error} When the request fails or the board isn't found.
 */
function readColumns_(cfg, boardId, columnIds) {
  const query = 'query ($b: ID!, $c: [String!]) { boards(ids: [$b]) { columns(ids: $c) { id type } } }';
  const res = mondayRequest_(cfg, query, { b: String(boardId), c: columnIds });
  assertRead_(res);
  const boards = res.data.boards;
  if (!Array.isArray(boards) || !boards.length || !boards[0]) throw fail_('monday_board_not_found');
  return (Array.isArray(boards[0].columns) ? boards[0].columns : [])
      .filter((column) => column && typeof column === 'object');
}

// =============================================================================
// 8. Building the views
// =============================================================================

/**
 * Reads both boards and rebuilds the cache. The caller must hold the script
 * lock (refresh() and lookup_() both do).
 *
 * @param {string} mode 'refresh' or 'rebuild' (for the log line).
 * @return {?{views: Object<string, Object>, featured: Object, stats: Object}}
 *     views: token -> entry; featured: the public list. null when the Script
 *     Properties are incomplete.
 * @throws {Error} A data-free Error when Monday or the cache fails.
 */
function rebuild_(mode) {
  const started = Date.now();
  const cfg = readConfig_();
  const problems = validateConfig_(cfg);
  if (problems.length) {
    // Problems name properties, never their values, so they are safe to log.
    console.error(JSON.stringify({ event: LOG_EVENT, mode: mode, error: 'config_invalid', problems: problems }));
    return null;
  }
  const stats = newStats_(mode);
  try {
    const built = buildViews_(cfg, stats);
    stats.stage = 'write_cache';
    stats.cacheLargestShard = writeCache_(built.views, built.featured);
    stats.stage = 'done';
    stats.ms = Date.now() - started;
    logRun_(stats);
    return { views: built.views, featured: built.featured, stats: stats };
  } catch (err) {
    stats.ms = Date.now() - started;
    const kind = errorKind_(err);
    logRun_(stats, kind);
    throw fail_(kind);
  }
}

/**
 * Reads Monday and builds token -> {apps: [...]} for every email address on
 * the FA board, and the public list.
 *
 *   1. Read the FA board (allow-listed columns + the two email columns).
 *   2. Read the DVP board and attach each request to its FA app(s) by name.
 *   3. For each FA row: build its view once, then add it to the list of every
 *      address on the row. Rows without an address can't be reached.
 *      Rows with Featured App status, or whose status was revoked, also go
 *      on the public list.
 *   4. Sort each list newest first.
 *
 * @param {Object} cfg Config from readConfig_() (already validated).
 * @param {Object} stats Run stats to fill.
 * @return {{views: Object<string, {apps: Array<Object>}>,
 *     featured: {updated: string, apps: Array<Object>}}} Token -> entry, and
 *     the public list.
 */
function buildViews_(cfg, stats) {
  stats.stage = 'read_fa';
  const faRows = uniqueById_(readItems_(cfg, cfg.faBoardId, faReadColumnIds_()));
  stats.faRows = faRows.length;

  stats.stage = 'read_dvp';
  const dvpRows = uniqueById_(readItems_(cfg, cfg.dvpBoardId, dvpReadColumnIds_()));
  stats.dvpRows = dvpRows.length;

  stats.stage = 'build';
  const dvpByApp = matchDvpToApps_(faRows, dvpRows, stats);
  const appsByToken = {};
  const featured = [];
  faRows.forEach((row) => {
    const listed = toPublicView_(row, stats);
    if (listed) featured.push(listed);

    const emails = emailsOfRow_(row);
    if (!emails.length) {
      stats.appsWithoutEmail++;
      return;
    }
    const view = toApplicantView(row, dvpByApp.get(String(row.id)) || [], stats);
    stats.appsServed++;
    emails.forEach((email) => {
      const token = tokenFor_(cfg.secret, email);
      if (!hasOwn_(appsByToken, token)) appsByToken[token] = [];
      appsByToken[token].push(view);
    });
  });

  const views = {};
  Object.keys(appsByToken).forEach((token) => {
    views[token] = { apps: appsByToken[token].sort(compareNewestFirst_) };
  });
  stats.addresses = Object.keys(views).length;
  stats.revoked = featured.filter((app) => app.status === 'revoked').length;
  stats.featured = featured.length - stats.revoked;
  return {
    views: views,
    featured: { updated: new Date().toISOString().slice(0, 19) + 'Z', apps: featured.sort(comparePublic_) }
  };
}

/**
 * Drops items without an id and repeated ids (a page boundary can repeat one).
 *
 * @param {Array<Object>} rows Raw items.
 * @return {Array<Object>} The items, first occurrence of each id kept.
 */
function uniqueById_(rows) {
  const seen = {};
  return rows.filter((row) => {
    if (!row || row.id === undefined || row.id === null) return false;
    const id = String(row.id);
    if (hasOwn_(seen, id)) return false;
    seen[id] = true;
    return true;
  });
}

// -----------------------------------------------------------------------------
// DVP requests -> FA apps
// -----------------------------------------------------------------------------

/**
 * Attaches each DVP request to the FA app(s) it belongs to. The DVP board has
 * no email and no link to the FA board, so the app name is the only key:
 *
 *   - a DVP name is cut at its first qualifier and split on "/":
 *       "Harbor Swap (RFQ request)"             -> ["harbor swap"]
 *       "Lumen Wallet / Lumen Pay (Lumen Labs)" -> ["lumen wallet", "lumen pay"]
 *       "Copperleaf (Oct request)"              -> ["copperleaf"]
 *   - an FA app answers to its full name and to its name cut the same way:
 *       "Copperleaf - Copperleaf Labs"          -> "copperleaf - copperleaf labs", "copperleaf"
 *   - a request goes to every FA app with an equal key (case and spacing
 *     ignored). There is no partial matching: "Quillpoint" does not
 *     match "Quillpoint Vaults". A request with no match is not shown to anyone and is
 *     counted as dvpUnmatched; renaming it on the DVP board to the app's name
 *     fixes that.
 *
 * @param {Array<Object>} faRows Raw FA items.
 * @param {Array<Object>} dvpRows Raw DVP items.
 * @param {Object} stats Run stats (dvpMatched, dvpUnmatched).
 * @return {Map<string, Array<Object>>} FA item id -> raw DVP items.
 */
function matchDvpToApps_(faRows, dvpRows, stats) {
  const appIdsByKey = new Map();
  faRows.forEach((row) => {
    [nameKey_(row.name), baseNameKey_(row.name)].forEach((key) => {
      if (key.length < MATCH_KEY_MIN) return;
      const ids = appIdsByKey.get(key) || [];
      if (ids.indexOf(String(row.id)) === -1) ids.push(String(row.id));
      appIdsByKey.set(key, ids);
    });
  });

  const byApp = new Map();
  dvpRows.forEach((dvpRow) => {
    const appIds = [];
    dvpNameKeys_(dvpRow.name).forEach((key) => {
      (appIdsByKey.get(key) || []).forEach((id) => {
        if (appIds.indexOf(id) === -1) appIds.push(id);
      });
    });
    if (!appIds.length) {
      stats.dvpUnmatched++;
      return;
    }
    stats.dvpMatched++;
    appIds.forEach((id) => byApp.set(id, (byApp.get(id) || []).concat([dvpRow])));
  });
  return byApp;
}

/**
 * A name for matching: Unicode-normalised, lower-cased, single-spaced.
 *
 * @param {*} name An item name.
 * @return {string} The key ('' for no name).
 */
function nameKey_(name) {
  return trimmed_(name).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A name cut at its first qualifier (see NAME_CUT_RE).
 *
 * @param {*} name An item name.
 * @return {string} The key ('' for no name).
 */
function baseNameKey_(name) {
  const key = nameKey_(name);
  const cut = NAME_CUT_RE.exec(key);
  return (cut ? key.slice(0, cut.index) : key).trim();
}

/**
 * The keys a DVP request name matches on: its base name, split on "/".
 *
 * @param {*} name A DVP item name.
 * @return {Array<string>} Keys of at least MATCH_KEY_MIN characters.
 */
function dvpNameKeys_(name) {
  return baseNameKey_(name).split('/').map((part) => part.trim()).filter((part) => part.length >= MATCH_KEY_MIN);
}

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
 * Parses a column's "value" field (normally a JSON string; an already parsed
 * value is accepted too).
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
 * A status column's label (Monday sends null when it is empty).
 *
 * @param {?Object} column Raw status column value.
 * @return {?string} The trimmed label, or null.
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
 * @return {boolean} True for '2026-10-18'; false for '2026-02-30'.
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
  if (isIsoDate_(t)) return Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)));
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
 * The latest value.changed_at among some columns, as a UTC date.
 *
 * @param {Array<?Object>} columns Raw column values (missing ones allowed).
 * @return {?string} 'YYYY-MM-DD', or null when none has a changed_at.
 */
function latestChangeDate_(columns) {
  let latest = null;
  columns.forEach((column) => {
    const value = column ? parseValue_(column.value) : null;
    const ms = value && typeof value === 'object' ? parseIsoMs_(value.changed_at) : null;
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
 * hasOwnProperty that is safe for any object (a label like "toString" must
 * not hit Object.prototype).
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
 * FA Status label -> state key. Empty: 'received'. Unknown: 'in_review',
 * counted in stats.unknownLabels.fa.
 *
 * @param {?string} label The label (null when empty).
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {string} The state key.
 */
function faState_(label, stats) {
  return stateFor_(label, FA_STATE_BY_LABEL, FA_STATE_EMPTY, FA_STATE_UNKNOWN, stats, 'fa');
}

/**
 * Testing Process label -> testing key. Empty: 'not_started'. Unknown:
 * 'in_progress', counted.
 *
 * @param {?string} label The label (null when empty).
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {string} The testing key.
 */
function testingState_(label, stats) {
  return stateFor_(label, TESTING_STATE_BY_LABEL, TESTING_STATE_EMPTY, TESTING_STATE_UNKNOWN, stats, 'testing');
}

/**
 * DVP Status label -> state key. Empty or unknown: 'in_review'; unknown labels
 * are counted.
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
 * Builds one application of the answer from a raw FA item. This is the
 * allow-list: only these fields ever leave Apps Script.
 *
 *   id, name, institution, type, faType, dvpStatus, submitted, state,
 *   lock {verified, amountMillions, confirmed}, testing, partyId,
 *   website, announcement, update {kind, date}, updated, dvp[]
 *
 * Texts are capped and empty ones become null. Links are https-only,
 * otherwise null. announcement is only sent once the app is on the public
 * list (approved, provisional or revoked). amountMillions is
 * only set when above 0. lock.confirmed is true when the FA Status says the
 * lock is in place (FA_LOCKED_LABELS). doGet adds history (see 8b). updated
 * is the latest change among FA Status,
 * Testing Process, Lock Verified and FA Link. dvp is newest first.
 *
 * @param {Object} row Raw FA item {id, name, column_values}.
 * @param {Array<Object>=} dvpRows Raw DVP items matched to this app.
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {Object} The application.
 */
function toApplicantView(row, dvpRows, stats) {
  const cols = columnMap_(row);
  const state = faState_(statusText_(cols[FA_COLUMNS.status]), stats);
  const amount = numberOf_(cols[FA_COLUMNS.lockedAmount]);
  const dvp = (Array.isArray(dvpRows) ? dvpRows : [])
      .map((dvpRow) => toDvpView_(dvpRow, stats))
      .sort(compareNewestFirst_);

  return {
    id: row && row.id !== undefined && row.id !== null ? String(row.id) : null,
    name: capText_(row && row.name, NAME_MAX),
    institution: capText_(textOf_(cols[FA_COLUMNS.institution]), INSTITUTION_MAX),
    type: capText_(statusText_(cols[FA_COLUMNS.type]), LABEL_MAX),
    faType: capText_(statusText_(cols[FA_COLUMNS.faType]), LABEL_MAX),
    dvpStatus: dvpStatusOf_(cols[FA_COLUMNS.dvpStatus], stats),
    submitted: dateOf_(cols[FA_COLUMNS.submitted]),
    state: state,
    lock: {
      verified: dateOf_(cols[FA_COLUMNS.lockVerified]),
      amountMillions: amount !== null && amount > 0 ? amount : null,
      // The FA Status says the lock is in place, even if Lock Verified has no date yet.
      confirmed: FA_LOCKED_LABELS.indexOf(statusText_(cols[FA_COLUMNS.status])) !== -1
    },
    testing: testingState_(statusText_(cols[FA_COLUMNS.testing]), stats),
    partyId: capText_(longTextOf_(cols[FA_COLUMNS.partyId]), PARTY_ID_MAX),
    website: httpsUrl_(linkOf_(cols[FA_COLUMNS.website]).url),
    announcement: hasOwn_(PUBLIC_STATUS_BY_STATE, state) ? httpsUrl_(linkOf_(cols[FA_COLUMNS.announcement]).url) : null,
    update: emailUpdate_(cols[FA_COLUMNS.sendEmail], stats),
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
 * The app's DVP status from the FA board's DVP Status column.
 *
 * @param {?Object} column Raw DVP Status column value.
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {?string} 'in_review', 'faac_approved' or 'declined'; null when
 *     empty or unknown.
 */
function dvpStatusOf_(column, stats) {
  const label = statusText_(column);
  if (!label) return null;
  if (hasOwn_(DVP_STATUS_BY_LABEL, label)) return DVP_STATUS_BY_LABEL[label];
  noteUnknownLabel_(stats, 'dvpStatus', label);
  return null;
}

/**
 * The latest email the committee sent, from the Send Email column: its kind
 * (see EMAIL_UPDATE_BY_LABEL) and the date the label was set.
 *
 * @param {?Object} column Raw Send Email column value.
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {?{kind: string, date: ?string}} null when the label sends no
 *     email (or is empty or unknown).
 */
function emailUpdate_(column, stats) {
  const label = statusText_(column);
  if (!label) return null;
  if (!hasOwn_(EMAIL_UPDATE_BY_LABEL, label)) {
    noteUnknownLabel_(stats, 'email', label);
    return null;
  }
  const kind = EMAIL_UPDATE_BY_LABEL[label];
  return kind ? { kind: kind, date: latestChangeDate_([column]) } : null;
}

/**
 * Builds one DVP request of the answer from a raw DVP item:
 * {id, name, state, submitted, finalApproval, requestUrl, requestRef, updated}.
 * finalApproval is only set once approved. requestUrl is https-only.
 *
 * @param {Object} row Raw DVP item {id, name, column_values}.
 * @param {Object=} stats Run stats, for unknown-label counting.
 * @return {Object} The DVP request.
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
 * Sort order for applications and DVP requests: newest submission first,
 * undated ones last, ties broken by the higher (newer) item id.
 *
 * @param {Object} a A view with submitted and id.
 * @param {Object} b A view with submitted and id.
 * @return {number} Negative when a comes first.
 */
function compareNewestFirst_(a, b) {
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

// -----------------------------------------------------------------------------
// The public list (the allow-list for everyone, field by field)
// -----------------------------------------------------------------------------

/**
 * One entry of the public list from a raw FA item, or null when the app
 * isn't listed (PUBLIC_STATUS_BY_STATE). Only these fields are ever made
 * public:
 *
 *   name        the item name
 *   type        the FA Type label (null when not set yet)
 *   status      'featured', 'provisional' or 'revoked'
 *   since       'YYYY-MM-DD': when the FA Status last changed to its
 *               current label (value.changed_at): the date the app was
 *               featured, or, for a revoked app, the date it was revoked...
 *   sinceExact  ...true then. Monday has no change date for rows imported
 *               when the board was created (July 2026), so `since` is the
 *               item's creation date instead and sinceExact is false: the
 *               app was featured (or revoked) on or before that day.
 *   partyIds    the Canton party IDs in the Party ID cell (PARTY_ID_FIND_RE)
 *   record      the FA Link (the public announcement), https only
 *
 * @param {Object} row Raw FA item {id, name, created_at, column_values}.
 * @param {Object=} stats Run stats (partyIdUnreadable).
 * @return {?Object} The entry, or null.
 */
function toPublicView_(row, stats) {
  const cols = columnMap_(row);
  const state = faState_(statusText_(cols[FA_COLUMNS.status])); // unknown labels are counted by toApplicantView
  if (!hasOwn_(PUBLIC_STATUS_BY_STATE, state)) return null;
  const changed = latestChangeDate_([cols[FA_COLUMNS.status]]);
  const createdMs = parseIsoMs_(row ? row.created_at : null);
  const partyText = longTextOf_(cols[FA_COLUMNS.partyId]);
  const partyIds = partyIdsOf_(partyText);
  if (partyText && !partyIds.length && stats) stats.partyIdUnreadable++;
  return {
    name: capText_(row && row.name, NAME_MAX),
    type: capText_(statusText_(cols[FA_COLUMNS.faType]), LABEL_MAX),
    status: PUBLIC_STATUS_BY_STATE[state],
    since: changed || (createdMs === null ? null : new Date(createdMs).toISOString().slice(0, 10)),
    sinceExact: Boolean(changed),
    partyIds: partyIds,
    record: httpsUrl_(linkOf_(cols[FA_COLUMNS.announcement]).url)
  };
}

/**
 * The Canton party IDs found in a Party ID cell, in order, without repeats,
 * at most PARTY_IDS_MAX.
 *
 * @param {string} text The cell's text.
 * @return {Array<string>} The IDs (empty when none is well formed).
 */
function partyIdsOf_(text) {
  const ids = [];
  (String(text || '').match(PARTY_ID_FIND_RE) || []).forEach((id) => {
    if (ids.length < PARTY_IDS_MAX && ids.indexOf(id) === -1) ids.push(id);
  });
  return ids;
}

/**
 * Sort order for the public list: apps with Featured App status before
 * revoked ones; within each, the most recent date first, undated ones last,
 * then by name.
 *
 * @param {Object} a A public entry.
 * @param {Object} b A public entry.
 * @return {number} Negative when a comes first.
 */
function comparePublic_(a, b) {
  const revokedA = a.status === 'revoked';
  if (revokedA !== (b.status === 'revoked')) return revokedA ? 1 : -1;
  if (a.since !== b.since) {
    if (!a.since) return 1;
    if (!b.since) return -1;
    return a.since < b.since ? 1 : -1;
  }
  return String(a.name || '').localeCompare(String(b.name || ''));
}

// =============================================================================
// 8b. History (Monday's activity log, read per link)
// =============================================================================
//
// When a link is opened, the changes of its own items are read from Monday's
// activity log in one query per board (item_ids = that link's FA items and
// their DVP requests; column_ids = FA_HISTORY_COLUMNS / DVP_HISTORY_COLUMNS),
// then cached under the token for HISTORY_TTL_S. Only state keys, dates,
// amounts and the FA Type label leave this script: never who made a change,
// never the item name or any other column. History is optional: on any
// failure the answer goes out without it.

/**
 * Adds each application's history to a found answer.
 *
 * @param {string} token The link's token.
 * @param {{found: boolean, apps: Array<Object>}} answer From lookup_().
 * @return {Object} The answer, each app with history: [events], newest
 *     first; the answer unchanged when the history can't be read.
 */
function withHistory_(token, answer) {
  try {
    let history = readHistoryCache_(token);
    if (!history) {
      history = readHistory_(readConfig_(), answer.apps);
      if (!history) return answer;
      writeHistoryCache_(token, history);
    }
    return {
      found: true,
      apps: answer.apps.map((app) => {
        const events = hasOwn_(history, app.id) && Array.isArray(history[app.id]) ? history[app.id] : [];
        return Object.assign({}, app, { history: events });
      })
    };
  } catch (err) {
    console.error(JSON.stringify({ event: LOG_EVENT, mode: 'history', error: errorKind_(err) }));
    return answer;
  }
}

/**
 * Reads the history of some applications (and their DVP requests) from
 * Monday's activity log.
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {Array<Object>} apps Applications of one link (from the cache).
 * @return {?Object<string, Array<Object>>} App id -> events, newest first,
 *     at most HISTORY_MAX_PER_APP each; null when Monday can't be read.
 */
function readHistory_(cfg, apps) {
  const faIds = [];
  const dvpOwners = {}; // DVP request id -> ids of the apps it is attached to
  apps.forEach((app) => {
    if (!app || !BOARD_ID_RE.test(String(app.id))) return;
    faIds.push(String(app.id));
    (Array.isArray(app.dvp) ? app.dvp : []).forEach((request) => {
      const id = request ? String(request.id) : '';
      if (!BOARD_ID_RE.test(id)) return;
      if (!hasOwn_(dvpOwners, id)) dvpOwners[id] = [];
      dvpOwners[id].push(String(app.id));
    });
  });
  const result = {};
  faIds.forEach((id) => { result[id] = []; });
  if (!faIds.length) return result;

  const faLogs = readActivityLogs_(cfg, cfg.faBoardId, faIds, FA_HISTORY_COLUMNS);
  if (!faLogs) return null;
  faLogs.forEach((log) => {
    const event = faHistoryEvent_(log, result);
    if (event) result[event.item].push(event.event);
  });

  const dvpIds = Object.keys(dvpOwners);
  if (dvpIds.length) {
    const dvpLogs = readActivityLogs_(cfg, cfg.dvpBoardId, dvpIds, DVP_HISTORY_COLUMNS);
    if (!dvpLogs) return null;
    dvpLogs.forEach((log) => {
      const event = dvpHistoryEvent_(log, dvpOwners);
      if (event) dvpOwners[event.item].forEach((appId) => result[appId].push(event.event));
    });
  }

  Object.keys(result).forEach((id) => {
    result[id] = result[id].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, HISTORY_MAX_PER_APP);
  });
  return result;
}

/**
 * Reads the activity log of some items of one board, newest first, page by
 * page. item_ids is never empty: an empty list would mean "every item".
 *
 * @param {Object} cfg Config from readConfig_().
 * @param {string} boardId The board.
 * @param {Array<string>} itemIds The items (at least one).
 * @param {Array<string>} columnIds The only columns whose changes are read.
 * @return {?Array<Object>} Raw log entries {event, created_at, data}, or
 *     null when a page can't be read.
 */
function readActivityLogs_(cfg, boardId, itemIds, columnIds) {
  if (!itemIds.length) return [];
  const query = 'query ($b: [ID!], $i: [ID!], $c: [String!], $l: Int, $p: Int) { boards(ids: $b) { ' +
      'activity_logs(item_ids: $i, column_ids: $c, limit: $l, page: $p) { event created_at data } } }';
  const logs = [];
  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    const res = mondayRequest_(cfg, query, { b: [String(boardId)], i: itemIds, c: columnIds, l: HISTORY_PAGE_LIMIT, p: page });
    try {
      assertRead_(res);
    } catch (err) {
      console.error(JSON.stringify({ event: LOG_EVENT, mode: 'history', error: errorKind_(err) }));
      return null;
    }
    const boards = res.data.boards;
    const entries = Array.isArray(boards) && boards[0] && Array.isArray(boards[0].activity_logs) ? boards[0].activity_logs : null;
    if (!entries) return null;
    entries.forEach((entry) => logs.push(entry));
    if (entries.length < HISTORY_PAGE_LIMIT) break;
  }
  return logs;
}

/**
 * One FA log entry as a history event for an app in `allowed`.
 *
 *   status        {at, kind, to, from}  history step keys (FA_HISTORY_STATUS_BY_LABEL)
 *   testing       {at, kind, to}        testing state keys
 *   lock_verified {at, kind, date}      Lock Verified set from an empty cell (not the daily re-stamps)
 *   lock_amount   {at, kind, amount}    Locked amount (Million) first set above 0 (from empty or 0)
 *   email         {at, kind, to}        the committee email kind (EMAIL_UPDATE_BY_LABEL)
 *   fa_type       {at, kind, text}      the FA Type label (already shown on the page)
 *   dvp_status    {at, kind, to}        DVP status keys (DVP_STATUS_BY_LABEL)
 *
 * Cleared cells, labels that send or mean nothing, and changes that don't
 * change the key give null.
 *
 * @param {Object} log Raw entry {event, created_at, data}.
 * @param {Object<string, *>} allowed App ids this link may see.
 * @return {?{item: string, event: Object}} The event and its app id.
 */
function faHistoryEvent_(log, allowed) {
  const entry = logEntry_(log, allowed);
  if (!entry) return null;
  const at = entry.at;
  let event = null;
  switch (entry.column) {
    case FA_COLUMNS.status: {
      const to = historyKey_(logLabel_(entry.value), FA_HISTORY_STATUS_BY_LABEL, FA_STATE_UNKNOWN);
      const from = historyKey_(logLabel_(entry.previous), FA_HISTORY_STATUS_BY_LABEL, FA_STATE_UNKNOWN);
      if (to && to !== from) event = { at: at, kind: 'status', to: to, from: from };
      break;
    }
    case FA_COLUMNS.testing: {
      const to = historyKey_(logLabel_(entry.value), TESTING_STATE_BY_LABEL, TESTING_STATE_UNKNOWN);
      const from = historyKey_(logLabel_(entry.previous), TESTING_STATE_BY_LABEL, TESTING_STATE_UNKNOWN);
      if (to && to !== from) event = { at: at, kind: 'testing', to: to };
      break;
    }
    case FA_COLUMNS.lockVerified: {
      // Only a first verification (from an empty cell): an automation moves
      // this date forward every day, which would bury every other change.
      const date = logDate_(entry.value);
      if (date && !logDate_(entry.previous)) event = { at: at, kind: 'lock_verified', date: date };
      break;
    }
    case FA_COLUMNS.lockedAmount: {
      // Only an amount first recorded (from empty or 0), for the same reason.
      const amount = logNumber_(entry.value);
      const before = logNumber_(entry.previous);
      if (amount !== null && amount > 0 && !(before !== null && before > 0)) event = { at: at, kind: 'lock_amount', amount: amount };
      break;
    }
    case FA_COLUMNS.sendEmail: {
      const label = logLabel_(entry.value);
      const kind = hasOwn_(EMAIL_UPDATE_BY_LABEL, label) ? EMAIL_UPDATE_BY_LABEL[label] : null;
      if (kind) event = { at: at, kind: 'email', to: kind };
      break;
    }
    case FA_COLUMNS.faType: {
      const text = capText_(logLabel_(entry.value), LABEL_MAX);
      if (text) event = { at: at, kind: 'fa_type', text: text };
      break;
    }
    case FA_COLUMNS.dvpStatus: {
      const label = logLabel_(entry.value);
      if (hasOwn_(DVP_STATUS_BY_LABEL, label)) event = { at: at, kind: 'dvp_status', to: DVP_STATUS_BY_LABEL[label] };
      break;
    }
    default:
      break;
  }
  return event ? { item: entry.item, event: event } : null;
}

/**
 * One DVP board log entry (Status column) as a history event:
 * {at, kind: 'dvp_state', to, request} with the DVP state key and request id.
 *
 * @param {Object} log Raw entry {event, created_at, data}.
 * @param {Object<string, *>} allowed DVP request ids this link may see.
 * @return {?{item: string, event: Object}} The event and its request id.
 */
function dvpHistoryEvent_(log, allowed) {
  const entry = logEntry_(log, allowed);
  if (!entry || entry.column !== DVP_COLUMNS.status) return null;
  const to = historyKey_(logLabel_(entry.value), DVP_STATE_BY_LABEL, DVP_STATE_UNKNOWN);
  const from = historyKey_(logLabel_(entry.previous), DVP_STATE_BY_LABEL, DVP_STATE_UNKNOWN);
  if (!to || to === from) return null;
  return { item: entry.item, event: { at: entry.at, kind: 'dvp_state', to: to, request: entry.item } };
}

/**
 * Reads the parts of a log entry this script uses. Entries for other items,
 * other events or with an unreadable time are dropped.
 *
 * @param {Object} log Raw entry {event, created_at, data}.
 * @param {Object<string, *>} allowed Item ids this link may see.
 * @return {?{item: string, column: string, at: string, value: *, previous: *}}
 */
function logEntry_(log, allowed) {
  if (!log || log.event !== 'update_column_value') return null;
  const data = parseJson_(log.data);
  if (!data || typeof data !== 'object') return null;
  const item = data.pulse_id !== undefined && data.pulse_id !== null ? String(data.pulse_id) : '';
  if (!item || !hasOwn_(allowed, item)) return null; // defence in depth: item_ids already limits this
  const at = logTime_(log.created_at);
  if (!at) return null;
  return { item: item, column: String(data.column_id || ''), at: at, value: data.value, previous: data.previous_value };
}

/**
 * Monday's activity log time (a count of 100-nanosecond units, e.g.
 * "17949189078597722") as an ISO timestamp to the second.
 *
 * @param {*} raw The created_at field.
 * @return {?string} E.g. '2026-11-17T12:35:07Z', or null.
 */
function logTime_(raw) {
  const text = trimmed_(String(raw === undefined || raw === null ? '' : raw));
  if (!/^\d{16,18}$/.test(text)) return null;
  const ms = Math.floor(Number(text) / 10000);
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (!isFinite(ms) || year < 2020 || year > 2100) return null;
  return date.toISOString().slice(0, 19) + 'Z';
}

/**
 * The label text of a status value in the activity log ({label: {text}}).
 *
 * @param {*} value The value or previous_value of a log entry.
 * @return {string} The trimmed label, or '' when empty.
 */
function logLabel_(value) {
  if (!value || typeof value !== 'object' || !value.label) return '';
  return typeof value.label === 'string' ? value.label.trim() : trimmed_(value.label.text);
}

/**
 * The date of a date value in the activity log ({date: '2026-11-16'}).
 *
 * @param {*} value The value or previous_value of a log entry.
 * @return {string} 'YYYY-MM-DD', or '' when empty or invalid.
 */
function logDate_(value) {
  const date = value && typeof value === 'object' ? trimmed_(value.date) : '';
  return isIsoDate_(date) ? date : '';
}

/**
 * The number of a numbers value in the activity log ({value: 1.5}).
 *
 * @param {*} value The value of a log entry.
 * @return {?number} A finite number, or null.
 */
function logNumber_(value) {
  const raw = value && typeof value === 'object' ? value.value : value;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return isFinite(n) ? n : null;
}

/**
 * A label's key in a map, `unknown` for any other label, '' when empty.
 *
 * @param {string} label The label.
 * @param {Object<string, ?string>} map Label -> key.
 * @param {string} unknown The key for labels missing from the map.
 * @return {string} The key, or ''.
 */
function historyKey_(label, map, unknown) {
  if (!label) return '';
  return hasOwn_(map, label) ? map[label] || '' : unknown;
}

/**
 * The cached history of a link.
 *
 * @param {string} token The link's token.
 * @return {?Object<string, Array<Object>>} App id -> events, or null on a miss.
 */
function readHistoryCache_(token) {
  const raw = CacheService.getScriptCache().get(HISTORY_KEY_PREFIX + token);
  if (typeof raw !== 'string') return null;
  const map = parseJson_(raw);
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}

/**
 * Caches a link's history for HISTORY_TTL_S (skipped if over the value limit).
 *
 * @param {string} token The link's token.
 * @param {Object<string, Array<Object>>} history App id -> events.
 */
function writeHistoryCache_(token, history) {
  const value = JSON.stringify(history);
  if (utf8Length_(value) > CACHE_VALUE_MAX_BYTES) return;
  CacheService.getScriptCache().put(HISTORY_KEY_PREFIX + token, value, HISTORY_TTL_S);
}

// =============================================================================
// 9. Cache
// =============================================================================

/**
 * The cache key of the shard that holds a token: CACHE_PREFIX plus the char
 * code of its first character (64 shards; char codes avoid any question of
 * key case-sensitivity).
 *
 * @param {string} token A token matching TOKEN_RE.
 * @return {string} E.g. 'fa2:65' for a token starting with 'A'.
 */
function shardKeyFor_(token) {
  return CACHE_PREFIX + token.charCodeAt(0);
}

/**
 * Writes all 64 shards in one putAll, {} for empty ones, so addresses removed
 * from Monday lose access on the next run. Each value is a JSON map of
 * token -> {apps}, and expires after CACHE_TTL_S.
 *
 * The public list goes in the same putAll: its rows in chunks of at most
 * PUBLIC_CHUNK_MAX_BYTES under PUBLIC_KEY + ':0', ':1'..., and an index
 * {updated, chunks} under PUBLIC_KEY.
 *
 * @param {Object<string, Object>} views Token -> entry.
 * @param {{updated: string, apps: Array<Object>}} featured The public list.
 * @return {number} Size in bytes of the largest shard (for the log).
 * @throws {Error} 'cache_shard_too_large' if a shard exceeds the value limit.
 */
function writeCache_(views, featured) {
  const shards = {};
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    shards[shardKeyFor_(BASE64URL_ALPHABET.charAt(i))] = {};
  }
  Object.keys(views).forEach((token) => {
    const key = shardKeyFor_(token);
    if (hasOwn_(shards, key)) shards[key][token] = views[token];
  });

  const values = {};
  let largest = 0;
  Object.keys(shards).forEach((key) => {
    values[key] = JSON.stringify(shards[key]);
    largest = Math.max(largest, utf8Length_(values[key]));
  });
  if (largest > CACHE_VALUE_MAX_BYTES) throw fail_('cache_shard_too_large');

  const chunks = chunkRows_(featured.apps, PUBLIC_CHUNK_MAX_BYTES);
  if (chunks.length > PUBLIC_CHUNKS_MAX) throw fail_('cache_public_too_large');
  chunks.forEach((rows, i) => { values[PUBLIC_KEY + ':' + i] = JSON.stringify(rows); });
  values[PUBLIC_KEY] = JSON.stringify({ updated: featured.updated, chunks: chunks.length });

  CacheService.getScriptCache().putAll(values, CACHE_TTL_S);
  return largest;
}

/**
 * Splits rows into chunks whose JSON stays under maxBytes (one row is far
 * smaller: every field is capped). Always at least one chunk.
 *
 * @param {Array<Object>} rows The rows.
 * @param {number} maxBytes The byte limit per chunk.
 * @return {Array<Array<Object>>} The chunks, in order.
 */
function chunkRows_(rows, maxBytes) {
  const chunks = [[]];
  let size = 2; // "[]"
  rows.forEach((row) => {
    const bytes = utf8Length_(JSON.stringify(row)) + 1; // and its comma
    if (chunks[chunks.length - 1].length && size + bytes > maxBytes) {
      chunks.push([]);
      size = 2;
    }
    chunks[chunks.length - 1].push(row);
    size += bytes;
  });
  return chunks;
}

/**
 * The public list from the cache.
 *
 * @return {?{updated: ?string, apps: Array<Object>}} null on a miss (no
 *     index, or a chunk missing or unreadable).
 */
function readPublicCache_() {
  const cache = CacheService.getScriptCache();
  const index = parseJson_(cache.get(PUBLIC_KEY));
  const count = index && typeof index === 'object' ? index.chunks : 0;
  if (!Number.isInteger(count) || count < 1 || count > PUBLIC_CHUNKS_MAX) return null;
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(PUBLIC_KEY + ':' + i);
  const values = cache.getAll(keys) || {};
  const apps = [];
  for (let i = 0; i < keys.length; i++) {
    const rows = parseJson_(values[keys[i]]);
    if (!Array.isArray(rows)) return null;
    rows.forEach((row) => apps.push(row));
  }
  return { updated: typeof index.updated === 'string' ? index.updated : null, apps: apps };
}

/**
 * Reads the shard that would hold a token.
 *
 * @param {string} token A token matching TOKEN_RE.
 * @return {?Object<string, Object>} The shard's token -> entry map, or null
 *     when the shard is missing or unreadable (a cache miss).
 */
function readShard_(token) {
  const raw = CacheService.getScriptCache().get(shardKeyFor_(token));
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
 * A fresh stats object for one run. Counts only.
 *
 * @param {string} mode 'refresh' or 'rebuild'.
 * @return {Object} The stats.
 */
function newStats_(mode) {
  return {
    mode: mode,
    stage: 'start',
    faRows: 0,            // FA items read
    dvpRows: 0,           // DVP items read
    appsServed: 0,        // FA rows with at least one email address
    appsWithoutEmail: 0,  // FA rows nobody can reach (no address on the row)
    addresses: 0,         // distinct addresses that can get a link
    dvpMatched: 0,        // DVP requests attached to at least one FA app
    dvpUnmatched: 0,      // DVP requests whose name matches no FA app
    featured: 0,          // apps on the public list with Featured App status
    revoked: 0,           // apps on the public list whose status was revoked
    partyIdUnreadable: 0, // of those, apps whose Party ID cell holds no well-formed ID
    cacheLargestShard: 0, // bytes
    ms: 0,
    unknownLabels: { fa: {}, testing: {}, dvp: {}, dvpStatus: {}, email: {} }
  };
}

/**
 * Prints one JSON line for a run: counts and unknown board labels only.
 * Failed runs go to console.error, with the error kind and the stage reached.
 *
 * @param {Object} stats Run stats from newStats_().
 * @param {string=} errorKind Short error kind when the run failed.
 */
function logRun_(stats, errorKind) {
  const line = { event: LOG_EVENT, mode: String(stats.mode) };
  Object.keys(stats).forEach((key) => {
    if (typeof stats[key] === 'number') line[key] = stats[key];
  });
  line.unknownLabels = {
    fa: countsOnly_(stats.unknownLabels.fa),
    testing: countsOnly_(stats.unknownLabels.testing),
    dvp: countsOnly_(stats.unknownLabels.dvp),
    dvpStatus: countsOnly_(stats.unknownLabels.dvpStatus),
    email: countsOnly_(stats.unknownLabels.email)
  };
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
 * Counts a board label that has no mapping. Board labels are not applicant
 * data, so they may be logged (capped at LOG_LABEL_MAX characters).
 *
 * @param {Object=} stats Run stats (nothing happens without them).
 * @param {string} bucket 'fa', 'testing', 'dvp', 'dvpStatus' or 'email'.
 * @param {string} label The unknown label.
 */
function noteUnknownLabel_(stats, bucket, label) {
  if (!stats || !stats.unknownLabels || !stats.unknownLabels[bucket]) return;
  const map = stats.unknownLabels[bucket];
  const key = label.slice(0, LOG_LABEL_MAX);
  const safeKey = key === '__proto__' ? '_proto_' : key; // never touch the prototype
  map[safeKey] = (hasOwn_(map, safeKey) ? map[safeKey] : 0) + 1;
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
 * Restricts a code to a short, safe set of characters before it is logged.
 *
 * @param {*} code An error code or kind.
 * @return {string} Letters, digits and _ . : - only, at most 80 characters,
 *     or 'unknown'.
 */
function safeCode_(code) {
  const cleaned = String(code === undefined || code === null ? '' : code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
  return cleaned || 'unknown';
}
