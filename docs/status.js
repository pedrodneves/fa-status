/*
 * Featured App Status: status.js
 *
 * The page is one static file, the same for everyone. What makes a status
 * page private is the token after "#" in the link, which browsers never send
 * to GitHub Pages. Applicants get that link by email: they type the address
 * they applied with, and Apps Script emails it the link (only if the address
 * is on an application). This script:
 *
 *   1. reads the route from location.hash:
 *        ""                                  the start page (email form)
 *        "#<token>"                          the applications of that address
 *        "#<token>/app-<id>"                 one application
 *        "#<token>/app-<id>/dvp-<id>"        one DVP request ("/app-<id>" optional)
 *   2. asks the Apps Script web app for that token's applications with a
 *      plain GET, or sends the email form with a POST (text/plain body, no
 *      custom headers, so the browser makes no CORS preflight);
 *   3. renders one screen into <main>, marked with a data-screen attribute:
 *        start     the email form
 *        sent      "check your email"
 *        loading   waiting for Apps Script (usually 1-2 s)
 *        list      several applications: one card each
 *        app       one application (straight away when there is only one)
 *        dvp       one DVP request of an application
 *        invalid   malformed token, or Apps Script answered { found: false };
 *                  shows the email form again
 *        error     network error, timeout, unusable answer, or config.js
 *                  still has the placeholder apiUrl
 *
 * Answer shapes (see "Response contract" in DESIGN.md):
 *   GET  { found: true, apps: [{ id, name, institution, type, submitted, state,
 *                                lock, testing, partyId, website, announcement,
 *                                updated, dvp: [{ id, name, state, submitted,
 *                                finalApproval, requestUrl, requestRef, updated }] }] }
 *        { found: false }
 *        { error: "unavailable" }
 *   POST { ok: true }  (the same whether or not the address applied)
 *        { ok: false, error: "invalid_email" | "unavailable" }
 *
 * Safety rules followed throughout:
 *   - Every node is built with createElement + textContent. Nothing from the
 *     API or the URL is ever parsed as HTML.
 *   - Links to other sites are made only for https:// URLs, and they open in
 *     a new tab with rel="noopener noreferrer".
 *   - Tokens and email addresses are never logged or stored.
 *
 * No dependencies. Test hook: window.FAStatus = { parseRoute, formatDate }.
 */
