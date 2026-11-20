# FA Status Portal: design

## What we're building

A public page where Featured App applicants see where their own FA applications and DVP requests stand, without seeing anyone else's. The same page also lists, for everyone, the apps that hold Featured App status, with their Party IDs (added 20 Nov 2026, from screen 5 of the redesign canvas), and the apps whose status was revoked. It pulls from two Monday boards:
- **Featured App Submissions** (FA), board `18420896395`
- **Asset Moving Status Requests** (DVP), board `18436778970`

**Hard constraint: nothing changes on Monday.** No new columns, labels or automations, and no writes of any kind. The backend only reads.

> History: the first version (v1, 16 Nov 2026) gave every FA row a "Status link" column, filled in by the script, and emailed links through a Monday automation. It was dropped the same day because it required board changes. This document describes the read-only design that replaced it.

## Architecture

| Part | Where | Role |
|---|---|---|
| Page | `docs/` on GitHub Pages | Static, the same for everyone; no data, no secrets. Shows the email form, a private link's applications, or the public list. |
| Backend | `apps-script/Code.gs`, Apps Script web app (Execute as: me, Who has access: Anyone) | Holds the Monday token and the link secret. Reads Monday every 10 minutes, caches, answers the page, emails links. |
| Data | Monday | Read-only. |

```
applicant ── types email ──▶ page ── POST {email} ──▶ doPost ── MailApp ──▶ applicant's inbox
applicant ── opens link ───▶ page ── GET ?link=<token> ──▶ doGet ── cache ──▶ {found, apps}
anyone ──── opens #featured ▶ page ── GET ?view=featured ──▶ doGet ── cache ──▶ {updated, apps}
trigger (10 min) ─────────▶ refresh ── read FA + DVP boards ──▶ cache (64 shards + public list)
```

## Access model

- **Who may see a row:** every address in the row's **Email** column (`email_mm4ke170`) or in **Emails for Responsible Persons** (`text_mm4kvrar`, free text that often holds several addresses).
  - Addresses are extracted with `/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g`, lower-cased and de-duplicated, at most 10 per row.
- **Token:** `HMAC-SHA256(LINK_SECRET, address)`, base64url, first 22 characters (132 bits). It is deterministic, so nothing is stored per applicant and the same address always gets the same link.
  - `setup()` creates `LINK_SECRET` from two random UUIDs and never replaces an existing one.
  - Deleting it and running `setup()` again changes every link: this is the reset for leaked links.
- **Link:** `SITE_URL + "#" + token`. The part after `#` never reaches GitHub. The page sends the token to Apps Script only.
- **Getting a link:** the page POSTs `{"email": "..."}` as `text/plain` (a CORS simple request).
  - The answer is always `{ok: true}` for a well-formed address, so the form can't be used to test whether an address applied.
  - When no email is sent, the script sleeps 0.6–1.4 s, so response times don't give it away either.
- **Limits per address:** at most one email per 15 minutes and 3 per 6 hours. These are kept in the cache under the token, never the address. The last 10 of the account's daily email quota are always left unused.
- **Coverage (16 Nov 2026):**
  - 407 of 422 FA rows have at least one address. The other 15 can't be reached.
  - 530 distinct addresses can get a link, with at most 5 rows per address.

## Public list (added 20 Nov 2026)

- **Who is listed:** every FA row whose state has Featured App status: `approved` ("2-Approved") and `provisional` ("2b-Provisional", once the committee adds that label); and every row whose status was revoked (`revoked`, "5-Revoked"), which the committee decided on 20 Nov 2026. Nothing else is listed: not apps in review, declined, withdrawn or closed.
- **What is public, per app (the allow-list, `toPublicView_`):**
  - `name`: the item name.
  - `type`: the FA Type label, or null when not set yet.
  - `status`: `featured`, `provisional` or `revoked`.
  - `since` / `sinceExact`: the date the FA Status last changed (`value.changed_at`), with `sinceExact: true`: the date the app was featured or, for a revoked app, the date it was revoked. Rows imported when the board was created (7 Jul 2026) have no change date, so `since` is the item's `created_at` date and `sinceExact` is false: the app was featured (or revoked) on or before that day. The page shows "By 7 Jul 2026".
  - `partyIds`: the Canton party IDs in the free-text Party ID cell (`long_text_mm4kq322`), at most 5. Only well-formed IDs: a hint (letters, digits, `_`, `-`, single `:`; never `::`; up to 185 characters), `::1220` and 64 hex digits. Two IDs typed without a separator are both found. Text in any other form (a space before `::`, a fingerprint of the wrong length) gives none, and the run counts it as `partyIdUnreadable`.
  - `record`: the FA Link (`link_mm6hfp5g`, the announcement), https only.
