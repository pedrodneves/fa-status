# FA Status Portal: design

The build brief, the Monday API facts verified on the sandbox (Appendix A) and the decisions made while building (Appendix B). Code comments refer to these appendices.

## What we're building

A status page for Featured App applicants. Each FA application gets a private link, `https://status.<domain>/#<code>`. Opening it shows that application's status, and later its DVP requests. There is no sign-in: having the link is enough. The committee keeps working in Monday exactly as today.

## Architecture

- **GitHub Pages** (`docs/`): a static page, the same for everyone. No applicant data and no secrets, so the repo can be public.
- **Google Apps Script web app** (`apps-script/`): holds the Monday API token, answers one link at a time, and runs a 10-minute job.
- **Monday**: the source of truth.

**Page view:** the browser loads the page from GitHub Pages → `status.js` reads the code after `#` (browsers never send it to GitHub) → `GET <apps-script /exec URL>?link=<code>` → `doGet` looks the code up in the cache → returns only that application's allow-listed fields → the page renders. This takes about 1–2 s, so show "Loading your application…" meanwhile.

**Every 10 minutes** (time-driven trigger → `refresh()`): read both boards → give every FA row with an empty Status link a new code and write the link back → on new rows, optionally set Send Email to "Status link" so Monday's Gmail automation emails it → rebuild the cache.

## Repo layout

```
docs/                 GitHub Pages (Settings → Pages → Deploy from a branch → main, /docs)
  index.html
  styles.css
  config.js           apiUrl, supportEmail, reapplyUrl
  status.js
  404.html
  robots.txt          Disallow: /
apps-script/
  Code.gs
  appsscript.json
README.md
```

## Monday facts (read 16 Nov 2026)

- Account plan: Enterprise, so 25,000 API calls a day and 5,000 a minute. A 10-minute refresh uses about 300 calls a day.
- FA board: **Featured App Submissions**, id `18420896395`, 422 items. Read with `boards(ids:) { items_page(limit: 500) }`, then `next_items_page(cursor:, limit: 500)` until the cursor is null.
- DVP board: **Asset Moving Status Requests**, id `18436778970`, 24 items.
- On 5 Nov, 40 FA rows had no email, so their link can't be emailed.

### FA columns the portal may read (the allow-list)

Request only these column ids in the query.

| Field | Column id | Notes |
|---|---|---|
| App name | `name` | item name |
| Institution | `text_mm4k2vch` | |
| FA Status | `color_mm4kmej3` | mapped to a state key (below) |
| Type | `color_mm4kpp3q` | Non-Issuer / Asset Issuer |
| Submitted | `date_mm4kw11a` | "Time stamp" |
| Lock verified | `date_mm4kpckv` | |
| Locked amount | `numeric_mm4k6919` | millions of CC |
| Testing Process | `color_mm6be9ge` | Sent Email / Pending Review / Stuck / Done / empty |
| Party ID | `long_text_mm4kq322` | |
| Product site | `link_mm4kmq24` | link column |
| Announcement | `link_mm6hfp5g` | "FA Link"; only send when approved |
| Send Email | `color_mm6eay19` | written only, to trigger the email; never sent to the page |
| Status link | new link column | create it, then put its id in `STATUS_LINK_COLUMN_ID` |

### Must never leave Apps Script

Email (`email_mm4ke170`), Emails for Responsible Persons (`text_mm4kvrar`), Entry ID (`text_mm51m9b1`, used to match form submissions), FAAC Thoughs (`text_mm54j2kf`), FAAC Rec (`color_mm54jfa5`), Tester (`multiple_person_mm543hv0`), Testing File (`file_mm6425eg`), Slack Username / Slack Thread TS / Send Slack (`text_mm63jakx`, `text_mm6hdmf0`, `color_mm6ebfn3`), Tier (`color_mm7e35qc`), Sponsor, Sponsors, Tags, Shared w/ Tokenomics, Locking PartyIDs, App Operations PartyIDs, and all long-form answers.

### DVP board columns

Submission Date `date_mm8dsx4y`, Final Approval Date `date_mm8dm7a0`, Request Link `link_mm8rp25j`, Status `color_mm8dhgvr` with labels New Submission, FAAC Approval, Tokenomics Apporval (sic; also accept "Tokenomics Approval"), Denied, Closed.

There's no link from DVP requests to FA rows yet. Phase 2 adds a Connect boards column on the DVP board; read it with `... on BoardRelationValue { linked_item_ids }`.

### Value shapes

Verified on a duplicate of the FA board: see Appendix A.

## State mapping

The backend sends state keys; all wording lives in `status.js`.