(function () {
  'use strict';

  // ===========================================================================
  // 1. Wording
  // ===========================================================================
  //
  // Every sentence the page shows lives in this object, so wording can be
  // reviewed and changed without touching the logic below.
  //
  // Placeholders in braces are filled in when the page renders:
  //   {email}   the support address from config.js, as a mailto: link
  //   {date}    a date such as "14 Oct 2026"
  //   {name}    an app name
  //   {ref}     a mailing-list message number
  //   {amount}  a Canton Coin amount in millions, such as "1.5"
  //   {url}     a link's address without "https://"
  //
  // State entries hold the pill label, the pill tone (info, ok, warn, bad or
  // idle: a class in styles.css) and the status-box message. `linkText` is
  // the text of the link shown under the message, and `contact: true` adds
  // the "Questions? Contact..." line.
  const TEXT = {
    siteName: 'Featured App Status',  // browser tab title: "<name> · Featured App Status"
    separator: ' · ',                 // joins the parts of meta lines and titles

    // The theme button in the header (its accessible name and tooltip).
    theme: {
      toDark: 'Switch to dark theme',
      toLight: 'Switch to white theme'
    },

    // ---- Start page and the email form --------------------------------------
    start: {
      heading: 'Check your application status',
      body: "Enter the email address on your Featured App application. We'll email you a private link to the status of your applications and DVP requests.",
      label: 'Email address',
      placeholder: 'name@company.com',
      button: 'Email me my link',
      sending: 'Sending…',
      invalid: 'Enter one email address, like name@company.com.',
      failed: "We couldn't send your link just now. Please try again in a minute.",
      fine: 'We only email addresses that are on a Featured App application. Questions? Contact the Featured App team at {email}.'
    },
    sent: {
      heading: 'Check your email',
      body: "If {address} is on a Featured App application, we've sent it a link. It can take a few minutes, so check your spam folder too.",
      noEmail: "Nothing after 15 minutes? That address may not be on an application: try another one you applied with, or contact the Featured App team at {email}.",
      again: 'Use a different email'
    },

    // ---- Screens without application data ----------------------------------
    loading: 'Loading your applications…',
    invalid: {
      heading: "This link isn't valid",
      body: 'Only part of it may have been copied. Enter your email address to get your link again.'
    },
    error: {
      heading: "We couldn't load your status",
      body: 'Please check your connection and try again. If this keeps happening, contact the Featured App team at {email}.',
      retry: 'Try again'
    },

    // ---- Shared by the application and DVP pages ---------------------------
    submitted: 'Submitted {date}',
    lastUpdated: 'Last updated {date}',
    contact: 'Questions? Contact the Featured App team at {email}.',
    footer: 'This page is private to your email address. Anyone with the link can see these applications, so share it only within your team. Questions? Contact the Featured App team at {email}.',
    statusLabel: 'Status',  // accessible name of the status box
    // Read by screen readers before each timeline step (the dots are visual only).
    stepState: {
      done: 'Completed',
      current: 'Current step',
      todo: 'Upcoming',
      stop: 'Outcome'
    },

    // ---- List of applications (when an address has more than one) ----------
    list: {
      heading: 'Your applications',
      intro: 'Featured App applications that list your email address. Select one to see its progress and DVP requests.',
      dvpOne: '1 DVP request',
      dvpMany: '{count} DVP requests',
      back: '← All your applications'
    },

    // ---- Application page ---------------------------------------------------
    fa: {
      eyebrow: 'Featured App application',
      untitled: 'Untitled application',  // only if the app has no name
      progressLabel: 'Application progress',
      onFile: 'On file',
      partyId: 'Party ID',
      productSite: 'Product site',
      dvpHeading: 'DVP requests for this app',

      // FA states (the backend maps the FA Status column to these keys).
      // Any other value is shown as in_review.
      states: {
        received: {
          label: 'Received', tone: 'info',
          message: 'Your application has been received and is waiting for committee review.'
        },
        in_review: {
          label: 'In committee review', tone: 'info',
          message: 'The Featured App Committee is reviewing your application.'
        },
        with_tokenomics: {
          label: 'With Tokenomics Committee', tone: 'info',
          message: 'The Featured App Committee approved your application. The Tokenomics Committee is doing the final review.'
        },
        approved: {
          label: 'Approved', tone: 'ok',
          message: 'Your app has Featured App status.',
          linkText: 'View the public announcement ↗'  // to app.announcement (https only)
        },
        on_hold: {
          label: 'On hold', tone: 'warn',
          message: 'Review is paused while CIP-0116 is resolved. This page will update when review resumes.'
        },
        not_approved: {
          label: 'Not approved', tone: 'bad',
          message: 'The committee did not approve this application.',
          contact: true
        },
        revoked: {
          label: 'Featured status revoked', tone: 'bad',
          message: "This app's Featured App status has been revoked.",
          contact: true
        },
        withdrawn: {
          label: 'Withdrawn', tone: 'idle',
          message: 'This application was withdrawn.'
        },
        closed_process: {
          label: 'Closed: process changed', tone: 'idle',
          message: "This application was closed when the review process changed, and it won't be reviewed further. To be considered, submit a new application under the current process.",
          linkText: 'How to apply under the current process ↗'  // to config.reapplyUrl (https only)
        }
      },

      // Timeline step titles.
      steps: {
        received: 'Application received',
        lock: 'Canton Coin lock verified',
        testing: 'Testing',
        committee: 'Featured App Committee review',
        tokenomics: 'Tokenomics Committee review',
        granted: 'Featured App status granted'
      },
      // Timeline step details (the grey line under a title).
      details: {
        lockNotVerified: 'Not verified yet',
        lockAmount: '{amount}M CC locked',
        notStarted: 'Not started',
        inProgress: 'In progress',
        paused: 'Paused while CIP-0116 is resolved',
        approved: 'Approved',
        announced: 'Announced on the tokenomics mailing list'
      },
      // The final "stop" step when an application ended without, or lost,
      // Featured App status.
      outcomes: {
        not_approved: { title: 'Not approved', detail: 'Committee decision' },
        withdrawn: { title: 'Withdrawn', detail: '' },
        closed_process: { title: 'Closed', detail: 'Review process changed' },
        revoked: { title: 'Featured status revoked', detail: '' }
      },
      // Testing (from the Testing Process column). Unknown values: in_progress.
      // `flag` is a pill shown next to the step title.
      testing: {
        not_started: { detail: 'Not started' },
        action_needed: { detail: 'We emailed you about testing access', flag: 'Action needed' },
        in_progress: { detail: 'In progress' },
        complete: { detail: 'Complete' }
      }
    },

    // ---- DVP request page -----------------------------------------------------
    dvp: {
      eyebrow: 'DVP / asset-moving request',
      ref: '#{ref}',  // appended to the eyebrow: "DVP / asset-moving request · #147"
      untitled: 'Untitled request',  // only if the request has no name
      back: '← {name}',
      backLabel: 'Back to {name}',  // what screen readers hear for the back link
      forApp: 'For Featured App {name}',
      progressLabel: 'Request progress',
      publicRecord: 'Public record',
      recordIntro: 'Your request on the accountability mailing list:',
      recordLink: '{url} ↗',

      // DVP states (from the DVP board's Status column). Unknown: in_review.
      states: {
        in_review: {
          label: 'In committee review', tone: 'info',
          message: 'The Featured App Committee is reviewing your request. If it approves, the request goes to the Tokenomics Committee for final approval.'
        },
        with_tokenomics: {
          label: 'With Tokenomics Committee', tone: 'info',
          message: 'The Featured App Committee approved your request. The Tokenomics Committee is doing the final review.'
        },
        approved: {
          label: 'Approved', tone: 'ok',
          message: 'Your request was approved.'
        },
        not_approved: {
          label: 'Not approved', tone: 'bad',
          message: 'The committees did not approve this request.',
          contact: true
        },
        closed: {
          label: 'Closed', tone: 'idle',
          message: 'This request was closed.'
        }
      },
      steps: {
        received: 'Request received',
        committee: 'Featured App Committee review',
        tokenomics: 'Tokenomics Committee review',
        approved: 'Approved'
      },
      details: {
        inProgress: 'In progress',
        approved: 'Approved',
        notStarted: 'Not started',
        notYet: 'Not yet'
      },
      outcomes: {
        not_approved: 'Not approved',
        closed: 'Closed'
      }
    }
  };

  // ===========================================================================
  // 2. Settings and constants
  // ===========================================================================

  // From config.js (loaded first). An empty object if config.js is missing.
  const CONFIG = window.FA_STATUS_CONFIG || {};

  // Give up on Apps Script after 20 s and show the error screen.
  const REQUEST_TIMEOUT_MS = 20000;

  // config.js ships with this placeholder until the web app is deployed.
  const API_PLACEHOLDER = 'REPLACE_WITH_DEPLOYMENT_ID';

  // "<token>", then an optional application id and an optional DVP request
  // id (Monday item ids, digits only): "<token>/app-<id>/dvp-<id>".
  const ROUTE_PATTERN = /^([A-Za-z0-9_-]{22})(?:\/app-(\d+))?(?:\/dvp-(\d+))?$/;

  // Characters a sentence or an email client may glue onto the end of a
  // pasted link, e.g. "...#k7Qm2xV9pLr4TzN8wYc3Ef." or "(...#k7Qm...)".
  // Trailing whitespace is dropped too.
  const TRAILING_PUNCTUATION = /[\s.,;:!?)\]'"]+$/;

  // A plausible single email address (no spaces, quotes, brackets or commas).
  const EMAIL_PATTERN = /^[^\s@<>()[\]"',;:\\]+@[^\s@<>()[\]"',;:\\]+\.[^\s@<>()[\]"',;:\\]+$/;

  // What the email form accepts: the same rule as the backend's EMAIL_INPUT_RE.
  const ADDRESS_PATTERN = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  // "14 Oct 2026". Dates are calendar days, so format them in UTC.
  const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  });

  // Locked Canton Coin in millions: 1.5 -> "1.5", 2 -> "2".
  const AMOUNT_FORMAT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });

  // FA states whose timeline stops right after "Application received".
  const FA_ENDED_EARLY = ['not_approved', 'withdrawn', 'closed_process'];

  // FA states where Featured App status was granted (and possibly revoked
  // later). Their timeline leaves out lock and testing steps with no data.
  const FA_GRANTED = ['approved', 'revoked'];

  // Screens that use the narrow, centred column.
  const NARROW_SCREENS = ['start', 'sent', 'loading', 'invalid', 'error'];

  // Screens that show the "Private link" badge in the header.
  const PRIVATE_SCREENS = ['list', 'app', 'dvp'];

  // ===========================================================================
  // 3. Page state
  // ===========================================================================
  //
  // The last good answer stays in memory, so moving between the list, an
  // application and its DVP requests (same token) re-renders without asking
  // again. Each request gets a number; an answer whose number is no longer
  // `session.pending` is stale (the visitor moved on) and is ignored.
  const session = {
    code: null,        // token of `answer`, or of the request in flight
    answer: null,      // { found: true, apps } or { found: false }; null if none yet
    pending: 0,        // number of the request in flight; 0 when idle
    controller: null,  // AbortController of the request in flight
    timer: 0           // its timeout
  };
  let requestCount = 0;
  let warnedAboutConfig = false;
  let sending = false;  // the email form is waiting for Apps Script

  const main = document.querySelector('main');
  const privateBadge = document.querySelector('[data-private-link]');

  // ===========================================================================
  // 4. Pure helpers (parseRoute and formatDate are exposed for tests)
  // ===========================================================================

  /**
   * Reads a location.hash value and says what it asks for.
   *
   *   parseRoute('')                                -> { kind: 'none', code: null, appId: null, dvpId: null }
   *   parseRoute('#k7Qm2xV9pLr4TzN8wYc3Ef')         -> { kind: 'code', code: 'k7Qm…', appId: null, dvpId: null }
   *   parseRoute('#k7Qm2xV9pLr4TzN8wYc3Ef/app-12')  -> { kind: 'code', code: 'k7Qm…', appId: '12', dvpId: null }
   *   parseRoute('#k7Qm…/app-12/dvp-147).')         -> { kind: 'code', code: 'k7Qm…', appId: '12', dvpId: '147' }
   *   parseRoute('#k7Qm2x')                         -> { kind: 'invalid', code: null, appId: null, dvpId: null }
   *
   * The leading "#" is optional, and trailing punctuation pasted from an
   * email is ignored. appId and dvpId are strings of digits, or null.
   */
  function parseRoute(hash) {
    let value = typeof hash === 'string' ? hash : '';
    if (value.charAt(0) === '#') value = value.slice(1);

    // Browsers percent-encode some characters in the fragment (a pasted
    // trailing quote arrives as %22), so decode before stripping.
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      // A malformed %-escape: keep the raw text; it won't match a code.
    }
    value = value.trim().replace(TRAILING_PUNCTUATION, '');

    if (value === '') return { kind: 'none', code: null, appId: null, dvpId: null };
    const match = ROUTE_PATTERN.exec(value);
    if (!match) return { kind: 'invalid', code: null, appId: null, dvpId: null };
    return { kind: 'code', code: match[1], appId: match[2] || null, dvpId: match[3] || null };
  }

  /**
   * Formats an API date ("YYYY-MM-DD") for display: "14 Oct 2026".
   * Returns "" for anything else (missing, malformed or impossible dates such
   * as 2026-02-31); callers leave empty dates out.
   */
  function formatDate(value) {
    if (typeof value !== 'string') return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Reject dates that roll over (2026-02-31) and years below 100, which
    // Date.UTC would read as 19xx.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return '';
    }
    return DATE_FORMAT.format(date);
  }

  /** A trimmed string for text fields; numbers become strings; anything else is "". */
  function textOf(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return '';
  }

  /** True for plain objects (not null, not arrays). */
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /** Joins the non-empty parts with " · ". */
  function joinParts(parts) {
    return parts.filter(Boolean).join(TEXT.separator);
  }

  /** "Submitted 14 Oct 2026", or "" when the date is missing. */
  function submittedText(value) {
    const date = formatDate(value);
    return date ? fillText(TEXT.submitted, { date: date }) : '';
  }

  /** Locked amount in millions as text ("1.5"), or "" unless it is a number above 0. */
  function formatAmount(value) {
    let number = NaN;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && value.trim() !== '') number = Number(value);
    return isFinite(number) && number > 0 ? AMOUNT_FORMAT.format(number) : '';
  }

  /** A state key known to `states`, or `fallback` for anything else. */
  function normalizeState(value, states, fallback) {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return hasOwn(states, key) ? key : fallback;
  }

  /**
   * The testing key. No value at all means testing hasn't started (the
   * backend sends "not_started" for an empty column); an unknown value is
   * shown as in_progress.
   */
  function normalizeTesting(value) {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (key === '') return 'not_started';
    return hasOwn(TEXT.fa.testing, key) ? key : 'in_progress';
  }

  /** An item's id (application or DVP request) as a string of digits, or "" if it has none. */
  function idOf(item) {
    const id = textOf(item.id);
    return /^\d+$/.test(id) ? id : '';
  }

  /** The application with this id, or null. */
  function findApp(apps, id) {
    for (let i = 0; i < apps.length; i += 1) {
      if (idOf(apps[i]) === id) return apps[i];
    }
    return null;
  }

  /** The DVP requests of an application (objects only). */
  function dvpOf(app) {
    return Array.isArray(app.dvp) ? app.dvp.filter(isObject) : [];
  }

  /**
   * The DVP request with this id, preferably inside `preferred` (the app in
   * the URL); otherwise the first app that has it. Returns { app, request }
   * or null.
   */
  function findDvp(apps, preferred, id) {
    const order = preferred ? [preferred].concat(apps) : apps;
    for (let i = 0; i < order.length; i += 1) {
      const list = dvpOf(order[i]);
      for (let j = 0; j < list.length; j += 1) {
        if (idOf(list[j]) === id) return { app: order[i], request: list[j] };
      }
    }
    return null;
  }

  /** The page of one application: "#<token>" when it is the only one, else "#<token>/app-<id>". */
  function appHref(code, apps, app) {
    const id = idOf(app);
    return apps.length > 1 && id ? '#' + code + '/app-' + id : '#' + code;
  }

  /** The page of one DVP request, reached from `app`. */
  function dvpHref(code, apps, app, request) {
    return appHref(code, apps, app) + '/dvp-' + idOf(request);
  }

  /** The value as a parsed URL if it is a valid https:// URL, otherwise null. */
  function parseHttpsUrl(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!/^https:\/\//i.test(raw)) return null;
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && url.hostname ? url : null;
    } catch (err) {
      return null;
    }
  }

  /** A URL as link text: no scheme, no trailing slash ("harborswap.example/docs"). */
  function displayUrl(url) {
    return (url.host + url.pathname + url.search + url.hash).replace(/\/+$/, '');
  }

  // ===========================================================================
  // 5. DOM helpers (no HTML parsing anywhere)
  // ===========================================================================

  /**
   * Creates an element. `props` become attributes, except `class`
   * (className) and `text` (textContent); null, undefined and false values
   * are skipped. `children` is a node, a string (added as a text node) or a
   * nested array of those; empty entries are skipped.
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (name) {
        const value = props[name];
        if (value === null || value === undefined || value === false) return;
        if (name === 'class') node.className = value;
        else if (name === 'text') node.textContent = value;
        else node.setAttribute(name, value === true ? '' : String(value));
      });
    }
    append(node, children);
    return node;
  }

  /** Appends a node, a string (as text) or a nested array of them. */
  function append(parent, child) {
    if (child === null || child === undefined || child === false || child === '') return;
    if (Array.isArray(child)) {
      child.forEach(function (item) { append(parent, item); });
      return;
    }
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  /**
   * Splits a wording template into parts with its {placeholders} replaced by
   * the given values (strings or nodes). Pass the result to el() as children.
   * Values are inserted as text or nodes, never parsed.
   */
  function fill(template, values) {
    const parts = [];
    const pattern = /\{(\w+)\}/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(template)) !== null) {
      parts.push(template.slice(last, match.index));
      parts.push(hasOwn(values, match[1]) ? values[match[1]] : '');
      last = pattern.lastIndex;
    }
    parts.push(template.slice(last));
    return parts;
  }

  /** fill() for templates whose values are all strings: returns a string. */
  function fillText(template, values) {
    return fill(template, values).join('');
  }

  /** The support address from config.js as a mailto: link (plain text if it isn't an address). */
  function emailLink() {
    const email = textOf(CONFIG.supportEmail);
    if (!EMAIL_PATTERN.test(email)) return email;
    return el('a', { href: 'mailto:' + email, text: email });
  }

  /** A link to another site, opening in a new tab. `url` comes from parseHttpsUrl(). */
  function externalLink(url, text, className) {
    return el('a', {
      class: className || null,
      href: url.href,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: text
    });
  }

  /** A status pill. `state` (optional) goes in data-state. */
  function pill(label, tone, state) {
    return el('span', { class: 'pill ' + tone, 'data-state': state || null, text: label });
  }

  /** The page heading block: eyebrow, h1 (focus target) and meta line. */
  function pageHead(eyebrow, title, meta) {
    const hasMeta = Array.isArray(meta) ? meta.some(Boolean) : Boolean(meta);
    return el('div', { class: 'd-head' }, [
      eyebrow ? el('p', { class: 'd-eyebrow', text: eyebrow }) : null,
      el('h1', { class: 'p-h', tabindex: '-1', text: title }),
      hasMeta ? el('p', { class: 'd-meta' }, meta) : null
    ]);
  }

  /** The status box: pill, message, optional extra (link or contact line), last update. */
  function statusBox(state, words, extra, updated) {
    const lastUpdated = formatDate(updated);
    return el('section', { class: 'status-box', 'aria-label': TEXT.statusLabel }, [
      pill(words.label, words.tone, state),
      el('p', { class: 'status-message', text: words.message }),
      extra,
      lastUpdated ? el('p', { class: 'when', text: fillText(TEXT.lastUpdated, { date: lastUpdated }) }) : null
    ]);
  }

  /** "Questions? Contact the Featured App team at <email>." */
  function contactLine() {
    return el('p', { class: 'status-contact' }, fill(TEXT.contact, { email: emailLink() }));
  }

  /** A section below the timeline, with a stable data-section hook. */
  function section(key, heading, content) {
    return el('section', { class: 'p-section', 'data-section': key }, [
      el('h2', { text: heading }),
      content
    ]);
  }

  /** The note about sharing the link, at the bottom of application and DVP pages. */
  function footerNote() {
    return el('p', { class: 'p-fine p-foot', 'data-footnote': '' }, fill(TEXT.footer, { email: emailLink() }));
  }

  // ===========================================================================
  // 6. Timelines
  // ===========================================================================

  /**
   * One timeline step.
   *   key     stable id for tests (data-step)
   *   state   'done' | 'current' | 'todo' | 'stop' (class and data-step-state)
   *   title   step title; detail: grey line under it ("" for none)
   *   flag    optional pill next to the title: { label, tone }
   */
  function step(key, state, title, detail, flag) {
    return { key: key, state: state, title: title, detail: detail || '', flag: flag || null };
  }

  /** Renders steps as ol.tl. */
  function timeline(label, steps) {
    return el('ol', { class: 'tl', 'aria-label': label }, steps.map(function (s) {
      return el('li', {
        class: s.state,
        'data-step': s.key,
        'data-step-state': s.state,
        'aria-current': s.state === 'current' ? 'step' : null
      }, [
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('div', { class: 't' }, [
          el('span', { class: 'visually-hidden', text: TEXT.stepState[s.state] + ': ' }),
          el('span', { class: 'tl-head' }, [
            el('span', { class: 'tl-title', text: s.title }),
            s.flag ? pill(s.flag.label, s.flag.tone) : null
          ]),
          s.detail ? el('span', { class: 'tl-detail', text: s.detail }) : null
        ])
      ]);
    }));
  }

  /** The steps of an FA application's timeline. `state` is already normalised. */
  function faSteps(app, state) {
    const titles = TEXT.fa.steps;
    const details = TEXT.fa.details;
    const steps = [step('received', 'done', titles.received, formatDate(app.submitted))];

    // Not approved, withdrawn or closed: "received", then how it ended. Nothing else.
    if (FA_ENDED_EARLY.indexOf(state) !== -1) {
      const outcome = TEXT.fa.outcomes[state];
      steps.push(step('outcome', 'stop', outcome.title, outcome.detail));
      return steps;
    }

    const granted = FA_GRANTED.indexOf(state) !== -1;

    // Canton Coin lock: done once verified (date, plus the amount if known).
    // Granted apps with no verification date simply don't show the step.
    const lock = isObject(app.lock) ? app.lock : {};
    if (textOf(lock.verified) !== '') {
      const amount = formatAmount(lock.amountMillions);
      steps.push(step('lock', 'done', titles.lock, joinParts([
        formatDate(lock.verified),
        amount ? fillText(details.lockAmount, { amount: amount }) : ''
      ])));
    } else if (!granted) {
      steps.push(step('lock', 'todo', titles.lock, details.lockNotVerified));
    }

    // Testing.
    const testing = normalizeTesting(app.testing);
    const testingWords = TEXT.fa.testing[testing];
    if (testing === 'complete') {
      steps.push(step('testing', 'done', titles.testing, testingWords.detail));
    } else if (testing === 'action_needed') {
      steps.push(step('testing', 'current', titles.testing, testingWords.detail,
        { label: testingWords.flag, tone: 'warn' }));
    } else if (testing === 'in_progress') {
      steps.push(step('testing', 'current', titles.testing, testingWords.detail));
    } else if (!granted) {
      steps.push(step('testing', 'todo', titles.testing, testingWords.detail));
    }

    // Featured App Committee review.
    if (state === 'received') {
      steps.push(step('committee', 'todo', titles.committee, details.notStarted));
    } else if (state === 'in_review') {
      steps.push(step('committee', 'current', titles.committee, details.inProgress));
    } else if (state === 'on_hold') {
      steps.push(step('committee', 'current', titles.committee, details.paused));
    } else {
      // with_tokenomics, approved, revoked: the committee approved it.
      steps.push(step('committee', 'done', titles.committee, details.approved));
    }

    // Tokenomics Committee review.
    if (state === 'with_tokenomics') {
      steps.push(step('tokenomics', 'current', titles.tokenomics, details.inProgress));
    } else if (granted) {
      steps.push(step('tokenomics', 'done', titles.tokenomics, details.approved));
    } else {
      steps.push(step('tokenomics', 'todo', titles.tokenomics, details.notStarted));
    }

    // Featured App status granted (announced on the tokenomics mailing list).
    steps.push(step('granted', granted ? 'done' : 'todo', titles.granted, details.announced));

    // Revoked later: one more "stop" step.
    if (state === 'revoked') {
      steps.push(step('outcome', 'stop', TEXT.fa.outcomes.revoked.title, TEXT.fa.outcomes.revoked.detail));
    }
    return steps;
  }

  /** The steps of a DVP request's timeline. `state` is already normalised. */
  function dvpSteps(request, state) {
    const titles = TEXT.dvp.steps;
    const details = TEXT.dvp.details;
    const steps = [step('received', 'done', titles.received, formatDate(request.submitted))];

    // Not approved or closed: "received", then how it ended.
    if (state === 'not_approved' || state === 'closed') {
      steps.push(step('outcome', 'stop', TEXT.dvp.outcomes[state]));
      return steps;
    }

    // Featured App Committee review: in progress, or approved once it moved on.
    if (state === 'in_review') {
      steps.push(step('committee', 'current', titles.committee, details.inProgress));
    } else {
      steps.push(step('committee', 'done', titles.committee, details.approved));
    }

    // Tokenomics Committee review.
    if (state === 'with_tokenomics') {
      steps.push(step('tokenomics', 'current', titles.tokenomics, details.inProgress));
    } else if (state === 'approved') {
      steps.push(step('tokenomics', 'done', titles.tokenomics, details.approved));
    } else {
      steps.push(step('tokenomics', 'todo', titles.tokenomics, details.notStarted));
    }

    // Final approval, with its date.
    if (state === 'approved') {
      steps.push(step('approved', 'done', titles.approved, formatDate(request.finalApproval)));
    } else {
      steps.push(step('approved', 'todo', titles.approved, details.notYet));
    }
    return steps;
  }

  // ===========================================================================
  // 7. Screens
  // ===========================================================================

  /**
   * Replaces the content of <main> with a screen, then updates the header
   * badge and the tab title, scrolls to the top and moves focus to the new
   * heading so keyboard and screen-reader users start on the new content.
   *   screen   value for data-screen
   *   title    name for the tab title, or null for the plain site name
   *   content  node(s) to show
   */
  function show(screen, title, content) {
    main.textContent = '';
    main.className = NARROW_SCREENS.indexOf(screen) !== -1 ? 'p-body p-narrow' : 'p-body';
    main.setAttribute('data-screen', screen);
    append(main, content);

    if (privateBadge) privateBadge.hidden = PRIVATE_SCREENS.indexOf(screen) === -1;
    document.title = title ? title + TEXT.separator + TEXT.siteName : TEXT.siteName;

    window.scrollTo(0, 0);
    const heading = main.querySelector('h1');
    if (heading) {
      try {
        heading.focus({ preventScroll: true });
      } catch (err) {
        heading.focus();
      }
    }
  }

  /** A heading and one paragraph (the top of start, invalid and error screens). */
  function messageHead(heading, body) {
    return el('div', { class: 'd-head' }, [
      el('h1', { class: 'p-h', tabindex: '-1', text: heading }),
      el('p', { class: 'p-sub' }, body)
    ]);
  }

  /** The start page: what this is, and the email form. */
  function showStart(prefill) {
    show('start', null, [
      messageHead(TEXT.start.heading, TEXT.start.body),
      emailForm(prefill),
      el('p', { class: 'p-fine' }, fill(TEXT.start.fine, { email: emailLink() }))
    ]);
  }

  /** After the form: "check your email". The answer never says whether the address applied. */
  function showSent(address) {
    // A bad token in the URL has done its job; drop it so a reload shows the start page.
    if (window.location.hash && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const again = el('button', { class: 'p-btn secondary', type: 'button', 'data-action': 'again', text: TEXT.sent.again });
    again.addEventListener('click', function () { showStart(''); });
    show('sent', null, [
      messageHead(TEXT.sent.heading, fill(TEXT.sent.body, { address: el('strong', { class: 'address', text: address }) })),
      el('p', { class: 'p-fine' }, fill(TEXT.sent.noEmail, { email: emailLink() })),
      again
    ]);
  }

  /** A link that doesn't work: say so, and offer the email form. */
  function showInvalid() {
    show('invalid', null, [
      messageHead(TEXT.invalid.heading, TEXT.invalid.body),
      emailForm(''),
      el('p', { class: 'p-fine' }, fill(TEXT.start.fine, { email: emailLink() }))
    ]);
  }

  function showError() {
    const retry = el('button', { class: 'p-btn', type: 'button', 'data-action': 'retry', text: TEXT.error.retry });
    retry.addEventListener('click', retryRequest);
    show('error', null, [
      messageHead(TEXT.error.heading, fill(TEXT.error.body, { email: emailLink() })),
      retry
    ]);
  }

  function showLoading() {
    show('loading', null, el('div', { class: 'loading', role: 'status' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', { text: TEXT.loading })
    ]));
  }

  /** Several applications: one card each, newest first (the backend's order). */
  function showList(code, apps) {
    const cards = apps.map(function (app) {
      const state = normalizeState(app.state, TEXT.fa.states, 'in_review');
      const words = TEXT.fa.states[state];
      const count = dvpOf(app).length;
      const meta = joinParts([
        textOf(app.institution),
        submittedText(app.submitted),
        count === 1 ? TEXT.list.dvpOne : count > 1 ? fillText(TEXT.list.dvpMany, { count: String(count) }) : ''
      ]);
      // The spaces keep the card's text (and so the link's accessible name) readable.
      const content = [
        el('span', { class: 'app-name', text: textOf(app.name) || TEXT.fa.untitled }),
        ' ',
        pill(words.label, words.tone, state),
        meta ? [' ', el('span', { class: 'app-meta', text: meta })] : null
      ];
      const id = idOf(app);
      const card = id
        ? el('a', { class: 'app', href: '#' + code + '/app-' + id, 'data-app-id': id }, content)
        : el('div', { class: 'app' }, content);
      return el('li', null, card);
    });
    show('list', TEXT.list.heading, [
      pageHead(null, TEXT.list.heading, TEXT.list.intro),
      el('ul', { class: 'app-list' }, cards),
      footerNote()
    ]);
  }

  /** The application page. With several applications, a link leads back to the list. */
  function showApp(code, apps, app) {
    const state = normalizeState(app.state, TEXT.fa.states, 'in_review');
    const words = TEXT.fa.states[state];
    const name = textOf(app.name) || TEXT.fa.untitled;

    show('app', name, [
      apps.length > 1 ? el('a', { class: 'back', href: '#' + code, text: TEXT.list.back }) : null,
      pageHead(TEXT.fa.eyebrow, name, joinParts([
        textOf(app.institution),
        textOf(app.type),
        submittedText(app.submitted)
      ])),
      statusBox(state, words, faStatusExtra(app, state, words), app.updated),
      timeline(TEXT.fa.progressLabel, faSteps(app, state)),
      onFileSection(app),
      dvpListSection(code, apps, app),
      footerNote()
    ]);
  }

  /** What goes under the FA status message: a link or the contact line, or nothing. */
  function faStatusExtra(app, state, words) {
    if (state === 'approved') {
      const announcement = parseHttpsUrl(app.announcement);
      return announcement ? externalLink(announcement, words.linkText, 'status-action') : null;
    }
    if (state === 'closed_process') {
      const reapply = parseHttpsUrl(CONFIG.reapplyUrl);
      return reapply ? externalLink(reapply, words.linkText, 'status-action p-btn secondary') : null;
    }
    return words.contact ? contactLine() : null;
  }

  /** "On file": Party ID and product site; null when both are missing. */
  function onFileSection(app) {
    const rows = [];
    const partyId = textOf(app.partyId);
    if (partyId) {
      rows.push(
        el('dt', { text: TEXT.fa.partyId }),
        el('dd', { class: 'mono', 'data-field': 'party-id', text: partyId })
      );
    }
    const website = parseHttpsUrl(app.website);
    if (website) {
      rows.push(
        el('dt', { text: TEXT.fa.productSite }),
        el('dd', { 'data-field': 'website' }, externalLink(website, displayUrl(website), 'url-text'))
      );
    }
    return rows.length ? section('on-file', TEXT.fa.onFile, el('dl', { class: 'kv' }, rows)) : null;
  }

  /** "DVP requests for this app": one card per request; null when there are none. */
  function dvpListSection(code, apps, app) {
    const requests = dvpOf(app);
    if (requests.length === 0) return null;

    const cards = requests.map(function (request) {
      const state = normalizeState(request.state, TEXT.dvp.states, 'in_review');
      const words = TEXT.dvp.states[state];
      const submitted = submittedText(request.submitted);
      // The spaces between the parts are invisible in the grid layout, but
      // keep the card's text (and so the link's accessible name) readable:
      // "Harbor Swap: RFQ settlement In committee review Submitted 20 Oct 2026".
      const content = [
        el('span', { class: 'app-name', text: textOf(request.name) || TEXT.dvp.untitled }),
        ' ',
        pill(words.label, words.tone, state),
        submitted ? [' ', el('span', { class: 'app-meta', text: submitted })] : null
      ];
      // A card links to the request's page when the request has a usable id.
      const id = idOf(request);
      const card = id
        ? el('a', { class: 'app', href: dvpHref(code, apps, app, request), 'data-dvp-id': id }, content)
        : el('div', { class: 'app' }, content);
      return el('li', null, card);
    });
    return section('dvp', TEXT.fa.dvpHeading, el('ul', { class: 'app-list' }, cards));
  }

  /** A DVP request's page. */
  function showDvp(code, apps, app, request) {
    const appName = textOf(app.name) || TEXT.fa.untitled;
    const appLink = appHref(code, apps, app);
    const state = normalizeState(request.state, TEXT.dvp.states, 'in_review');
    const words = TEXT.dvp.states[state];
    const name = textOf(request.name) || TEXT.dvp.untitled;

    const ref = textOf(request.requestRef).replace(/^#/, '');
    const eyebrow = ref
      ? TEXT.dvp.eyebrow + TEXT.separator + fillText(TEXT.dvp.ref, { ref: ref })
      : TEXT.dvp.eyebrow;

    // "For Featured App <app name> · Submitted <date>", the app name linking back.
    const meta = fill(TEXT.dvp.forApp, { name: el('a', { href: appLink, text: appName }) });
    const submitted = submittedText(request.submitted);
    if (submitted) meta.push(TEXT.separator, submitted);

    show('dvp', name, [
      el('a', {
        class: 'back',
        href: appLink,
        'aria-label': fillText(TEXT.dvp.backLabel, { name: appName }),
        text: fillText(TEXT.dvp.back, { name: appName })
      }),
      pageHead(eyebrow, name, meta),
      statusBox(state, words, words.contact ? contactLine() : null, request.updated),
      timeline(TEXT.dvp.progressLabel, dvpSteps(request, state)),
      publicRecordSection(request.requestUrl),
      footerNote()
    ]);
  }

  /** "Public record": the request's post on the accountability list; null without an https URL. */
  function publicRecordSection(requestUrl) {
    const url = parseHttpsUrl(requestUrl);
    if (!url) return null;
    return section('record', TEXT.dvp.publicRecord, el('p', { class: 'p-fine record' }, [
      TEXT.dvp.recordIntro,
      ' ',
      externalLink(url, fillText(TEXT.dvp.recordLink, { url: displayUrl(url) }), 'url-text')
    ]));
  }

  /**
   * Renders a good answer for the current route:
   *   a DVP id   -> that request (inside the app in the URL, if any)
   *   an app id  -> that application
   *   neither    -> the only application, or the list
   * Unknown ids fall back to the application, then to the list.
   */
  function showAnswer(route, answer) {
    try {
      if (!answer.found) {
        showInvalid();
        return;
      }
      const apps = answer.apps;
      const app = route.appId ? findApp(apps, route.appId) : (apps.length === 1 ? apps[0] : null);
      const hit = route.dvpId ? findDvp(apps, app, route.dvpId) : null;
      if (hit) showDvp(route.code, apps, hit.app, hit.request);
      else if (app) showApp(route.code, apps, app);
      else showList(route.code, apps);
    } catch (err) {
      // An unexpected answer must never leave the page blank. No details are
      // logged, since they could include application data.
      console.error('FA Status: could not display this answer.');
      showError();
    }
  }

  // ===========================================================================
  // 8. The email form
  // ===========================================================================

  /**
   * The "email me my link" form. Submitting checks the address, then sends
   * it to Apps Script (see requestLink). `prefill` is an address to start
   * with, or "".
   */
  function emailForm(prefill) {
    const input = el('input', {
      id: 'email',
      class: 'field',
      type: 'email',
      name: 'email',
      autocomplete: 'email',
      inputmode: 'email',
      autocapitalize: 'off',
      spellcheck: 'false',
      maxlength: '254',
      placeholder: TEXT.start.placeholder,
      'aria-describedby': 'email-message'
    });
    if (prefill) input.value = prefill;
    const button = el('button', { class: 'p-btn', type: 'submit', text: TEXT.start.button });
    const message = el('p', { id: 'email-message', class: 'form-message', 'aria-live': 'polite' });
    const form = el('form', { class: 'email-form', 'data-form': 'email', novalidate: true }, [
      el('label', { class: 'field-label', for: 'email', text: TEXT.start.label }),
      el('div', { class: 'field-row' }, [input, button]),
      message
    ]);

    form.addEventListener('submit', function (event) {
      event.preventDefault();  // never a native form submission (the CSP forbids it anyway)
      const address = input.value.trim();
      if (!ADDRESS_PATTERN.test(address)) {
        setFormMessage(form, TEXT.start.invalid);
        input.focus();
        return;
      }
      requestLink(form, address);
    });
    return form;
  }

  /** Shows (or clears, with "") the message under the form, and marks the field. */
  function setFormMessage(form, text) {
    const message = form.querySelector('.form-message');
    const input = form.querySelector('input');
    message.textContent = text;
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /**
   * Sends the address to Apps Script: POST with a text/plain JSON body, so
   * the browser makes no CORS preflight. Shows "check your email" on
   * { ok: true }, and a message under the form for anything else.
   */
  function requestLink(form, address) {
    if (sending) return;
    const button = form.querySelector('button');
    const apiUrl = configuredApiUrl();
    if (!apiUrl) {
      setFormMessage(form, TEXT.start.failed);
      return;
    }

    sending = true;
    button.disabled = true;
    button.textContent = TEXT.start.sending;
    setFormMessage(form, '');

    let done = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = window.setTimeout(function () {
      finishSend(null);
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    // result: 'ok', 'invalid', or null for any failure.
    function finishSend(result) {
      if (done) return;
      done = true;
      sending = false;
      window.clearTimeout(timer);
      if (!form.isConnected) return;  // the visitor already moved on
      if (result === 'ok') {
        showSent(address);
        return;
      }
      button.disabled = false;
      button.textContent = TEXT.start.button;
      setFormMessage(form, result === 'invalid' ? TEXT.start.invalid : TEXT.start.failed);
    }

    const options = {
      method: 'POST',
      body: JSON.stringify({ email: address }),  // a string body is sent as text/plain
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow'
    };
    if (controller) options.signal = controller.signal;

    let request;
    try {
      request = window.fetch(apiUrl, options);
    } catch (err) {
      finishSend(null);
      return;
    }
    request
      .then(function (response) {
        if (!response.ok) throw new Error('Unexpected HTTP status');
        return response.json();
      })
      .then(
        function (body) {
          if (isObject(body) && body.ok === true) finishSend('ok');
          else if (isObject(body) && body.error === 'invalid_email') finishSend('invalid');
          else finishSend(null);
        },
        function () { finishSend(null); }
      );
  }

  // ===========================================================================
  // 9. Loading a link's applications
  // ===========================================================================

  /** The /exec URL from config.js, or "" (with one console warning) if it isn't set up. */
  function configuredApiUrl() {
    const apiUrl = textOf(CONFIG.apiUrl);
    if (apiUrl && apiUrl.indexOf(API_PLACEHOLDER) === -1 && /^https:\/\//i.test(apiUrl)) return apiUrl;
    if (!warnedAboutConfig) {
      warnedAboutConfig = true;
      console.warn('FA Status: config.js has no usable apiUrl (still ' + API_PLACEHOLDER +
        ', missing, or not https). Set it to the Apps Script web app /exec URL.');
    }
    return '';
  }

  /** Reads the JSON body: a good answer, or null for anything unusable. */
  function readAnswer(body) {
    if (!isObject(body) || body.error) return null;
    if (body.found === true && Array.isArray(body.apps)) {
      const apps = body.apps.filter(isObject);
      return apps.length ? { found: true, apps: apps } : { found: false };
    }
    if (body.found === false) return { found: false };
    return null;
  }

  /** Stops the request in flight, if any; its answer will be ignored. */
  function cancelRequest() {
    session.pending = 0;
    window.clearTimeout(session.timer);
    session.timer = 0;
    if (session.controller) {
      const controller = session.controller;
      session.controller = null;
      controller.abort();
    }
  }

  /** Asks Apps Script about `code`, showing the loading screen meanwhile. */
  function load(code) {
    cancelRequest();
    session.code = code;
    session.answer = null;

    const apiUrl = configuredApiUrl();
    if (!apiUrl) {
      showError();
      return;
    }

    requestCount += 1;
    const id = requestCount;
    session.pending = id;
    showLoading();

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    session.controller = controller;
    session.timer = window.setTimeout(function () {
      finish(id, null);  // timed out: show the error screen
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    // A plain GET: no custom headers and no cache option, so no CORS preflight.
    const options = {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow'
    };
    if (controller) options.signal = controller.signal;
    const url = apiUrl + (apiUrl.indexOf('?') === -1 ? '?' : '&') + 'link=' + encodeURIComponent(code);

    let request;
    try {
      request = window.fetch(url, options);
    } catch (err) {
      finish(id, null);
      return;
    }
    request
      .then(function (response) {
        if (!response.ok) throw new Error('Unexpected HTTP status');
        return response.json();  // rejects on a body that isn't JSON
      })
      .then(
        function (body) { finish(id, readAnswer(body)); },
        function () { finish(id, null); }  // network error, abort, bad status or bad JSON
      );
  }

  /** Handles the end of request `id`: a good answer, or null for any failure. */
  function finish(id, answer) {
    if (id !== session.pending) return;  // stale, cancelled or already finished
    session.pending = 0;
    window.clearTimeout(session.timer);
    session.timer = 0;
    session.controller = null;
    session.answer = answer;  // stays null after a failure, so the next visit asks again

    // hashchange fires a moment after the URL changes, so check that the URL
    // still asks for this token; if not, the pending hashchange takes over.
    const route = parseRoute(window.location.hash);
    if (route.kind !== 'code' || route.code !== session.code) return;
    if (answer) showAnswer(route, answer);
    else showError();
  }

  /** "Try again" on the error screen: ask again for the token in the URL. */
  function retryRequest() {
    const route = parseRoute(window.location.hash);
    if (route.kind === 'code') load(route.code);
    else handleRoute();
  }

  // ===========================================================================
  // 10. Routing
  // ===========================================================================

  /** Shows whatever the current URL asks for. Runs on load and on every hashchange. */
  function handleRoute() {
    const route = parseRoute(window.location.hash);
    if (route.kind === 'none') {
      cancelRequest();
      showStart('');
      return;
    }
    if (route.kind === 'invalid') {
      cancelRequest();  // no request for a malformed token
      showInvalid();
      return;
    }
    if (route.code === session.code) {
      // Same token: re-render from memory (list <-> application <-> DVP page).
      if (session.answer) {
        showAnswer(route, session.answer);
        return;
      }
      // Still loading it: finish() will render whatever the URL asks for then.
      if (session.pending) return;
    }
    load(route.code);
  }

  // ===========================================================================
  // 11. White / dark theme
  // ===========================================================================
  //
  // The page follows the system setting until the visitor presses the theme
  // button. Their choice is kept in localStorage under THEME_KEY, and
  // theme.js applies it on the next visit before the page paints. Storage can
  // be unavailable; the button then still works for the current page.

  const THEME_KEY = 'fa-status-theme';  // the same key as in theme.js
  const themeButton = document.querySelector('[data-theme-toggle]');
  const darkQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  /** The theme on screen now: the visitor's pick, or else the system's. */
  function currentTheme() {
    const picked = document.documentElement.getAttribute('data-theme');
    if (picked === 'light' || picked === 'dark') return picked;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  /** Names the button after what pressing it does. */
  function labelThemeButton() {
    if (!themeButton) return;
    const label = currentTheme() === 'dark' ? TEXT.theme.toLight : TEXT.theme.toDark;
    themeButton.setAttribute('aria-label', label);
    themeButton.setAttribute('title', label);
  }

  /** Switches to the other theme and remembers the choice. */
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch (err) {
      // No storage: the choice lasts until the page is closed.
    }
    labelThemeButton();
  }

  if (themeButton) {
    themeButton.addEventListener('click', toggleTheme);
    labelThemeButton();
    // While the visitor hasn't picked, a system change flips the theme: keep the label right.
    if (darkQuery && typeof darkQuery.addEventListener === 'function') {
      darkQuery.addEventListener('change', labelThemeButton);
    }
  }

  // ===========================================================================
  // 12. Start
  // ===========================================================================

  // Pure functions only, for the page tests.
  window.FAStatus = Object.freeze({ parseRoute: parseRoute, formatDate: formatDate });

  if (!main) return;
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
})();
