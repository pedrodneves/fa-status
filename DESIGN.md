# FA Status Portal: design

## What we're building

A public page where Featured App applicants see where their own FA applications and DVP requests stand, without seeing anyone else's. It pulls from two Monday boards:
- **Featured App Submissions** (FA), board `18420896395`
- **Asset Moving Status Requests** (DVP), board `18436778970`

**Hard constraint: nothing changes on Monday.** No new columns, labels or automations, and no writes of any kind. The backend only reads.

> History: the first version (v1, 16 Nov 2026) gave every FA row a "Status link" column, filled in by the script, and emailed links through a Monday automation. It was dropped the same day because it required board changes. This document describes the read-only design that replaced it.

## Architecture

| Part | Where | Role |
|---|---|---|
| Page | `docs/` on GitHub Pages | Static, the same for everyone; no data, no secrets. Shows the email form, or a private link's applications. |
| Backend | `apps-script/Code.gs`, Apps Script web app (Execute as: me, Who has access: Anyone) | Holds the Monday token and the link secret. Reads Monday every 10 minutes, caches, answers the page, emails links. |
| Data | Monday | Read-only. |

```
applicant ── types email ──▶ page ── POST {email} ──▶ doPost ── MailApp ──▶ applicant's inbox
applicant ── opens link ───▶ page ── GET ?link=<token> ──▶ doGet ── cache ──▶ {found, apps}
trigger (10 min) ─────────▶ refresh ── read FA + DVP boards ──▶ cache (64 shards)
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

**Read but never sent anywhere:** `email_mm4ke170` and `text_mm4kvrar`, which decide who may see a row. **Never requested:** every other column (Entry ID, FAAC notes, tester, Slack fields, Tier, sponsors, tags, form answers…).

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
| 3-CIP-0116-paused | `on_hold` | On hold |
| 4-No | `not_approved` | Not approved |
| 5-Revoked | `revoked` | Featured status revoked |
| 6-Withdrawn | `withdrawn` | Withdrawn |
| 7-Closed-new-process | `closed_process` | Closed: process changed (+ link to reapply) |

Any other label is treated as `in_review` and logged under `unknownLabels`.

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
      "lock": { "verified": "2026-10-18", "amountMillions": 1.5 },
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
      ]
    }
  ]
}
```

- Apps and DVP requests are newest first.
- An unknown token gets `{"found": false}`. Any failure gets `{"error": "unavailable"}`, with no details.
- Texts are capped and links are https-only (otherwise `null`).
- `announcement` is sent only when the app is approved, and `finalApproval` only when the request is approved.

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
- `doGet(e)`, `doPost(e)`, `refresh()` (10-minute trigger), `setup()` (run once by hand).
- `toApplicantView(row, dvpRows)` is the allow-list, built field by field.

**Cache (CacheService):**
- 64 shards keyed by the token's first character (`fa2:<charCode>`). Each holds `{token: {apps}}`.
- All 64 are written in one `putAll` on every run, `{}` when empty, so an address removed from Monday loses access on the next run.
- Expiry is 6 h.
- On a missing shard, the request rebuilds the cache from Monday under the script lock.
- Largest shard on real data: about 8 KB of the 100 KB limit.

**Monday client:**
- Queries only: `items_page`/`next_items_page` (500 per page), plus `columns` in setup.
- Retries 429/5xx twice, honouring `Retry-After` up to 10 s.
- A read is all or nothing: a failed run keeps the previous cache.

**Logging:** one JSON line per run with counts and unknown labels. Addresses, tokens, names and Monday error messages are never logged.

**Permissions (`appsscript.json`):**
- `script.external_request` (Monday)
- `script.send_mail` (link emails)
- `script.scriptapp` (the trigger)

## Page (`docs/`)

**Routes:**
- (none): the email form.
- `#<token>`: the list of applications, or the only one directly.
- `#<token>/app-<id>`: one application.
- `#<token>[/app-<id>]/dvp-<id>`: one DVP request.

**Screens** (`main[data-screen]`): `start`, `sent`, `loading`, `list`, `app`, `dvp`, `invalid` (with the form), `error` (with retry).

**Layout (redesign of 17 Nov 2026):** every screen opens with a purple band (header, title, status), cards sit on its lower edge, and a band-coloured footer closes the page. Everything is built from the response contract; nothing new comes from the backend.
- `start`, `sent`, `invalid`: the form (or "check your email") next to a sample status card, then three promises (private, refreshed every 10 minutes, applications and DVP), "How review works" (the six steps), "What each status means" (every FA state) and an FAQ (native `<details>`).
- `list`: count chips in the band; each card has the pill, a progress bar ("Step 5 of 6 · …"), the last update and the latest committee email.
- `app`: the progress steps run across the band. Below them:
  - Number tiles: submitted ("34 days ago"), Canton Coin locked, testing, last updated.
  - Main column: the status box with "What happens next" (`next` in the wording, per state), the latest committee email, and the activity history (dated events, newest first).
  - Side column: On file (with "Copy Party ID"), DVP, and a help box.
- `dvp`: the same layout, with tiles for submitted, final approval and last updated, a public-record card, and a card back to the application.
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

- `npm test`: 28 Node tests of `Code.gs`, with mocked Google services and a fake Monday. They cover tokens, address extraction, label maps, DVP matching, the cache, privacy (no address, sentinel or token anywhere), doGet/doPost, rate limits, setup, and that no mutation is ever sent.
- `npm run test:page`: Playwright against the page with a mocked API, desktop and mobile (82 tests).
- `npm run live-check`: the real boards, read-only, with mocked email. Every address resolves to its rows, nothing leaks, and no write is sent. Last run on 16 Nov 2026: 11/11 passed.