- **Never public:** the institution, addresses, review progress, dates of the review, testing, lock, emails from the committee, DVP requests, and everything else.
- **Order:** apps with Featured App status first, most recently featured first; then revoked apps, most recently revoked first; undated last, then by name.
- **Coverage (20 Nov 2026):** 148 featured apps and 24 revoked ones. Of the 148 featured, 144 have one Party ID, 2 have two, 2 have none (one empty cell, one written "Mod-Vault ::1220…" with a space). 45 have an exact date, 103 an import date. 72 have no FA Type yet. 138 have an announcement link.

## Monday facts (read 16 Nov 2026, `API-Version: 2026-10`)

**FA columns shown to applicants (the allow-list):**

| Field | Column | Column title |
|---|---|---|
| name | item name | |
| institution | `text_mm4k2vch` | Name of Applying Institution |
| state | `color_mm4kmej3` | FA Status |
| type | `color_mm4kpp3q` | Type (Non-Issuer / Asset Issuer) |
| submitted | `date_mm4kw11a` | Time stamp |
| lock.verified | `date_mm4kpckv` | Lock Verified |
| lock.amountMillions | `numeric_mm4k6919` | Locked amount (Million) |
| testing | `color_mm6be9ge` | Testing Process |
| partyId | `long_text_mm4kq322` | Party ID for the Featured Application |
| website | `link_mm4kmq24` | Product Website |
| announcement | `link_mm6hfp5g` | FA Link (sent only once approved) |
| update | `color_mm6eay19` | Send Email (the latest committee email) |
| faType | `color_mm8z4ket` | FA Type (Basic Featured App / Featured Asset-Moving App / Featured Asset) |
| dvpStatus | `color_mm8a49an` | DVP Status on the FA board |

**Read but never sent anywhere:** `email_mm4ke170` and `text_mm4kvrar`, which decide who may see a row. **Never requested:** every other column (Entry ID, FAAC notes, tester, Slack fields, Tier, sponsors, tags, form answers…). Besides columns, each item's `created_at` is read, for the public list's dates.

**DVP board** (24 rows):
- Columns read: Status `color_mm8dhgvr`, Submission Date `date_mm8dsx4y`, Final Approval Date `date_mm8dm7a0`, Request Link `link_mm8rp25j` (a post on `lists.sync.global/g/accountability`, text like `#116 – <app name>`).
- It has **no email column and no link to the FA board**, so requests are matched to FA apps by name (below).

**Value shapes:**
- Status: label in `text`, `changed_at` in `value`.
- Date: `value.date`.
- Numbers: `value` is a JSON string such as `"1.5"`.
- Link: `value.url` and `value.text`.
- Email: `value.email`; `text` is the bare address.

## DVP matching

- A DVP item name is cut at its first qualifier (` (`, ` [`, ` - `, ` – `, ` — ` or `: `), lower-cased and split on `/`:
  - "Harbor Swap (RFQ request)" → `harbor swap`
  - "Lumen Wallet / Lumen Pay (Lumen Labs)" → `lumen wallet`, `lumen pay`
- An FA app answers to its full name and to its name cut the same way. "Copperleaf - Copperleaf Labs" answers to that and to `copperleaf`.
- A request is attached to every FA app with an equal key. There is no partial or fuzzy matching ("Quillpoint" ≠ "Quillpoint Vaults"), because a wrong match would show one company's request to another.
- On 16 Nov 2026, 16 of the 24 requests match, all to the right company:
  - The 8 unmatched requests aren't shown to anyone.
  - Renaming one on the DVP board to its FA app's name makes it appear.
  - The log counts them as `dvpUnmatched`.

## State mapping

The backend sends state keys; all page wording lives in `docs/status.js`.

| FA Status label | state | Pill |
|---|---|---|
| (empty) | `received` | Received |
| 0-Locked+Needs Review, 1-Needs Review | `in_review` | In committee review |
| 1b-FAAC Approved-waiting on tokenomics | `with_tokenomics` | With Tokenomics Committee |
| 2-Approved | `approved` | Approved (+ link to the announcement) |
| 2b-Provisional (not on the board yet) | `provisional` | Provisionally approved (+ link to the announcement) |
| 3-CIP-0116-paused | `on_hold` | On hold |
| 4-No | `not_approved` | Not approved (+ "Apply again") |
| 5-Revoked | `revoked` | Featured status revoked |
| 6-Withdrawn | `withdrawn` | Withdrawn |
| 7-Closed-new-process | `closed_process` | Closed: process changed (+ link to reapply) |