| FA Status label | state | Pill | Message |
|---|---|---|---|
| (empty) | `received` | Received (info) | Your application has been received and is waiting for committee review. |
| 0-Locked+Needs Review, 1-Needs Review | `in_review` | In committee review (info) | The Featured App Committee is reviewing your application. |
| 1b-FAAC Approved-waiting on tokenomics | `with_tokenomics` | With Tokenomics Committee (info) | The Featured App Committee approved your application. The Tokenomics Committee is doing the final review. |
| 2-Approved | `approved` | Approved (ok) | Your app has Featured App status. Link to the public announcement. |
| 3-CIP-0116-paused | `on_hold` | On hold (warn) | Review is paused while CIP-0116 is resolved. This page will update when review resumes. |
| 4-No | `not_approved` | Not approved (bad) | The committee did not approve this application. Contact details for questions. |
| 5-Revoked | `revoked` | Featured status revoked (bad) | This app's Featured App status has been revoked. Contact details for questions. |
| 6-Withdrawn | `withdrawn` | Withdrawn (idle) | This application was withdrawn. |
| 7-Closed-new-process | `closed_process` | Closed: process changed (idle) | Closed when the review process changed. Link to https://canton.foundation/featured-app-request/ |

Any other label: treat it as `in_review` and log the label.

- **Testing:** empty → `not_started`; Sent Email → `action_needed` ("We emailed you about testing access"); Pending Review or Stuck → `in_progress`; Done → `complete`.
- **DVP:** New Submission → `in_review`; FAAC Approval → `with_tokenomics`; Tokenomics Apporval → `approved`; Denied → `not_approved`; Closed → `closed`.

## Apps Script

**Script Properties**

- `MONDAY_API_TOKEN`
- `STATUS_LINK_COLUMN_ID`
- `SITE_URL`
- `SEND_LINK_EMAIL`: false until the Gmail automation exists.
- `EMAIL_NEW_ROWS_FROM`: an ISO date. Only rows created on or after it get the automatic email; the team sends existing rows their link.

**Functions**

- `refresh()`: runs on the trigger every 10 minutes.
  - Use LockService so runs never overlap.
  - Read both boards, requesting only the allow-listed column ids.
  - For each FA row with an empty Status link, make a new code and write `{url: SITE_URL + "#" + code, text: "Status link"}` with `change_multiple_column_values`.
    - Batch about 20 writes per request using aliases.
    - Cap each run (for example 200 rows), so the backfill spreads over a few runs.
  - If `SEND_LINK_EMAIL` is true and the row's `created_at` is on or after `EMAIL_NEW_ROWS_FROM`, also set Send Email to "Status link". Never create labels through the API.
  - Rebuild the cache.
  - Log counts only, never codes or names.
- `doGet(e)`:
  - Check `e.parameter.link` against `/^[A-Za-z0-9_-]{22}$/`.
  - Read the cache. On a miss, take the lock, rebuild from Monday (read-only) and try again.
  - Return JSON with ContentService. An unknown code gets `{found: false}`. Never return error details.
- `toApplicantView(row, dvpRows)`: the allow-list.
- `setup()`: checks the properties, creates the trigger once, and runs `refresh()`.

**Codes:** 22 characters of base64url taken from a SHA-256 of two `Utilities.getUuid()` values, about 132 bits.

**Cache (CacheService, script cache):**

- Limits: 100 KB per key, 1,000 items in total, at most 6 hours before expiry, and entries can be evicted early.
- Store the views in 64 shards keyed by the code's first character.
- Write every shard on each run, with `{}` for empty ones, so cleared codes disappear.
- Set expiry to 21600 s.

**Quotas (Workspace accounts):** 100,000 UrlFetch calls a day, 6 hours of trigger runtime a day, 6 minutes per execution, 30 simultaneous executions.

**Deploy:**

- Web app → Execute as: me (a shared account such as ops@canton.foundation) → Who has access: Anyone.
- After changing code: Manage deployments → Edit → New version. The trigger runs the latest saved code, but the web app runs the deployed version.

## Response contract

```json
{
  "found": true,
  "app": {
    "name": "Harbor Swap",
    "institution": "Fernway Labs",
    "type": "Non-Issuer",
    "submitted": "2026-10-14",
    "state": "with_tokenomics",
    "lock": { "verified": "2026-10-18", "amountMillions": 1.5 },
    "testing": "complete",
    "partyId": "harborswap-1::1220…",
    "website": "https://harborswap.example",
    "announcement": null,
    "updated": "2026-11-03",
    "dvp": []
  }
}
```

An unknown code gets `{ "found": false }`.

## Frontend

