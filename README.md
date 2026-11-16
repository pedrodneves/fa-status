# FA Status Portal

A status page for Featured App applicants. Each FA application gets a private link, `https://<site>/#<code>`. Opening it shows where that application stands, and in phase 2 its DVP requests too. Nobody signs in: having the link is enough. The committee keeps working in Monday as today.

## How it works

| Part | Where | What it does |
|---|---|---|
| The page | `docs/` on GitHub Pages | The same static page for everyone. It reads the code after `#` (browsers never send that part to GitHub), asks Apps Script for that one application and shows it. It holds no data and no secrets, so the repo can be public. |
| The data | `apps-script/` as a Google Apps Script web app | Holds the Monday token. `doGet` answers one link at a time from a cache. `refresh()` runs every 10 minutes: it gives new FA rows a link, writes it to Monday, and rebuilds the cache. |
| The source | Monday | The FA board (Featured App Submissions) and, in phase 2, the DVP board (Asset Moving Status Requests). |

**What applicants can see:** app name, institution, type, submission date, status, lock date and amount, testing stage, Party ID, product site, and the public announcement once approved. In phase 2 they also see their DVP requests: status, dates and the accountability-list link.

**What they never see:** contact details, Entry ID, FAAC notes, tester data, Slack fields, Tier, sponsors, tags and form answers. The script doesn't even request those columns from Monday.

## Before go-live: checklist

Do these in order. Steps 1–3 are in Monday and Google, steps 4–6 publish the page.

### 1. Monday (production FA board)
- [ ] Add a **Link** column named "Status link". Note its column id (column menu → Column info, e.g. `link_mm95vm0`).
- [ ] Add a **"Status link"** label to the **Send Email** column.
- [ ] Add a Gmail automation: *When Send Email changes to Status link, send an email*. Copy the Endorsements automation, including the recipients (Emails for Responsible Persons, plus Email if you want both), and put the **Status link** column in the body.
- [ ] Create a Monday account that can only see the two boards (a guest works). Create an API token for it.
- Phase 2, when ready: on the Asset Moving board, add a **Connect boards** column pointing at the FA board, and link each existing request to its application.

### 2. Google Apps Script (in the shared account, e.g. ops@canton.foundation)
- [ ] Ask the Workspace admin to confirm that Apps Script web apps can be shared with **Anyone**. This is a Google Drive sharing setting in the Admin console; if sharing outside the domain is off, the "Anyone" option is missing.
- [ ] Go to script.google.com → **New project**. Paste `apps-script/Code.gs` into `Code.gs`.
- [ ] Project Settings → tick *Show "appsscript.json" manifest file in editor*. Replace the manifest with `apps-script/appsscript.json`.
- [ ] Project Settings → **Script Properties**:

| Property | Value |
|---|---|
| `MONDAY_API_TOKEN` | the token from step 1 |
| `STATUS_LINK_COLUMN_ID` | the Status link column id |
| `SITE_URL` | the page address, e.g. `https://status.canton.foundation/` |
| `SEND_LINK_EMAIL` | `false` for now |
| `EMAIL_NEW_ROWS_FROM` | leave unset for now |
| `DVP_LINK_COLUMN_ID` | phase 2: the Connect boards column id (leave unset until then) |

- [ ] Pick **setup** in the function menu, then press **Run**. Approve the two permissions: connect to an external service, and manage triggers. `setup()` checks the properties and the Monday columns, creates the 10-minute trigger, and runs the first `refresh()`.
  - The first runs write links to 200 rows each, so all ~420 rows have one within about 30 minutes. **No email goes out**: that only happens once you switch it on in step 7.
- [ ] Triggers (clock icon) → the refresh trigger → set **failure notifications** to *immediately*.
- [ ] **Deploy → New deployment → Web app**. *Execute as:* Me. *Who has access:* **Anyone**. Copy the `/exec` URL.

### 3. Check one link before publishing
- [ ] Open `<exec URL>?link=<a code from a row's Status link>` in a browser. You should see JSON with `"found":true`.

