# FA Status Portal

A public page where Featured App applicants check the status of their own FA applications and DVP requests, and nobody else's.

An applicant types the email address they applied with. If that address is on an application, they get a private link by email. The link shows every FA application that lists the address, each with its DVP requests.

**Nothing changes on Monday.** The script only reads the two boards ([Featured App Submissions](https://canton-foundation.monday.com/boards/18420896395) and [Asset Moving Status Requests](https://canton-foundation.monday.com/boards/18436778970)). It adds no columns, labels or automations, and never writes to either board. The committee keeps working in Monday exactly as today.

## How it works

| Part | Where | What it does |
|---|---|---|
| The page | `docs/` on GitHub Pages | One static page for everyone. It shows the email form, or, when opened with a private link (`…/#<token>`), asks Apps Script for that link's applications. It holds no data and no secrets. |
| The backend | `apps-script/Code.gs`, a Google Apps Script web app | Holds the Monday token. Every 10 minutes it reads both boards and caches each address's applications. It answers the page and emails the links. |
| The data | Monday, read-only | FA rows are matched to people by the **Email** and **Emails for Responsible Persons** columns. DVP requests are matched to FA apps by name. |

**What applicants see:**
- Per application: app name, institution, type, submission date, status, lock date and amount, testing stage, Party ID, product site, and the public announcement once approved.
- Per DVP request: status, dates and the accountability-list link.

**What they never see:** other people's applications, contact details, Entry ID, FAAC notes, tester data, Slack fields, Tier, sponsors, tags or form answers. Those columns aren't even requested from Monday.

**Private links:** each link is tied to one email address. It can't be guessed, and it never expires, so applicants can bookmark it. The form gives the same answer whether or not an address applied, so it can't be used to find out who applied. Each address gets at most one email per 15 minutes and three per 6 hours.

**DVP requests:** the DVP board has no email and no link to the FA board, so requests are matched by name. A request is attached to an FA app whose name equals the request's name up to the first qualifier: "Harbor Swap (RFQ request)" goes to "Harbor Swap", and "Lumen Wallet / Lumen Pay (Lumen Labs)" goes to both "Lumen Wallet" and "Lumen Pay". A request that matches no app name isn't shown to anyone; renaming it on the DVP board fixes that.

## Setup (about 15 minutes)

### 1. Apps Script
Do this in the Google account that should send the link emails, for example ops@canton.foundation.

1. Go to [script.google.com](https://script.google.com) → **New project**. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
2. **Project Settings** (gear icon) → tick *Show "appsscript.json" manifest file in editor*. Back in the editor, replace `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json).
3. **Project Settings → Script Properties**, add two properties:

   | Property | Value |
   |---|---|
   | `MONDAY_API_TOKEN` | a Monday API token from an account that can see both boards |
   | `SITE_URL` | the page address, e.g. `https://pedrodneves.github.io/fa-status/` |

4. Pick **setup** in the function menu and press **Run**. Approve the permissions (connect to Monday, send email, run on a schedule). If Google shows an "unverified app" screen, click *Advanced* and continue.
   - `setup` creates the link secret (`LINK_SECRET`), checks both boards and starts the 10-minute refresh.
   - The log should end with a line containing `"mode":"setup"`.
5. **Deploy → New deployment →** gear icon → **Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Copy the URL ending in `/exec`.
   - If "Anyone" isn't offered, a Google Workspace admin setting blocks sharing outside the domain.

### 2. GitHub Pages
1. In [`docs/config.js`](docs/config.js), set `apiUrl` to the `/exec` URL and push.
2. Repo **Settings → Pages →** *Deploy from a branch* → `main`, folder `/docs`.

### 3. Try it
Open the page and enter an email address that is on an application. The email arrives within a minute, and its link shows that address's applications.

### Optional: own domain
In Cloudflare, add a CNAME from the subdomain (e.g. `status`) to `pedrodneves.github.io`. Then set it as the custom domain in **Settings → Pages**, tick **Enforce HTTPS** once the certificate is ready, and update `SITE_URL`.

## Day to day

| Situation | What to do |
|---|---|
| An applicant gets no email | Check that their address is in **Email** or **Emails for Responsible Persons** on their row. They can request again after 15 minutes. |
| A DVP request doesn't show | Its name on the DVP board must match the FA app's name, as described under "DVP requests" above. |
| A link was shared too widely | Links are per address and don't expire. To reset **all** links, delete `LINK_SECRET` in Script Properties and run `setup` again. Everyone then requests a new link. |
| A new FA Status label in Monday | Add it to `FA_STATE_BY_LABEL` in `Code.gs`. Until then it shows as "In committee review", and the log lists it under `unknownLabels`. |
| Wording | Page: the `TEXT` object in `docs/status.js`. Email: `LINK_EMAIL` in `Code.gs`. |
| Changed `Code.gs` | Save it. Then Deploy → Manage deployments → Edit → Version: **New version**. The URL stays the same. |

**Logs:** Apps Script → Executions. Each refresh logs one line of counts (`faRows`, `addresses`, `appsWithoutEmail`, `dvpUnmatched`, `unknownLabels`…). Addresses, tokens and names are never logged.

**Limits:**
- Monday: 2 read queries per refresh, about 300 a day.
- Email: Google's daily email quota (1,500 a day on Workspace, 100 on a personal Gmail). The script always leaves the last 10 unused.

## Developing

```bash
npm install                                  # once: Playwright for the page tests (uses your Chrome)
npm test                                     # backend: Code.gs in Node, mocked Google services, fake Monday
npm run test:page                            # page: Playwright with a mocked API, desktop + mobile
MONDAY_API_TOKEN=... npm run live-check      # real boards, read-only; emails are mocked, none is sent
```

[`DESIGN.md`](DESIGN.md) has the design: access model, Monday facts, the response contract and the decisions behind them.