- **config.js:** `apiUrl` (the /exec URL), `supportEmail`, `reapplyUrl`.
- **status.js:**
  - Read the code from `location.hash` (`#<code>` or `#<code>/dvp-<id>`).
  - Fetch with a plain GET and no custom headers, so Apps Script's CORS handling works.
  - States: no code, loading, found, not found, network error. Add a DVP detail view, and handle `hashchange`.
  - Build the DOM with `textContent` only, never `innerHTML` with data. Only allow https links.
- **index.html:**
  - Meta tags: `<meta name="robots" content="noindex">` and `<meta name="referrer" content="no-referrer">`.
  - A CSP meta tag with `connect-src https://script.google.com https://script.googleusercontent.com`.
  - System fonts.
- **Look:** follow the v0.3 mockup: status box with a pill, a timeline of steps, a "Private link" header and the footer note about sharing.

## Before go-live (team)

- Google Workspace allows web apps open to "Anyone". This depends on the sharing settings.
- Add the Status link column, plus a "Status link" label on Send Email with its Gmail automation (copy the Endorsements one).
- A Monday account limited to the two boards, for the API token.
- A custom domain CNAME in Cloudflare pointing to canton-foundation.github.io.

## Development rules

- Don't write to the production boards. Test writes on a duplicate of the FA board.
- Test `refresh()` and `doGet()` in Node with mocked Google services and synthetic data. Test the page with Playwright and mocked API answers.
- Comment the code clearly and keep it clean and well-structured. Apps Script and the page are JavaScript, not Python.

---

## Appendix A: verified on the sandbox (16 Nov 2026, `API-Version: 2026-10`)

**Sandbox boards** (structure-only copies, synthetic rows, no applicant data; same column ids as production):

- FA sandbox `18440148669`, with a Status link column `link_mm95vm0` and a "Status link" label on Send Email.
- DVP sandbox `18440148702`, with a Connect boards column `board_relation_mm95ygkj` pointing at the FA sandbox.
- Copied Gmail/Slack automations there are inactive or not connected; the copied "notify Tester" one was deactivated.

**Request basics:** `POST https://api.monday.com/v2`, headers `Authorization: <token>` (no "Bearer") and `API-Version: 2026-10` (the current stable version; 2027-01 is only a release candidate). Variables are supported; `JSON` variables are passed as JSON-encoded strings.

**Read shapes** (`column_values(ids: [...]) { id type text value }`):

| Type | `text` | `value` |
|---|---|---|
| status | the label, or `null` when empty | `{"index":9}`, sometimes with `"changed_at"`, or `null` |
| date | `"2026-10-18"` or `""` | `{"date":"2026-10-18"}`, sometimes with `"time":null`, `"icon":""` or `"changed_at"`, or `null` |
| numbers | `"1.5"`, `"2"` or `""` | `"\"1.5\""` (a JSON string), or `null` |
| text | the text | `"\"Fernway Labs\""` |
| long_text | the text | `{"text":"..."}`, sometimes with `"changed_at"` |
| link | the url when text equals url, otherwise `"text - url"`; `""` when empty | `{"url":"...","text":"...","changed_at":...}` or `null`. Always parse `value.url`. |
| board_relation | `null` | `null`. Read `... on BoardRelationValue { linked_item_ids }` (string ids). |

Item `created_at` looks like `"2026-11-16T12:52:32Z"`. `boards { columns(ids: [...]) { id type settings } }` returns `settings` as a JSON object; status labels are in `settings.labels[]` with `label` and `is_deactivated`.

**Writes:**

- `change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v)` with `$v` a JSON string such as `{"<statusLinkCol>": {"url": "...", "text": "Status link"}, "color_mm6eay19": {"label": "Status link"}}`.
- Each write costs 30,000 complexity. The budget seen was 10,000,000 a minute for a user token, so about 333 writes a minute. The response header `ratelimit` reports what's left (`"complexityMinute";r=<remaining>`).
- Aliased batches return HTTP 200 even when some aliases fail. A failed alias has `data.wN = null` plus an error with `path: ["wN"]` and `extensions.code` (for example `InvalidItemIdException`). The other aliases still succeed.
- A missing status label fails the whole write for that item, so the link isn't saved either: `extensions.code = "ColumnValueException"`, `extensions.error_data.column_validation_error_code = "missingLabel"`.
- Error `message` and `error_data` can echo column values, including links with codes. Log only `extensions.code`.
- Writing `null` to a link column clears it; it then reads back as `text ""`, `value null`.
- Pagination: `items_page(limit) { cursor items {...} }`, then `next_items_page(cursor, limit)` until `cursor` is null.
- The DVP board has an automation that sets Submission Date to the creation date, and others that set Final Approval Date when Status becomes Tokenomics Apporval or Denied.