### 4. GitHub
- [ ] The code lives at [github.com/pedrodneves/fa-status](https://github.com/pedrodneves/fa-status). If it moves to the canton-foundation org later, Pages and the domain move with it.
- [ ] In `docs/config.js`, set `apiUrl` to the `/exec` URL. Check `supportEmail`.
- [ ] Settings → **Pages** → *Deploy from a branch* → `main`, folder `/docs`.

### 5. Domain
- [ ] In Cloudflare, add a CNAME from the subdomain (for example `status`) to `<repo owner>.github.io`: `pedrodneves.github.io` today, `canton-foundation.github.io` if the repo moves to the org.
- [ ] In Settings → Pages, set the custom domain, wait for the certificate, then tick **Enforce HTTPS**. Make sure `SITE_URL` (step 2) uses this address.

### 6. Try it
- [ ] Copy a Status link from a Monday row and open it. The page should show that application after a second or two.

### 7. Start emailing links
- [ ] New applications: set `EMAIL_NEW_ROWS_FROM` to today's date (e.g. `2026-12-01`) and `SEND_LINK_EMAIL` to `true`. From then on, a row created on or after that date gets its link emailed within about 10 minutes: the script sets Send Email to "Status link", and the automation sends it.
  - Safety brake: if more than 20 rows qualify in one run, the script writes their links but sets no labels, and logs `email_brake`.
- [ ] Existing applications (Q1): select the rows in Monday and set **Send Email** to **Status link** in bulk. Each row's automation sends its own email. 40 rows have no email address, so those emails can't go out.

## Running it day to day

| Situation | What to do |
|---|---|
| An applicant lost their link | Copy it from their row's **Status link** cell and send it, or set Send Email to "Status link" again. If the label already says "Status link", change it to something else first, because the automation only fires on a change. |
| A link was shared too widely | **Clear** the row's Status link cell. Within about 10 minutes the old link stops working ("This link isn't valid") and a new one appears in the cell. Send the new one. |
| The same link appears on two rows | Neither row's link works until you clear the copy that doesn't belong. The log counts this as `duplicateCodes`. |
| Someone typed something else into a Status link cell | The script never overwrites a non-empty cell. That row's link won't work until the cell is cleared; it's counted as `unreadableLinks`. |
| Wording on the page | Edit the `TEXT` object in `docs/status.js` and push. |
| A new FA Status label in Monday | Add it to `FA_STATE_BY_LABEL` in `Code.gs`. Until then it shows as "In committee review", and the log lists it under `unknownLabels`. |
| Changed `Code.gs` | Save. The trigger picks up the new code straight away. For `doGet` changes: Deploy → Manage deployments → Edit → Version: **New version** (the URL stays the same). |

**Logs:** Apps Script → Executions. Each refresh logs one JSON line of counts, such as `faRows`, `linksWritten`, `served`, `errorCodes` and `unknownLabels`. Codes, names and URLs are never logged.

**Limits:** a refresh takes a few seconds and uses about 300 Monday API calls a day; the Enterprise plan allows 25,000 a day. Pages load in about 1–2 seconds, mostly Google starting the script.

## Developing

```bash
npm install              # once: the page test runner (Playwright, uses your Chrome)
npm test                 # backend: Code.gs in Node with mocked Google services, fake Monday
npm run test:page        # page: Playwright with mocked API answers, desktop + mobile
MONDAY_API_TOKEN=... npm run sandbox   # end-to-end against the SANDBOX boards only
```

- **The sandbox:** two boards in the "CF-Website Form Entries" workspace, `[sandbox] FA Status Portal · …`. They are structure-only copies with invented rows. The sandbox run refuses any other board id and any mutation other than a column write, so production can't be touched.
- **Tests and screenshots:** page-test screenshots go to `test-results/screenshots/`.
- **Spec:** `DESIGN.md` holds the build brief, the Monday API facts verified on the sandbox (Appendix A) and the decisions made while building (Appendix B).