Any other label is treated as `in_review` and logged under `unknownLabels`.

- **Provisional (20 Nov 2026):** the committee agreed to a `2b-Provisional` label (screen 7 of the canvas), but the board doesn't have it yet. The mapping is in place, so the page and the public list show it as soon as the label is added, with no deploy. Its conditions would need a new column, so the page says they are in the committee's email.
- **Not approved (20 Nov 2026):** the board records no reason for a decision: the "Decision reason" column of screen 6 doesn't exist, and "FAAC Thoughs" / "FAAC Rec" are internal notes, never shown. So the page says the committee's email explains why, and shows when the decision was made (the history's change to Not approved, else the Decline email's date). If a reason column is added later, it can be read and shown like any other column.
- **Applying again (the committee's rule, 20 Nov 2026):** after three months, or sooner with a substantially changed proposal once that version is live on MainNet. The Not approved status box and the Decline email's text both say so.

- **Testing:** empty → `not_started`; Sent Email → `action_needed`; Pending Review or Stuck → `in_progress`; Done → `complete`.
- **Send Email** (`color_mm6eay19`): each label triggers one email from a Monday automation. The page shows the latest one as "Latest email from the committee", with the date the label was set (`update: {kind, date}`). Mapping: Office Hour Request → `office_hours`, Endorsements → `endorsements`, FA Type Email → `fa_type_info`, Locking Check → `locking_check`, Updated Process → `resubmit`, Decline → `declined`. Working on it, Done, Stuck and empty send nothing and show nothing. The label stays after the applicant replies, so the wording describes what the email asked rather than claiming it's still outstanding.
- **DVP Status (FA board):** Needs Review → `in_review`, FAAC Approved → `faac_approved`, Declined → `declined`; empty or unknown shows nothing. Shown at the top of the app's DVP section, above any DVP requests matched from the DVP board.
- **DVP:** New Submission → `in_review`; FAAC Approval → `with_tokenomics`; Tokenomics Apporval (the board's spelling) → `approved`; Denied → `not_approved`; Closed → `closed`.

## Response contract

`GET <exec>?link=<token>`:

```json
{
  "found": true,
  "apps": [
    {
      "id": "11420954321",
      "name": "Harbor Swap",
      "institution": "Fernway Labs",
      "type": "Non-Issuer",
      "submitted": "2026-10-14",
      "state": "with_tokenomics",
      "lock": { "verified": "2026-10-18", "amountMillions": 1.5, "confirmed": false },
      "testing": "complete",
      "partyId": "harborswap-1::1220…",
      "website": "https://harborswap.example",
      "announcement": null,
      "update": { "kind": "office_hours", "date": "2026-11-16" },
      "updated": "2026-11-03",
      "dvp": [
        { "id": "13454645978", "name": "Harbor Swap (RFQ)", "state": "in_review", "submitted": "2026-10-20",
          "finalApproval": null, "requestUrl": "https://lists.sync.global/g/accountability/message/147",
          "requestRef": "147", "updated": "2026-10-31" }
      ],
      "history": [
        { "at": "2026-11-17T12:35:07Z", "kind": "status", "to": "in_review_locked", "from": "in_review" },
        { "at": "2026-11-17T11:26:43Z", "kind": "email", "to": "fa_type_info" },
        { "at": "2026-10-25T09:00:00Z", "kind": "dvp_state", "to": "with_tokenomics", "request": "13454645978" }
      ]
    }
  ]
}
```

- Apps and DVP requests are newest first.
- An unknown token gets `{"found": false}`. Any failure gets `{"error": "unavailable"}`, with no details.
- Texts are capped and links are https-only (otherwise `null`).
- `announcement` is sent only when the app is on the public list (approved, provisional or revoked), and `finalApproval` only when the request is approved.
- `lock.confirmed` is true when the FA Status is "0-Locked+Needs Review": the page then marks the lock step done, even without a Lock Verified date.
- `history` (added 17 Nov 2026) lists the app's changes from Monday's activity log, newest first, at most 80:
  - Kinds: `status` (`to`/`from`, the state keys, with `in_review_locked` for "0-Locked+Needs Review"), `testing` (`to`), `lock_verified` (`date`), `lock_amount` (`amount`), `email` (`to`, the email kind), `fa_type` (`text`, the label), `dvp_status` (`to`) and `dvp_state` (`to`, `request`: a DVP request of this app).
  - Never sent: who made a change, item names, or any other column.
  - Left out: cleared cells, labels that send nothing, and changes that don't change the key.
  - Optional: when the activity log can't be read, `history` is absent and the page falls back to the dates it has.

`GET <exec>?view=featured` (the public list, anyone):

```json
{
  "updated": "2026-11-20T14:46:57Z",
  "apps": [
    { "name": "Harbor Swap", "type": "Featured Asset-Moving App", "status": "featured", "since": "2026-11-13",
      "sinceExact": true, "partyIds": ["harborswap-1::1220…"], "record": "https://lists.sync.global/g/tokenomics/message/…" }
  ]
}
```

- `updated` is when the refresh that built the list ran. Apps with Featured App status come first, most recent first, then revoked apps, most recently revoked first; ties by name.
- `&format=csv` gives the same list as `featured-apps.csv`: `name,type,status,since,since_exact,party_ids,record`, several Party IDs separated by a space. A cell starting with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet never runs it as a formula.
- Any failure gets `{"error": "unavailable"}` (JSON, also for the CSV).

`POST <exec>` with body `{"email": "..."}` (`text/plain`) gets one of:
- `{"ok": true}`
- `{"ok": false, "error": "invalid_email"}`
- `{"ok": false, "error": "unavailable"}`

## Backend (`apps-script/Code.gs`)

**Script Properties:**
- `MONDAY_API_TOKEN` and `SITE_URL`: required.
- `LINK_SECRET`: created by `setup()`.
- `FA_BOARD_ID` / `DVP_BOARD_ID`: optional overrides.

**Entry points:**
- `doGet(e)` (a link, or `view=featured`), `doPost(e)`, `refresh()` (10-minute trigger), `setup()` (run once by hand).
- `toApplicantView(row, dvpRows)` is the allow-list, built field by field. `toPublicView_(row)` is the public list's (`PUBLIC_STATUS_BY_STATE`: approved → featured, provisional → provisional, revoked → revoked).
- A cache miss, for a link or the public list, rebuilds from Monday under the script lock (`fromCacheOrRebuild_`).

**History (per link, section 8b):**
- `doGet` adds `history` to a found answer (`withHistory_`).
- One `activity_logs(item_ids, column_ids, limit: 100, page)` query per board, at most 5 pages:
  - `item_ids`: the link's own FA items and their DVP requests. Never an empty list, which would mean every item.
  - `column_ids`: FA Status, Testing Process, Lock Verified, Locked amount, Send Email, FA Type and DVP Status on the FA board; Status on the DVP board.
- Entries for any other item are dropped again on arrival, in case the API ignores `item_ids`.
- Cached under `fa2:hist:<token>` for 10 minutes, so a change shows at most 10 minutes later, independently of the refresh trigger.
- A failure is logged (error kind only) and not cached.

**Cache (CacheService):**
- 64 shards keyed by the token's first character (`fa2:<charCode>`). Each holds `{token: {apps}}`.
- All 64 are written in one `putAll` on every run, `{}` when empty, so an address removed from Monday loses access on the next run.
- The public list goes in the same `putAll`: its rows in chunks of at most 90 KB under `fa2:pub:0`, `fa2:pub:1`…, and an index `{updated, chunks}` under `fa2:pub`. A missing chunk counts as a miss. On real data (20 Nov 2026) it is one chunk of about 40 KB.
- Expiry is 6 h.
- On a missing shard, the request rebuilds the cache from Monday under the script lock.
- Largest shard on real data: about 8 KB of the 100 KB limit.

**Monday client:**
- Queries only: `items_page`/`next_items_page` (500 per page), `activity_logs` for history, plus `columns` in setup.
- Retries 429/5xx twice, honouring `Retry-After` up to 10 s.
- A read is all or nothing: a failed run keeps the previous cache.

**Logging:** one JSON line per run with counts and unknown labels (including `featured`, `revoked` and `partyIdUnreadable`). Addresses, tokens, names and Monday error messages are never logged.

**Permissions (`appsscript.json`):**
- `script.external_request` (Monday)
- `script.send_mail` (link emails)
- `script.scriptapp` (the trigger)

## Page (`docs/`)

**Routes:**
- (none): the email form.
- `#featured`: the public list of featured apps.
- `#<token>`: the list of applications, or the only one directly.
- `#<token>/app-<id>`: one application.
- `#<token>[/app-<id>]/dvp-<id>`: one DVP request.

**Screens** (`main[data-screen]`): `start`, `sent`, `loading`, `featured`, `list`, `app`, `dvp`, `invalid` (with the form), `error` (with retry).

**Layout (redesign of 17 Nov 2026):** every screen opens with a purple band (header, title, status), cards sit on its lower edge, and a band-coloured footer closes the page. Everything is built from the response contract; nothing new comes from the backend.
- `start`, `sent`, `invalid`: the form (or "check your email") next to a sample status card, then three promises (private, refreshed every 10 minutes, applications and DVP), "How review works" (the six steps), "What each status means" (every FA state) and an FAQ (native `<details>`).
- `list`: count chips in the band; each card has the pill, a progress bar ("Step 5 of 6 · …"), the last update and the latest committee email.
- `app`: the progress steps run across the band. Below them:
  - Number tiles: submitted ("34 days ago"), Canton Coin locked, testing, last updated.
  - Main column: the status box with "What happens next" (`next` in the wording, per state), the latest committee email, and the History card. It lists every change from `history` with its date and local time, plus the submission dates; the first 6 show, the rest sit behind "Show N earlier changes". Without `history` it falls back to the dated events it can derive.
  - Side column: On file (with "Copy Party ID"), DVP, and a help box.
- `dvp`: the same layout, with tiles for submitted, final approval and last updated, a History card (the request's own status changes), a public-record card, and a card back to the application.
- `featured` (20 Nov 2026, canvas screen 5 plus Party IDs): the band holds the counts (featured apps, asset-moving, provisional when any). The card on its edge has a search (app name or Party ID), Download CSV and JSON feed links, filter chips built from the data (All, each FA Type, Type not set, Provisional), and one row per app: name, type, status, since, announcement, then its Party IDs, each with a copy button. Provisional rows add a note that the status can be revoked. The band, chips and "Showing N of M" count only apps with Featured App status. Revoked apps follow in a card of their own, "Featured status revoked" with their count, the same columns with "Revoked on" for the date, and a red "Revoked" pill; the search covers both cards, and the card is left out when no app is revoked. Below: "Use this list in your tools" (the feed address and its fields) and "About this list". Linked from the start page, the footer and the "On the public list" card.
- Not approved (canvas screen 6, without a reason column): the steps run received → lock (if verified) → "Featured App Committee review · Decided <date>" → Not approved. The status box says the committee's email explains why; "What happens next" says they can apply again after three months, or sooner with a substantially changed proposal once it is live on MainNet, with an "Apply again" button and the contact line. The help box asks "Questions about this decision?".
- Provisional (canvas screen 7, without a conditions column): the pill is "Provisionally approved" (amber); the last step is "Featured App status granted" flagged "Provisional", "Conditions apply"; the status box says the conditions are in the committee's email and that the status can be revoked if one isn't met.
- Featured apps (approved or provisional) get an "On the public list" side card saying what everyone can see about them; revoked apps get the same card, saying they're listed as revoked. The start page's sixth step and a new FAQ ("Is anything about my application public?") say the same.
- The footer links (Featured App request, canton.foundation, the accountability list, the support address) are filled by `status.js` from its wording and `config.js`.

**Look:**
- Canton Foundation website colours (option A of the theme mockup): Canton black `#030206`, white `#FFFFFC`, deep purple `#180231`, yellow `#F3FF97` buttons, purple `#634BA9` and lilac `#D5A5E3` accents.
- The official logo, white-lettered version (`cf-logo-dark.svg`), since the header sits on the band in both themes. `cf-logo-light.svg` is kept for light backgrounds. The favicon is the C mark from the same file.
- IBM Plex Sans and Mono, served from `docs/fonts/` (SIL Open Font License).
- A white and a dark theme: the band is deep purple `#180231` on the white theme and Canton black `#030206` on the dark one. The page follows the system setting until the visitor presses the header button. The choice is kept in `localStorage` and applied by `theme.js` before the page paints.

**Safety:**
- DOM built with `textContent` only.
- https-only links, opened with `rel="noopener noreferrer"`.
- CSP limits network calls to `script.google.com` / `script.googleusercontent.com`; scripts, styles, fonts and images come from the site only.
- `noindex` and `no-referrer`.
- A malformed token never leaves the browser.

## Testing

- `npm test`: 38 Node tests of `Code.gs`, with mocked Google services and a fake Monday. They cover tokens, address extraction, label maps, DVP matching, the cache, privacy (no address, sentinel or token anywhere), doGet/doPost, rate limits, setup, the public list (fields, Party ID extraction, CSV, chunked cache), and that no mutation is ever sent.
- `npm run test:page`: Playwright against the page with a mocked API, desktop and mobile (108 tests).
- `npm run live-check`: the real boards, read-only, with mocked email. Every address resolves to its rows, nothing leaks, the public list has only public fields and well-formed Party IDs, and no write is sent. Last full run on 16 Nov 2026: 11/11 passed. On 20 Nov 2026 the refresh and the public list alone ran against the real boards: 148 apps, no address, no write.