**Production FA board on 16 Nov:** 422 rows, every one with an FA Status. Send Email is empty on 134 rows and set on 288. None of the board's automations fire on a link column change; they all trigger on a status changing to a specific label.

## Appendix B: decisions made while building (16 Nov 2026)

Where the brief is silent, these apply.

1. **Extra optional Script Properties:**
   - `FA_BOARD_ID` and `DVP_BOARD_ID` default to production. Point them at the sandbox for testing.
   - `DVP_LINK_COLUMN_ID` is phase 2. While it's unset, the DVP board isn't read and `dvp` is `[]`.
2. **Reading a Status link cell:** take `value.url`, then the part after `#`, then drop anything after a `/`. It must match `/^[A-Za-z0-9_-]{22}$/`. A cell that's non-empty but unreadable is never overwritten, since only empty cells get codes; it's counted in the log.
3. **The same code on two or more rows:** none of those rows is served (`found: false`) until the team clears the extra copies. Counted in the log.
4. **Link format:** `SITE_URL` is normalised to end in `/` unless it ends in `.html`. The link is `{url: SITE_URL + "#" + code, text: "Status link"}`.
5. **Automatic email:** the Send Email label is set in the same write as the new link, but only when all of these hold:
   - `SEND_LINK_EMAIL` is `"true"`.
   - `EMAIL_NEW_ROWS_FROM` parses as a date.
   - Send Email has an active "Status link" label (read the column settings once per run).
   - The row's `created_at` is on or after `EMAIL_NEW_ROWS_FROM`.
   - The link is being written in this run.
   - The row's Send Email isn't already "Status link", since an unchanged label wouldn't fire the automation.

   **Brake:** if more than 20 rows qualify in one run, write their links without the label and log an error. This prevents a mass email from a mis-set date. If a combined write fails with `missingLabel`, retry that row's link on its own.
6. **Write limits:** at most 200 link writes per run, 20 aliased mutations per request. On HTTP 429 or a rate or complexity error, stop writing for this run; the next run carries on. Retry a request at most twice on 429 or 5xx, honouring `Retry-After` up to 10 s. A row whose write failed is left out of the cache for this run.
7. **Contract details beyond the brief:**
   - `updated` is the latest `changed_at` (as a date) among FA Status, Testing Process, Lock Verified and FA Link, or `null`.
   - `lock` is always present, with `null` fields when there's no data. `amountMillions` is only set when it's above 0.
   - `website`, `announcement` and `requestUrl` are https-only, otherwise `null`. `announcement` is only sent when the state is `approved`.
   - Text caps: name and institution 200 characters, partyId 2,000.
   - A DVP item is `{ id, name, state, submitted, finalApproval, requestUrl, requestRef, updated }`. `finalApproval` is only set when the state is `approved`. `requestRef` is the digits from `/message/<n>` or from a leading `#<n>` in the link text. Items are sorted newest submission first.
   - Empty or unknown DVP label: `in_review`; unknown labels are logged. Unknown testing label: `in_progress`, logged.
   - Errors return `{ "error": "unavailable" }` and nothing else.
8. **Cache layout:**
   - The key is `"fa1:" + code.charCodeAt(0)` (64 shards; char codes avoid any key case-sensitivity question).
   - The value is a JSON map of code → `app` object.
   - All 64 shards go in one `putAll` with a 21600 s expiry.
   - A missing shard is a cache miss. A shard that's present but lacks the code means `found: false`.
9. **doGet on a cache miss:**
   - `tryLock(20000)`, then re-read the shard, because another request may have filled it.
   - If it's still missing, rebuild read-only: the same view builder as `refresh()`, with no codes issued and no writes.
   - Without the lock, re-read once, then return `{error: "unavailable"}`.
10. **Logging:** one JSON line per run with counts, unknown board labels and error codes. Never codes, names, URLs or Monday error messages.
11. **Manifest:**
    - `runtimeVersion` V8, `timeZone` Etc/UTC, `exceptionLogging` STACKDRIVER.
    - `oauthScopes`: `script.external_request` and `script.scriptapp` only.
    - `webapp`: `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`.
12. **Testability:**
    - `Code.gs` has no top-level side effects (constants and functions only), so the Node tests can evaluate it in a `vm` context with mocked globals.
    - Syntax stays at ES2017 level: no optional chaining or `??`, no modules.
    - Private helpers end in `_`, the Apps Script convention for functions hidden from the Run menu.
13. **Frontend fetch:** plain GET with `credentials: "omit"` and `referrerPolicy: "no-referrer"`. No custom headers and no `cache` option, so there's no CORS preflight. Time out after 20 s.
14. **Sandbox safety:** the sandbox runner refuses any board id that isn't one of the two sandbox ids, and checks every mutation's `board_id` before sending it.
