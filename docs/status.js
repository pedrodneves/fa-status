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
 *        "#featured"                         the public list of featured apps
 *        "#<token>"                          the applications of that address
 *        "#<token>/app-<id>"                 one application
 *        "#<token>/app-<id>/dvp-<id>"        one DVP request ("/app-<id>" optional)
 *   2. asks the Apps Script web app for that token's applications (or for the
 *      public list) with a plain GET, or sends the email form with a POST
 *      (text/plain body, no custom headers, so the browser makes no CORS
 *      preflight);
 *   3. renders one screen into <main>, marked with a data-screen attribute:
 *        start     the email form
 *        sent      "check your email"
 *        loading   waiting for Apps Script (usually 1-2 s)
 *        featured  the public list: every app with Featured App status
 *        list      several applications: one card each
 *        app       one application (straight away when there is only one)
 *        dvp       one DVP request of an application
 *        invalid   malformed token, or Apps Script answered { found: false };
 *                  shows the email form again
 *        error     network error, timeout, unusable answer, or config.js
 *                  still has the placeholder apiUrl
 *
 * Answer shapes (see "Response contract" in DESIGN.md):
 *   GET  { found: true, apps: [{ id, name, institution, type, faType, dvpStatus, submitted, state,
 *                                lock, testing, partyId, website, announcement,
 *                                update: { kind, date } | null,
 *                                updated, dvp: [{ id, name, state, submitted,
 *                                finalApproval, requestUrl, requestRef, updated }] }] }
 *        { found: false }
 *        { error: "unavailable" }
 *   GET ?view=featured
 *        { updated, apps: [{ name, type, status, since, sinceExact, partyIds, record }] }
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
      eyebrow: 'For Featured App applicants',
      heading: 'Check your application status',
      body: "Enter the email address on your Featured App application. We'll email you a private link to the status of your applications and DVP requests.",
      label: 'Email address',
      placeholder: 'name@company.com',
      button: 'Email me my link',
      sending: 'Sending…',
      invalid: 'Enter one email address, like name@company.com.',
      failed: "We couldn't send your link just now. Please try again in a minute.",
      fine: 'We only email addresses that are on a Featured App application. Questions? Contact the Featured App team at {email}.',
      publicLink: 'See which apps are featured →'  // to the public list (#featured)
    },
    sent: {
      heading: 'Check your email',
      body: "If {address} is on a Featured App application, we've sent it a link. It can take a few minutes, so check your spam folder too.",
      noEmail: "Nothing after 15 minutes? That address may not be on an application: try another one you applied with, or contact the Featured App team at {email}.",
      again: 'Use a different email'
    },

    // ---- Below the form on the start, sent and invalid screens -------------
    about: {
      // The sample card next to the form (hidden from screen readers: it's decoration).
      example: {
        tag: 'Example',
        eyebrow: 'Featured App application',
        name: 'Your app',
        meta: 'Your institution',
        pill: 'In committee review',
        step: 'Step 4 of 6',
        stepName: 'Featured App Committee review',
        email: 'Latest email from the committee',
        emailTitle: 'Office hours invitation'
      },
      promisesLabel: 'About your status page',
      promises: [
        { icon: 'lock', title: 'Private to your email', text: 'Your link shows only the applications that list your address. No one else can find them.' },
        { icon: 'refresh', title: 'Updated every 10 minutes', text: "The page reads the committee's own records, so changes show up soon after they're made." },
        { icon: 'layers', title: 'Applications and DVP requests', text: 'Every application on your address, with the DVP / asset-moving requests that belong to it.' }
      ],
      // Step titles come from fa.steps, so they always match the timeline.
      how: {
        eyebrow: 'How review works',
        heading: 'Six steps from application to Featured App status',
        intro: "Your status page shows which of these steps are done and which one you're on.",
        steps: [
          { key: 'received', text: 'Your submission is logged with the date it arrived.' },
          { key: 'lock', text: 'We confirm your Canton Coin lock and record the amount locked.' },
          { key: 'testing', text: 'We test your app. If we need access from you, we email you.' },
          { key: 'committee', text: 'The committee reviews your application and may invite you to its office hours.' },
          { key: 'tokenomics', text: 'Once the Featured App Committee approves, the Tokenomics Committee does the final review.' },
          { key: 'granted', text: 'Approval is announced on the tokenomics mailing list, and the app joins the public list of featured apps.' }
        ]
      },
      // Labels and explanations come from fa.states.
      statuses: {
        eyebrow: 'Statuses',
        heading: 'What each status means'
      },
      faq: {
        eyebrow: 'FAQ',
        heading: 'Questions applicants ask',
        intro: 'Something else? Contact the Featured App team at {email}.',
        items: [
          { q: "I didn't get an email", a: 'Links can take a few minutes, so check your spam folder. We only email addresses that are on an application, as its main email or as a responsible person. Nothing after 15 minutes? Try another address you applied with, or contact the Featured App team at {email}.' },
          { q: 'Who can see my status?', a: 'Anyone who has your link. Each address on an application gets its own link, which shows only the applications that list that address. Share it only within your team.' },
          { q: 'Is anything about my application public?', a: "Only once your app is featured. The public list of featured apps then shows its name, Featured App type, status, the date it was featured, its Party ID and the announcement. If the status is later revoked, the app stays on the list as revoked, with the date. Nothing else from your application is public." },
          { q: 'How current is the page?', a: "It refreshes from the committee's records every 10 minutes. Each application shows the date its record last changed." },
          { q: 'I lost my link. Can I get it again?', a: "Yes. Enter your email address above and we'll send the same link again. You can ask once every 15 minutes, up to three times in six hours." },
          { q: "My DVP request isn't showing", a: 'DVP requests are matched to applications by name. If your request uses a different name from your application, contact the Featured App team at {email} so they can link them.' },
          { q: 'Can I change my application here?', a: 'No, this page is read-only. To update anything on file, contact the Featured App team at {email}.' }
        ]
      }
    },

    // ---- Footer (every screen) -----------------------------------------------
    // `url: 'reapply'` means config.reapplyUrl; `email: true` is the support
    // address; `hash` is a screen of this page.
    siteFooter: {
      label: 'Useful links',
      about: "Featured App Status shows applicants where their applications stand, and everyone which apps are featured. It's read-only: to change anything, contact the Featured App team.",
      groups: [
        { heading: 'Apply', links: [{ text: 'Featured App request ↗', url: 'reapply' }, { text: 'canton.foundation ↗', url: 'https://canton.foundation/' }] },
        { heading: 'Public record', links: [{ text: 'Featured apps', hash: 'featured' }, { text: 'Accountability mailing list ↗', url: 'https://lists.sync.global/g/accountability' }] },
        { heading: 'Contact', links: [{ email: true }] }
      ]
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

    // ---- The public list of featured apps (#featured) ------------------------
    // Everyone sees the same list. Type labels and their filters come from
    // the data (the FA Type column), so a new type shows up on its own.
    featured: {
      title: 'Featured apps',  // browser tab title
      eyebrow: 'Public record',
      heading: 'Featured apps',
      intro: 'Apps that hold Featured App status on Canton Network, with their type and Party ID, and the apps whose status was revoked. Nothing else from their applications is shown.',
      back: '← Check your own application',
      loading: 'Loading the list of featured apps…',
      error: {
        heading: "We couldn't load the list",
        body: 'Please check your connection and try again. If this keeps happening, contact the Featured App team at {email}.'
      },
      // The numbers in the band. `assetMoving` counts this FA Type label.
      stats: { total: 'Featured apps', assetMoving: 'Asset-moving', provisional: 'Provisional' },
      assetMovingType: 'Featured Asset-Moving App',
      searchLabel: 'Search by app name or Party ID',
      searchPlaceholder: 'e.g. wallet',
      filtersLabel: 'Filter the list',
      filters: { all: 'All', none: 'Type not set', provisional: 'Provisional' },
      // Type labels in this order first, then any other alphabetically.
      typeOrder: ['Basic Featured App', 'Featured Asset-Moving App', 'Featured Asset'],
      columns: { app: 'App', type: 'Featured App type', status: 'Status', since: 'Featured since', revokedOn: 'Revoked on', record: 'Public record' },
      status: {
        featured: { label: 'Featured', tone: 'ok' },
        provisional: { label: 'Provisional', tone: 'warn' },
        revoked: { label: 'Revoked', tone: 'bad' }
      },
      // Apps whose Featured App status was revoked: a card of their own under
      // the list, searched with it. Shown only when there are any.
      revoked: {
        heading: 'Featured status revoked',
        intro: 'These apps held Featured App status, and the committee has revoked it. They no longer have Featured App status.',
        empty: 'No revoked app matches that search.'
      },
      typeNotSet: 'Not set yet',
      sinceBy: 'By {date}',  // sinceExact false: featured (or revoked) on or before that day
      record: 'Announcement ↗',
      noRecord: 'Not linked',
      partyId: 'Party ID',
      noPartyId: 'No Party ID on file',
      copy: 'Copy',
      copyName: 'Copy the Party ID of {name}',  // the copy button's accessible name
      provisionalNote: "Provisional: the committee set conditions for this status, and can revoke it if they aren't met.",
      showing: 'Showing {shown} of {total}',
      updated: 'Updated {day}, {time}',
      empty: 'No featured app matches that search.',
      none: 'No apps are listed yet.',
      csv: 'Download CSV',
      json: 'JSON feed ↗',
      feed: {
        heading: 'Use this list in your tools',
        text: 'The same list is available as JSON and as a CSV file, for monitoring and automations. It refreshes every 10 minutes.',
        fields: 'Each app has: name, type, status ("featured", "provisional" or "revoked"), since, sinceExact, partyIds and record. For a revoked app, since is the date its status was revoked.',
        copy: 'Copy',
        copyName: 'Copy the JSON feed address'
      },
      about: {
        heading: 'About this list',
        items: [
          "It comes from the Featured App Committee's records and refreshes every 10 minutes.",
          "Shown for each app: its name, Featured App type, status, the date it was featured, its Party ID and the public announcement. Nothing else from its application.",
          'Apps whose status was revoked are listed separately, with the date it was revoked.',
          '"By 7 Jul 2026" means the app was featured (or revoked) on or before that day: the records of when a status changed start in July 2026.'
        ],
        apply: 'Applied and waiting? {link} with your email address.',
        applyLink: 'Check your own application'
      }
    },

    // ---- Shared by the application and DVP pages ---------------------------
    submitted: 'Submitted {date}',
    lastUpdated: 'Last updated {date}',
    contact: 'Questions? Contact the Featured App team at {email}.',
    footer: 'This page is private to your email address. Anyone with the link can see these applications, so share it only within your team. Questions? Contact the Featured App team at {email}.',
    statusHeading: 'Where things stand',  // heading of the status box
    nextHeading: 'What happens next',      // the box under the status message (states with `next`)
    // Under the steps in the purple band, and on each card of the list.
    progress: {
      step: 'Step {n} of {total}',
      allDone: 'All steps complete'
    },
    // "34 days ago" on the number tiles. Future dates show the date instead.
    ago: {
      today: 'Today',
      yesterday: 'Yesterday',
      days: '{n} days ago',
      month: '1 month ago',
      months: '{n} months ago',
      year: '1 year ago',
      years: '{n} years ago'
    },
    // The number tiles under the band.
    tiles: {
      submitted: 'Submitted',
      locked: 'Canton Coin locked',
      lockAmount: '{amount}M CC',
      lockVerified: 'Verified {date}',
      verified: 'Verified',
      confirmed: 'Confirmed',
      notVerified: 'Not verified yet',
      testing: 'Testing',
      lastUpdated: 'Last updated',
      finalApproval: 'Final approval',
      notYet: 'Not yet'
    },
    // "Activity" on the application page: dated events, newest first.
    activity: {
      heading: 'Activity',
      emailed: 'The committee emailed you',
      recordUpdated: 'Record last updated',
      status: 'Status: {status}',
      dvpSubmitted: 'DVP request submitted',
      dvpApproved: 'DVP request approved',
      lockVerified: 'Canton Coin lock verified',
      submitted: 'Application submitted'
    },
    // "History": every change from Monday's activity log (app.history), with
    // the submission dates. Replaces "Activity" when the backend sends it.
    history: {
      heading: 'History',
      moreOne: 'Show 1 earlier change',
      more: 'Show {count} earlier changes',
      // An FA Status change: the title for the new step; the detail is "Status: <pill label>".
      status: {
        received: 'Application received',
        in_review: 'Moved to committee review',
        in_review_locked: 'Canton Coin lock confirmed',
        with_tokenomics: 'Approved by the Featured App Committee',
        approved: 'Featured App status granted',
        provisional: 'Provisionally approved',
        on_hold: 'Review paused',
        not_approved: 'Not approved',
        revoked: 'Featured status revoked',
        withdrawn: 'Withdrawn',
        closed_process: 'Closed: review process changed'
      },
      statusDetail: 'Status: {status}',
      testing: {
        not_started: 'Testing not started',
        action_needed: 'We emailed you about testing access',
        in_progress: 'Testing in progress',
        complete: 'Testing complete'
      },
      lockVerified: 'Canton Coin lock verified',
      lockAmount: 'Locked amount recorded',
      email: 'The committee emailed you',
      faType: 'Featured App type set',
      dvpStatus: 'DVP status updated',
      dvpRequest: 'DVP request updated',
      // A DVP request's Status change, on the DVP page.
      dvpState: {
        in_review: 'In committee review',
        with_tokenomics: 'Approved by the Featured App Committee',
        approved: 'Approved by the Tokenomics Committee',
        not_approved: 'Not approved',
        closed: 'Closed'
      },
      submitted: 'Application submitted',
      dvpSubmitted: 'DVP request submitted',
      dvpReceived: 'Request received',
      finalApproval: 'Final approval'
    },
    // The help box at the bottom of the side column.
    help: {
      app: 'Questions about this application?',
      decision: 'Questions about this decision?',  // not approved
      dvp: 'Questions about this request?',
      text: 'The Featured App team can help with anything on this page.',
      button: 'Email {email}',
      privateNote: 'This page is private to your email address. Anyone with the link can see it, so share it only within your team.'
    },
    // Read by screen readers before each timeline step (the dots are visual only).
    stepState: {
      done: 'Completed',
      current: 'Current step',
      todo: 'Upcoming',
      stop: 'Outcome'
    },

    // ---- List of applications (when an address has more than one) ----------
    list: {
      eyebrow: 'Your status page',
      heading: 'Your applications',
      intro: 'Featured App applications that list your email address. Select one to see its progress and DVP requests.',
      dvpOne: '1 DVP request',
      dvpMany: '{count} DVP requests',
      // The count chips in the band; a chip with a count of 0 isn't shown.
      chips: {
        appsOne: '1 application',
        appsMany: '{count} applications',
        active: '{count} in progress',
        approved: '{count} approved',
        ended: '{count} ended'
      },
      email: 'Latest email from the committee: {title}',
      back: '← All your applications'
    },

    // ---- Application page ---------------------------------------------------
    fa: {
      eyebrow: 'Featured App application',
      untitled: 'Untitled application',  // only if the app has no name
      progressLabel: 'Application progress',
      onFile: 'On file',
      faType: 'Featured App type',
      issuerType: 'Issuer type',
      partyId: 'Party ID',
      copy: 'Copy Party ID',
      copied: 'Copied',
      productSite: 'Product site',
      dvpHeading: 'DVP',

      // The app's DVP status (the DVP Status column on the FA board).
      // Unknown values show nothing.
      dvpStatus: {
        label: 'DVP status',
        states: {
          in_review: { label: 'In committee review', tone: 'info' },
          faac_approved: { label: 'Approved by the Featured App Committee', tone: 'ok' },
          declined: { label: 'Declined', tone: 'bad' }
        }
      },

      // FA states (the backend maps the FA Status column to these keys).
      // Any other value is shown as in_review. `next` fills the "What
      // happens next" box; states without it don't show the box.
      // "provisional" needs a "2b-Provisional" FA Status label, which the
      // board doesn't have yet: until the committee adds it, no app has it.
      states: {
        received: {
          label: 'Received', tone: 'info',
          message: 'Your application has been received and is waiting for committee review.',
          next: 'Next, the Featured App Committee reviews your application. This page updates when review starts.'
        },
        in_review: {
          label: 'In committee review', tone: 'info',
          message: 'The Featured App Committee is reviewing your application.',
          next: 'If the committee approves, your application goes to the Tokenomics Committee for the final review.'
        },
        with_tokenomics: {
          label: 'With Tokenomics Committee', tone: 'info',
          message: 'The Featured App Committee approved your application. The Tokenomics Committee is doing the final review.',
          next: 'If the Tokenomics Committee approves, your app gets Featured App status, and the approval is announced on the tokenomics mailing list.'
        },
        approved: {
          label: 'Approved', tone: 'ok',
          message: 'Your app has Featured App status.',
          linkText: 'View the public announcement ↗',  // to app.announcement (https only)
          next: 'Nothing more is needed for this application.'
        },
        provisional: {
          label: 'Provisionally approved', tone: 'warn',
          message: 'Your app has Featured App status on a provisional basis: the committee set conditions for it, which are in our email.',
          linkText: 'View the public announcement ↗',  // to app.announcement (https only)
          next: "Keep to the conditions in our email. If one isn't met, the committee can revoke Featured App status. We'll email you if anything about your status changes."
        },
        on_hold: {
          label: 'On hold', tone: 'warn',
          message: 'Review is paused while CIP-0116 is resolved. This page will update when review resumes.',
          next: "You don't need to do anything. Review picks up again once CIP-0116 is resolved."
        },
        // The board records no reason for the decision, so the page points
        // to the committee's email, which gives it. Under the next box: a
        // link to config.reapplyUrl and the contact line (faStatusAction).
        not_approved: {
          label: 'Not approved', tone: 'bad',
          message: 'The Featured App Committee did not approve this application. Our email explains why.',
          linkText: 'Apply again ↗',
          next: 'You can apply again after three months. If you substantially change your proposal, you can resubmit sooner, once the changed version is live on MainNet.'
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
        lockConfirmed: 'Confirmed',  // lock.confirmed, before a Lock Verified date is set
        lockAmount: '{amount}M CC locked',
        notStarted: 'Not started',
        inProgress: 'In progress',
        paused: 'Paused while CIP-0116 is resolved',
        approved: 'Approved',
        announced: 'Announced on the tokenomics mailing list',
        decided: 'Decided {date}',  // not approved: the date of the decision
        decision: 'Review ended',   // not approved, date unknown
        conditions: 'Conditions apply'  // provisional
      },
      provisionalFlag: 'Provisional',  // pill on the last step of a provisional app
      // Side card on featured apps: what the public list shows about them.
      publicCard: {
        heading: 'On the public list',
        text: 'Your app is on the public list of featured apps, with its name, Featured App type, status, the date it was featured, its Party ID and the announcement. Nothing else from your application is public.',
        revokedText: 'Your app is on the public list as revoked, with its name, Featured App type, the date its status was revoked, its Party ID and the announcement. Nothing else from your application is public.',
        link: 'View the public list'
      },
      // The final "stop" step when an application ended without, or lost,
      // Featured App status.
      outcomes: {
        not_approved: { title: 'Not approved', detail: 'Committee decision' },
        withdrawn: { title: 'Withdrawn', detail: '' },
        closed_process: { title: 'Closed', detail: 'Review process changed' },
        revoked: { title: 'Featured status revoked', detail: '' }
      },
      // The latest email from the committee (the Send Email column on Monday:
      // each label there sends one email). The label stays after the
      // applicant replies, so the wording says what the email asked, never
      // that something is still outstanding. `link: 'reapply'` adds a link to
      // config.reapplyUrl. Unknown kinds show nothing.
      update: {
        heading: 'Latest email from the committee',
        emailed: 'Emailed {date}',
        kinds: {
          office_hours: {
            title: 'Office hours invitation',
            text: "The Featured App Accountability Committee invited you to its office hours to discuss your app. If you haven't booked a time yet, use the link in our email."
          },
          endorsements: {
            title: 'Endorsements from your users',
            text: 'We explained how your users can endorse your request on the tokenomics mailing list. Endorsements show the committee your real user base.'
          },
          fa_type_info: {
            title: 'Information for Traffic-Based App Rewards',
            text: "We asked for your Featured App type and your App Operations PartyIDs. If you haven't sent them yet, use the form in our email."
          },
          locking_check: {
            title: 'Canton Coin lock check',
            text: "The locking party we have on file didn't hold the full balance. If you haven't replied yet, please answer our email so we can update your records."
          },
          resubmit: {
            title: 'Resubmission requested',
            text: "The review process changed, so we asked every applicant under review to resubmit with the new form. This isn't a decision on your application.",
            link: 'reapply',
            linkText: 'Apply under the current process ↗'
          },
          declined: {
            title: 'Application closed',
            text: "The committee found that the app isn't ready for approval yet. You can apply again after three months, or sooner with a substantially changed proposal once it's live on MainNet. Our email has the details."
          }
        }
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
      appCard: 'For Featured App',  // heading of the side card that links back to the application
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
          message: 'The Featured App Committee approved your request. The Tokenomics Committee is doing the final review.',
          next: 'Once the Tokenomics Committee approves, the final approval date appears on this page.'
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

  // History times, in the visitor's own time zone: "17 Nov 2026" and "12:35".
  const LOCAL_DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const LOCAL_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

  // A history timestamp from the backend: "2026-11-17T12:35:07Z".
  const HISTORY_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  // History entries shown before "Show N earlier changes".
  const HISTORY_VISIBLE = 6;

  // Locked Canton Coin in millions: 1.5 -> "1.5", 2 -> "2".
  const AMOUNT_FORMAT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });

  // FA states that ended before Featured App status: no testing tile, and a
  // timeline that stops early (withdrawn and closed right after "Application
  // received"; not approved after the committee's decision).
  const FA_ENDED_EARLY = ['not_approved', 'withdrawn', 'closed_process'];

  // FA states where Featured App status was granted (and possibly revoked
  // later). Their timeline leaves out lock and testing steps with no data.
  const FA_GRANTED = ['approved', 'provisional', 'revoked'];

  // FA states that hold Featured App status now: they are on the public list.
  const FA_FEATURED = ['approved', 'provisional'];

  // The route of the public list: "#featured".
  const FEATURED_ROUTE = 'featured';

  // FA states still moving through review, for the "in progress" chip on the list.
  const FA_ACTIVE = ['received', 'in_review', 'with_tokenomics', 'on_hold'];

  const DAY_MS = 86400000;

  // Stroke icons (24 x 24 viewBox), drawn with currentColor by the .icon class.
  const ICONS = {
    lock: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
    layers: ['m12 3 9 5-9 5-9-5 9-5z', 'm3 13 9 5 9-5'],
    mail: ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'm3 7 9 6 9-6'],
    arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
    copy: ['M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M5 15V5a2 2 0 0 1 2-2h10'],
    message: ['M4 5h16v11H8l-4 4V5z']
  };

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
   *   parseRoute('#featured')                       -> { kind: 'featured', code: null, appId: null, dvpId: null }
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
    if (value === FEATURED_ROUTE) return { kind: 'featured', code: null, appId: null, dvpId: null };
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
    const date = parseDay(value);
    return date ? DATE_FORMAT.format(date) : '';
  }

  /** An API date ("YYYY-MM-DD") as a Date at midnight UTC, or null if it isn't a real date. */
  function parseDay(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Reject dates that roll over (2026-02-31) and years below 100, which
    // Date.UTC would read as 19xx.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return null;
    }
    return date;
  }

  /**
   * How long ago an API date was, in words: "Today", "Yesterday",
   * "34 days ago", "3 months ago", "2 years ago". "" for a future or invalid
   * date. Counted in whole UTC days, like formatDate.
   */
  function agoText(value) {
    const date = parseDay(value);
    if (!date) return '';
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const days = Math.round((today - date.getTime()) / DAY_MS);
    const words = TEXT.ago;
    if (days < 0) return '';
    if (days === 0) return words.today;
    if (days === 1) return words.yesterday;
    if (days < 45) return fillText(words.days, { n: String(days) });
    if (days < 365) {
      const months = Math.max(1, Math.round(days / 30.44));
      return months === 1 ? words.month : fillText(words.months, { n: String(months) });
    }
    const years = Math.floor(days / 365.25);
    return years <= 1 ? words.year : fillText(words.years, { n: String(years) });
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

  /** A decorative stroke icon from ICONS (hidden from screen readers). */
  function icon(name, className) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    ICONS[name].forEach(function (d) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  /** The purple band at the top of a screen; `extra` adds classes. */
  function hero(children, extra) {
    return el('section', { class: 'hero' + (extra ? ' ' + extra : '') },
      el('div', { class: 'wrap hero-inner' + (extra ? ' ' + extra + '-inner' : '') }, children));
  }

  /** The screen's eyebrow, h1 (focus target) and intro line, inside the band. */
  function heroHead(eyebrow, heading, body) {
    return el('div', { class: 'd-head' }, [
      eyebrow ? el('p', { class: 'hero-eyebrow', text: eyebrow }) : null,
      el('h1', { class: 'p-h', tabindex: '-1', text: heading }),
      body ? el('p', { class: 'p-sub' }, body) : null
    ]);
  }

  /** Title block and status side by side in the band: pill plus "Step 5 of 6 · ...". */
  function heroTitle(head, words, state, steps) {
    const progress = progressText(steps);
    return el('div', { class: 'hero-title' }, [
      head,
      el('div', { class: 'hero-status' }, [
        pill(words.label, words.tone + ' big', state),
        progress ? el('p', { class: 'hero-progress', text: progress }) : null
      ])
    ]);
  }

  /** "Step 5 of 6 · Tokenomics Committee review", "All steps complete", or "" once a stop step is reached. */
  function progressText(steps) {
    if (steps.some(function (s) { return s.state === 'stop'; })) return '';
    let open = -1;
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i].state !== 'done') { open = i; break; }
    }
    if (open === -1) return TEXT.progress.allDone;
    return joinParts([
      fillText(TEXT.progress.step, { n: String(open + 1), total: String(steps.length) }),
      steps[open].title
    ]);
  }

  /** A row of segments, one per step, coloured by the step's state (decoration only). */
  function progressBar(states) {
    return el('span', { class: 'progress', 'aria-hidden': 'true' }, states.map(function (state) {
      return el('span', { class: 'seg ' + state });
    }));
  }

  /** The number tiles under the band; null when there are none. */
  function tilesRow(tiles) {
    const list = tiles.filter(Boolean);
    if (!list.length) return null;
    return el('div', { class: 'wrap overlap' }, el('dl', { class: 'tiles' }, list.map(function (t) {
      return el('div', { class: 'card tile' }, [
        el('dt', { class: 'tile-label', text: t.label }),
        el('dd', { class: 'tile-value', text: t.value }),
        t.sub ? el('dd', { class: 'tile-sub', text: t.sub }) : null
      ]);
    })));
  }

  /** A date tile: "34 days ago" over "14 Oct 2026" (just the date if it's in the future). */
  function dateTile(label, value) {
    const date = formatDate(value);
    if (!date) return null;
    const ago = agoText(value);
    return ago ? { label: label, value: ago, sub: date } : { label: label, value: date, sub: '' };
  }

  /** The main and side columns below the band. `overlap` when there are no tiles above. */
  function columns(mainChildren, sideChildren, overlap) {
    return el('div', { class: 'wrap cols' + (overlap ? ' overlap' : '') }, [
      el('div', { class: 'col-main' }, mainChildren),
      el('aside', { class: 'col-side' }, sideChildren)
    ]);
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

  /**
   * The status box: "Where things stand", the message, an optional extra
   * (link or contact line), "What happens next" when the state has one, an
   * optional action under it, and the last update. The pill itself sits in
   * the band (heroTitle).
   */
  function statusBox(words, extra, updated, action) {
    const lastUpdated = formatDate(updated);
    return el('section', { class: 'card status-box', 'data-section': 'status' }, [
      el('h2', { class: 'card-h', text: TEXT.statusHeading }),
      el('p', { class: 'status-message', text: words.message }),
      extra,
      words.next ? el('div', { class: 'next' }, [
        icon('arrow'),
        el('div', null, [
          el('p', { class: 'next-h', text: TEXT.nextHeading }),
          el('p', { class: 'next-text', text: words.next })
        ])
      ]) : null,
      action,
      lastUpdated ? el('p', { class: 'when', text: fillText(TEXT.lastUpdated, { date: lastUpdated }) }) : null
    ]);
  }

  /** "Questions? Contact the Featured App team at <email>." */
  function contactLine() {
    return el('p', { class: 'status-contact' }, fill(TEXT.contact, { email: emailLink() }));
  }

  /** A card below the band, with a stable data-section hook. */
  function section(key, heading, content) {
    return el('section', { class: 'card', 'data-section': key }, [
      el('h2', { class: 'card-h', text: heading }),
      content
    ]);
  }

  /** The note about sharing the link, at the bottom of the list. */
  function footerNote() {
    return el('p', { class: 'p-fine privacy-note', 'data-footnote': '' }, [
      icon('lock'),
      el('span', null, fill(TEXT.footer, { email: emailLink() }))
    ]);
  }

  /** The help box at the bottom of the side column, with the sharing note. */
  function helpCard(heading) {
    const email = textOf(CONFIG.supportEmail);
    return el('section', { class: 'card help', 'data-section': 'help' }, [
      el('h2', { class: 'help-h', text: heading }),
      el('p', { class: 'p-fine', text: TEXT.help.text }),
      EMAIL_PATTERN.test(email)
        ? el('a', { class: 'p-btn secondary help-btn', href: 'mailto:' + email, text: fillText(TEXT.help.button, { email: email }) })
        : null,
      el('p', { class: 'privacy', 'data-footnote': '' }, [icon('lock'), el('span', { text: TEXT.help.privateNote })])
    ]);
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

    // Not approved: "received", the lock if it was verified, the committee's
    // decision (with its date when known), then the outcome.
    if (state === 'not_approved') {
      const decided = decisionDate(app);
      steps.push(lockStep(app, true));
      steps.push(step('committee', 'done', titles.committee, decided ? fillText(details.decided, { date: decided }) : details.decision));
      steps.push(step('outcome', 'stop', TEXT.fa.outcomes.not_approved.title, TEXT.fa.outcomes.not_approved.detail));
      return steps.filter(Boolean);
    }

    // Withdrawn or closed: "received", then how it ended. Nothing else.
    if (FA_ENDED_EARLY.indexOf(state) !== -1) {
      const outcome = TEXT.fa.outcomes[state];
      steps.push(step('outcome', 'stop', outcome.title, outcome.detail));
      return steps;
    }

    const granted = FA_GRANTED.indexOf(state) !== -1;

    // Canton Coin lock. Granted apps with no verification date simply don't show the step.
    const lock = lockStep(app, granted);
    if (lock) steps.push(lock);

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
      // with_tokenomics, approved, provisional, revoked: the committee approved it.
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

    // Featured App status granted (announced on the tokenomics mailing list),
    // or granted with conditions: flagged "Provisional".
    if (state === 'provisional') {
      steps.push(step('granted', 'done', titles.granted, details.conditions, { label: TEXT.fa.provisionalFlag, tone: 'warn' }));
    } else {
      steps.push(step('granted', granted ? 'done' : 'todo', titles.granted, details.announced));
    }

    // Revoked later: one more "stop" step.
    if (state === 'revoked') {
      steps.push(step('outcome', 'stop', TEXT.fa.outcomes.revoked.title, TEXT.fa.outcomes.revoked.detail));
    }
    return steps;
  }

  /**
   * The Canton Coin lock step: done once verified (date, plus the amount if
   * known), or once the FA Status says the lock is in place (lock.confirmed).
   * Otherwise "not verified yet", or null when `optional` (granted or
   * decided applications don't show a lock step without data).
   */
  function lockStep(app, optional) {
    const details = TEXT.fa.details;
    const lock = isObject(app.lock) ? app.lock : {};
    const amount = formatAmount(lock.amountMillions);
    if (textOf(lock.verified) !== '' || lock.confirmed === true) {
      return step('lock', 'done', TEXT.fa.steps.lock, joinParts([
        formatDate(lock.verified) || details.lockConfirmed,
        amount ? fillText(details.lockAmount, { amount: amount }) : ''
      ]));
    }
    return optional ? null : step('lock', 'todo', TEXT.fa.steps.lock, details.lockNotVerified);
  }

  /**
   * When the committee decided not to approve, as "12 Nov 2026": the latest
   * change to "Not approved" in the history, or else the date of the
   * committee's decline email. "" when neither is known.
   */
  function decisionDate(app) {
    let latest = '';
    (Array.isArray(app.history) ? app.history : []).filter(isObject).forEach(function (e) {
      const at = textOf(e.at);
      if (e.kind === 'status' && textOf(e.to) === 'not_approved' && HISTORY_AT_PATTERN.test(at) && at > latest) latest = at;
    });
    const time = latest ? historyTime(latest) : null;
    if (time) return time.day;
    const email = latestEmail(app);
    return email && email.kind === 'declined' ? email.date : '';
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
    main.className = 'p-main';
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

  /** A heading and one paragraph (the top of the error screen). */
  function messageHead(heading, body) {
    return el('div', { class: 'd-head' }, [
      el('h1', { class: 'p-h', tabindex: '-1', text: heading }),
      el('p', { class: 'p-sub' }, body)
    ]);
  }

  // ---- Start, sent and invalid: the band with the form, then what the page is

  /**
   * The layout shared by the start, sent and invalid screens: the band with
   * `heroMain` and the example card, then the promises, how review works,
   * the statuses and the FAQ.
   */
  function startLayout(screen, heroMain) {
    const publicLink = el('a', { class: 'hero-link', href: '#' + FEATURED_ROUTE, text: TEXT.start.publicLink });
    show(screen, null, [
      hero([el('div', { class: 'hero-main' }, heroMain.concat(publicLink)), exampleCard()], 'hero-start'),
      promisesSection(),
      howSection(),
      statusesSection(),
      faqSection()
    ]);
  }

  /** The start page: what this is, and the email form. */
  function showStart(prefill) {
    startLayout('start', [
      heroHead(TEXT.start.eyebrow, TEXT.start.heading, TEXT.start.body),
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
    startLayout('sent', [
      heroHead(TEXT.start.eyebrow, TEXT.sent.heading,
        fill(TEXT.sent.body, { address: el('strong', { class: 'address', text: address }) })),
      el('p', { class: 'p-fine' }, fill(TEXT.sent.noEmail, { email: emailLink() })),
      again
    ]);
  }

  /** A link that doesn't work: say so, and offer the email form. */
  function showInvalid() {
    startLayout('invalid', [
      heroHead(TEXT.start.eyebrow, TEXT.invalid.heading, TEXT.invalid.body),
      emailForm(''),
      el('p', { class: 'p-fine' }, fill(TEXT.start.fine, { email: emailLink() }))
    ]);
  }

  /** The sample status card next to the form. Decoration: hidden from screen readers. */
  function exampleCard() {
    const x = TEXT.about.example;
    return el('div', { class: 'example', 'aria-hidden': 'true' }, [
      el('div', { class: 'example-top' }, [
        el('span', { class: 'eyebrow', text: x.eyebrow }),
        el('span', { class: 'example-tag', text: x.tag })
      ]),
      el('p', { class: 'example-name', text: x.name }),
      el('p', { class: 'example-meta', text: x.meta }),
      pill(x.pill, 'info'),
      progressBar(['done', 'done', 'done', 'current', 'todo', 'todo']),
      el('p', { class: 'example-step' }, [el('strong', { text: x.step }), TEXT.separator + x.stepName]),
      el('div', { class: 'example-email' }, [
        icon('mail'),
        el('div', null, [
          el('p', { class: 'example-email-label', text: x.email }),
          el('p', { class: 'example-email-title', text: x.emailTitle })
        ])
      ])
    ]);
  }

  /** Eyebrow, h2 and an optional intro, at the top of a start-page section. */
  function infoHead(words, intro) {
    return el('div', { class: 'info-head' }, [
      el('p', { class: 'eyebrow', text: words.eyebrow }),
      el('h2', { class: 'info-h', text: words.heading }),
      intro ? el('p', { class: 'p-sub' }, intro) : null
    ]);
  }

  /** Three cards on the edge of the band: private, current, complete. */
  function promisesSection() {
    return el('section', { class: 'wrap overlap', 'aria-label': TEXT.about.promisesLabel },
      el('ul', { class: 'promises' }, TEXT.about.promises.map(function (p) {
        return el('li', { class: 'card promise' }, [
          icon(p.icon),
          el('p', { class: 'promise-title', text: p.title }),
          el('p', { class: 'p-fine', text: p.text })
        ]);
      })));
  }

  /** "How review works": the six timeline steps, explained. */
  function howSection() {
    const how = TEXT.about.how;
    return el('section', { class: 'wrap info-section', 'data-section': 'how' }, [
      infoHead(how, how.intro),
      el('ol', { class: 'how-steps' }, how.steps.map(function (s, i) {
        return el('li', { class: 'card how-step' }, [
          el('span', { class: 'how-n', text: (i < 9 ? '0' : '') + (i + 1) }),
          el('span', { class: 'how-title', text: TEXT.fa.steps[s.key] }),
          el('span', { class: 'p-fine', text: s.text })
        ]);
      }))
    ]);
  }

  /** "What each status means": every FA state's pill and message. */
  function statusesSection() {
    const states = TEXT.fa.states;
    return el('section', { class: 'wrap info-section', 'data-section': 'statuses' }, [
      infoHead(TEXT.about.statuses),
      el('ul', { class: 'card glossary' }, Object.keys(states).map(function (key) {
        return el('li', null, [pill(states[key].label, states[key].tone), el('p', { class: 'p-fine', text: states[key].message })]);
      }))
    ]);
  }

  /** The FAQ, as native <details> (no script needed to open them). */
  function faqSection() {
    const faq = TEXT.about.faq;
    return el('section', { class: 'wrap info-section faq', 'data-section': 'faq' }, [
      infoHead(faq, fill(faq.intro, { email: emailLink() })),
      el('div', { class: 'faq-list' }, faq.items.map(function (item) {
        return el('details', null, [
          el('summary', null, el('span', { class: 'faq-q', text: item.q })),
          el('p', { class: 'faq-a' }, fill(item.a, { email: emailLink() }))
        ]);
      }))
    ]);
  }

  // ---- Screens without application data

  /** The error screen with "Try again". `words` ({heading, body}) defaults to TEXT.error. */
  function showError(words) {
    const w = words || TEXT.error;
    const retry = el('button', { class: 'p-btn', type: 'button', 'data-action': 'retry', text: TEXT.error.retry });
    retry.addEventListener('click', retryRequest);
    show('error', null, el('div', { class: 'p-body p-narrow' }, [
      messageHead(w.heading, fill(w.body, { email: emailLink() })),
      retry
    ]));
  }

  /** The loading screen. `text` defaults to TEXT.loading. */
  function showLoading(text) {
    show('loading', null, el('div', { class: 'p-body p-narrow' }, el('div', { class: 'loading', role: 'status' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', { text: text || TEXT.loading })
    ])));
  }

  // ---- The list of applications

  /** Several applications: count chips in the band, then one card each, newest first (the backend's order). */
  function showList(code, apps) {
    const counts = { active: 0, approved: 0, ended: 0 };
    const cards = apps.map(function (app) {
      const state = normalizeState(app.state, TEXT.fa.states, 'in_review');
      const words = TEXT.fa.states[state];
      if (FA_ACTIVE.indexOf(state) !== -1) counts.active += 1;
      else if (FA_FEATURED.indexOf(state) !== -1) counts.approved += 1;
      else counts.ended += 1;

      const steps = faSteps(app, state);
      const progress = progressText(steps);
      const updated = formatDate(app.updated);
      const count = dvpOf(app).length;
      const meta = joinParts([
        textOf(app.institution),
        submittedText(app.submitted),
        count === 1 ? TEXT.list.dvpOne : count > 1 ? fillText(TEXT.list.dvpMany, { count: String(count) }) : ''
      ]);
      const email = latestEmail(app);
      // The spaces keep the card's text (and so the link's accessible name) readable.
      const content = [
        el('span', { class: 'app-top' }, [
          el('span', { class: 'app-name', text: textOf(app.name) || TEXT.fa.untitled }),
          ' ',
          pill(words.label, words.tone, state)
        ]),
        meta ? [' ', el('span', { class: 'app-meta', text: meta })] : null,
        ' ',
        el('span', { class: 'app-progress' }, [
          progressBar(steps.map(function (s) { return s.state; })),
          el('span', { class: 'app-progress-text' }, [
            progress ? el('span', { class: 'app-step', text: progress }) : null,
            ' ',
            updated ? el('span', { text: fillText(TEXT.lastUpdated, { date: updated }) }) : null
          ])
        ]),
        email ? [' ', el('span', { class: 'app-email' }, [
          icon('mail'),
          el('span', { text: joinParts([fillText(TEXT.list.email, { title: email.words.title }), email.date]) })
        ])] : null
      ];
      const id = idOf(app);
      const card = id
        ? el('a', { class: 'app app-lg', href: '#' + code + '/app-' + id, 'data-app-id': id }, content)
        : el('div', { class: 'app app-lg' }, content);
      return el('li', null, card);
    });

    const dvpTotal = apps.reduce(function (sum, app) { return sum + dvpOf(app).length; }, 0);
    const chipWords = TEXT.list.chips;
    const chips = [
      apps.length === 1 ? chipWords.appsOne : fillText(chipWords.appsMany, { count: String(apps.length) }),
      counts.active ? fillText(chipWords.active, { count: String(counts.active) }) : '',
      counts.approved ? fillText(chipWords.approved, { count: String(counts.approved) }) : '',
      counts.ended ? fillText(chipWords.ended, { count: String(counts.ended) }) : '',
      dvpTotal === 1 ? TEXT.list.dvpOne : dvpTotal > 1 ? fillText(TEXT.list.dvpMany, { count: String(dvpTotal) }) : ''
    ].filter(Boolean);

    show('list', TEXT.list.heading, [
      hero([
        heroHead(TEXT.list.eyebrow, TEXT.list.heading, TEXT.list.intro),
        el('ul', { class: 'chips' }, chips.map(function (text) { return el('li', { class: 'chip', text: text }); }))
      ]),
      el('div', { class: 'wrap overlap list-body' }, [
        el('ul', { class: 'app-list' }, cards),
        footerNote()
      ])
    ]);
  }

  // ---- The application page

  /** The application page. With several applications, a link leads back to the list. */
  function showApp(code, apps, app) {
    const state = normalizeState(app.state, TEXT.fa.states, 'in_review');
    const words = TEXT.fa.states[state];
    const name = textOf(app.name) || TEXT.fa.untitled;
    const steps = faSteps(app, state);
    const tiles = tilesRow(faTiles(app, state));

    show('app', name, [
      hero([
        apps.length > 1 ? el('a', { class: 'back', href: '#' + code, text: TEXT.list.back }) : null,
        heroTitle(pageHead(TEXT.fa.eyebrow, name, joinParts([
          textOf(app.institution),
          textOf(app.type),
          submittedText(app.submitted)
        ])), words, state, steps),
        timeline(TEXT.fa.progressLabel, steps)
      ]),
      tiles,
      columns([
        statusBox(words, faStatusExtra(app, state, words), app.updated, faStatusAction(state, words)),
        updateSection(app),
        historySection(app, words)
      ], [
        onFileSection(app),
        FA_GRANTED.indexOf(state) !== -1 ? publicListCard(state) : null,
        dvpListSection(code, apps, app),
        helpCard(state === 'not_approved' ? TEXT.help.decision : TEXT.help.app)
      ], !tiles)
    ]);
  }

  /** "On the public list": what everyone can see about a featured (or revoked) app, with a link to the list. */
  function publicListCard(state) {
    const words = TEXT.fa.publicCard;
    return section('public', words.heading, [
      el('p', { class: 'p-fine', text: state === 'revoked' ? words.revokedText : words.text }),
      el('a', { class: 'card-link', href: '#' + FEATURED_ROUTE, text: words.link })
    ]);
  }

  /** The application's number tiles: submitted, Canton Coin locked, testing, last updated. */
  function faTiles(app, state) {
    const t = TEXT.tiles;
    const ended = FA_ENDED_EARLY.indexOf(state) !== -1;
    const granted = FA_GRANTED.indexOf(state) !== -1;
    const tiles = [dateTile(t.submitted, app.submitted)];

    // Canton Coin lock: the amount when known, else "Verified" or "Not verified yet".
    const lock = isObject(app.lock) ? app.lock : {};
    const amount = formatAmount(lock.amountMillions);
    const verified = formatDate(lock.verified);
    if (amount) {
      tiles.push({ label: t.locked, value: fillText(t.lockAmount, { amount: amount }), sub: verified ? fillText(t.lockVerified, { date: verified }) : '' });
    } else if (verified) {
      tiles.push({ label: t.locked, value: t.verified, sub: verified });
    } else if (lock.confirmed === true) {
      tiles.push({ label: t.locked, value: t.confirmed, sub: '' });
    } else if (!ended && !granted) {
      tiles.push({ label: t.locked, value: t.notVerified, sub: '' });
    }

    // Testing, while the application is still in review (as on the timeline).
    const testing = normalizeTesting(app.testing);
    if (!ended && !(granted && testing === 'not_started')) {
      const testingWords = TEXT.fa.testing[testing];
      tiles.push({ label: t.testing, value: testingWords.flag || testingWords.detail, sub: testingWords.flag ? testingWords.detail : '' });
    }

    tiles.push(dateTile(t.lastUpdated, app.updated));
    return tiles;
  }

  /** What goes under the FA status message: a link or the contact line, or nothing. */
  function faStatusExtra(app, state, words) {
    if (FA_FEATURED.indexOf(state) !== -1) {
      const announcement = parseHttpsUrl(app.announcement);
      return announcement ? externalLink(announcement, words.linkText, 'status-action') : null;
    }
    if (state === 'closed_process') {
      const reapply = parseHttpsUrl(CONFIG.reapplyUrl);
      return reapply ? externalLink(reapply, words.linkText, 'status-action p-btn') : null;
    }
    return words.contact ? contactLine() : null;
  }

  /** What goes under "What happens next": for a declined application, "Apply again" and the contact line. */
  function faStatusAction(state, words) {
    if (state !== 'not_approved') return null;
    const reapply = parseHttpsUrl(CONFIG.reapplyUrl);
    return [reapply ? externalLink(reapply, words.linkText, 'status-action p-btn') : null, contactLine()];
  }

  /** The latest committee email (app.update) as { kind, words, date, iso }, or null when there is none or its kind is unknown. */
  function latestEmail(app) {
    const update = isObject(app.update) ? app.update : null;
    const kind = update ? textOf(update.kind) : '';
    if (!kind || !hasOwn(TEXT.fa.update.kinds, kind)) return null;
    return { kind: kind, words: TEXT.fa.update.kinds[kind], date: formatDate(update.date), iso: textOf(update.date) };
  }

  /** "Latest email from the committee"; null when there is none. */
  function updateSection(app) {
    const email = latestEmail(app);
    if (!email) return null;
    const words = email.words;
    const link = words.link === 'reapply' ? parseHttpsUrl(CONFIG.reapplyUrl) : null;
    return el('section', { class: 'card p-update', 'data-update': email.kind, 'aria-label': TEXT.fa.update.heading }, [
      el('span', { class: 'card-icon' }, icon('mail')),
      el('div', { class: 'update-body' }, [
        el('h2', { class: 'card-h', text: TEXT.fa.update.heading }),
        el('p', { class: 'update-title', text: words.title }),
        el('p', { text: words.text }),
        link ? externalLink(link, words.linkText, 'status-action') : null,
        email.date ? el('p', { class: 'when', text: fillText(TEXT.fa.update.emailed, { date: email.date }) }) : null
      ])
    ]);
  }

  /**
   * The application's dated events, newest first: the committee's latest
   * email, the last record change, DVP requests submitted and approved, the
   * lock verification, and the submission. Events without a date are left out.
   */
  function faActivity(app, words) {
    const a = TEXT.activity;
    const events = [];
    function add(value, title, detail) {
      const date = formatDate(value);
      if (date) events.push({ iso: value.trim(), date: date, title: title, detail: detail || '' });
    }
    const email = latestEmail(app);
    if (email) add(email.iso, a.emailed, email.words.title);
    add(textOf(app.updated), a.recordUpdated, fillText(a.status, { status: words.label }));
    dvpOf(app).forEach(function (request) {
      const name = textOf(request.name) || TEXT.dvp.untitled;
      add(textOf(request.finalApproval), a.dvpApproved, name);
      add(textOf(request.submitted), a.dvpSubmitted, name);
    });
    const lock = isObject(app.lock) ? app.lock : {};
    const amount = formatAmount(lock.amountMillions);
    add(textOf(lock.verified), a.lockVerified, amount ? fillText(TEXT.fa.details.lockAmount, { amount: amount }) : '');
    add(textOf(app.submitted), a.submitted, '');
    // Newest first; Array.prototype.sort is stable, so same-day events keep the order above.
    return events.sort(function (x, y) { return x.iso < y.iso ? 1 : x.iso > y.iso ? -1 : 0; });
  }

  /** "Activity"; null with fewer than two events (one would only repeat the submission date). */
  function activitySection(events) {
    if (events.length < 2) return null;
    return section('activity', TEXT.activity.heading, el('ol', { class: 'activity' }, events.map(function (e) {
      return el('li', null, [
        el('time', { class: 'activity-date', datetime: e.iso, text: e.date }),
        el('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'activity-body' }, [
          el('span', { class: 'activity-title', text: e.title }),
          e.detail ? el('span', { class: 'activity-detail', text: e.detail }) : null
        ])
      ]);
    })));
  }

  /**
   * The application's history: every change the backend read from Monday's
   * activity log (app.history), plus the submission dates. Falls back to
   * "Activity" (dates only) when the backend sends no history.
   */
  function historySection(app, words) {
    if (!Array.isArray(app.history)) return activitySection(faActivity(app, words));
    const h = TEXT.history;
    const requests = dvpOf(app);
    const nameOf = function (id) {
      for (let i = 0; i < requests.length; i += 1) {
        if (idOf(requests[i]) === id) return textOf(requests[i].name) || TEXT.dvp.untitled;
      }
      return TEXT.dvp.untitled;
    };
    const events = [];
    app.history.filter(isObject).forEach(function (e) {
      const to = textOf(e.to);
      let entry = null;
      if (e.kind === 'status' && hasOwn(h.status, to)) {
        const state = to === 'in_review_locked' ? 'in_review' : to;
        const label = hasOwn(TEXT.fa.states, state) ? TEXT.fa.states[state].label : '';
        entry = { title: h.status[to], detail: label ? fillText(h.statusDetail, { status: label }) : '' };
      } else if (e.kind === 'testing' && hasOwn(h.testing, to)) {
        entry = { title: h.testing[to], detail: '' };
      } else if (e.kind === 'lock_verified') {
        entry = { title: h.lockVerified, detail: formatDate(e.date) };
      } else if (e.kind === 'lock_amount' && formatAmount(e.amount)) {
        entry = { title: h.lockAmount, detail: fillText(TEXT.tiles.lockAmount, { amount: formatAmount(e.amount) }) };
      } else if (e.kind === 'email' && hasOwn(TEXT.fa.update.kinds, to)) {
        entry = { title: h.email, detail: TEXT.fa.update.kinds[to].title };
      } else if (e.kind === 'fa_type' && textOf(e.text)) {
        entry = { title: h.faType, detail: textOf(e.text) };
      } else if (e.kind === 'dvp_status' && hasOwn(TEXT.fa.dvpStatus.states, to)) {
        entry = { title: h.dvpStatus, detail: TEXT.fa.dvpStatus.states[to].label };
      } else if (e.kind === 'dvp_state' && hasOwn(TEXT.dvp.states, to)) {
        entry = { title: h.dvpRequest, detail: joinParts([nameOf(textOf(e.request)), TEXT.dvp.states[to].label]) };
      }
      const at = historyTime(e.at);
      if (entry && at) events.push(Object.assign(entry, at));
    });
    // Dates that aren't in the activity log: the submission and each DVP request's.
    const submitted = historyDay(app.submitted);
    if (submitted) events.push(Object.assign({ title: h.submitted, detail: '' }, submitted));
    requests.forEach(function (request) {
      const day = historyDay(request.submitted);
      if (day) events.push(Object.assign({ title: h.dvpSubmitted, detail: textOf(request.name) || TEXT.dvp.untitled }, day));
    });
    return events.length ? section('history', h.heading, historyList(events)) : null;
  }

  /** A DVP request's history (its Status changes, received, final approval); null without app.history. */
  function dvpHistorySection(app, request) {
    if (!Array.isArray(app.history)) return null;
    const h = TEXT.history;
    const id = idOf(request);
    const events = [];
    app.history.filter(isObject).forEach(function (e) {
      const to = textOf(e.to);
      if (e.kind !== 'dvp_state' || textOf(e.request) !== id || !hasOwn(h.dvpState, to)) return;
      const at = historyTime(e.at);
      if (at) events.push(Object.assign({ title: h.dvpState[to], detail: fillText(h.statusDetail, { status: TEXT.dvp.states[to].label }) }, at));
    });
    const received = historyDay(request.submitted);
    if (received) events.push(Object.assign({ title: h.dvpReceived, detail: '' }, received));
    const approved = historyDay(request.finalApproval);
    if (approved) events.push(Object.assign({ title: h.finalApproval, detail: '' }, approved));
    return events.length > 1 ? section('history', h.heading, historyList(events)) : null;
  }

  /** A logged change's time: { sort, iso, day, time } in the visitor's time zone, or null. */
  function historyTime(value) {
    const at = typeof value === 'string' ? value.trim() : '';
    if (!HISTORY_AT_PATTERN.test(at)) return null;
    const date = new Date(at);
    if (isNaN(date.getTime())) return null;
    return { sort: at, iso: at, day: LOCAL_DAY_FORMAT.format(date), time: LOCAL_TIME_FORMAT.format(date) };
  }

  /** A date-only entry (submission, final approval): { sort, iso, day, time: '' }, or null. */
  function historyDay(value) {
    const day = formatDate(value);
    return day ? { sort: value.trim() + 'T00:00:00Z', iso: value.trim(), day: day, time: '' } : null;
  }

  /** History entries newest first; the first HISTORY_VISIBLE shown, the rest behind "Show N earlier changes". */
  function historyList(events) {
    events.sort(function (a, b) { return a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0; });
    const item = function (e) {
      return el('li', null, [
        el('span', { class: 'activity-when' }, [
          el('time', { class: 'activity-date', datetime: e.iso, text: e.day }),
          e.time ? el('span', { class: 'activity-time', text: e.time }) : null
        ]),
        el('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'activity-body' }, [
          el('span', { class: 'activity-title', text: e.title }),
          e.detail ? el('span', { class: 'activity-detail', text: e.detail }) : null
        ])
      ]);
    };
    const shown = events.slice(0, HISTORY_VISIBLE);
    const rest = events.slice(HISTORY_VISIBLE);
    return [
      el('ol', { class: 'activity' }, shown.map(item)),
      rest.length ? el('details', { class: 'history-more' }, [
        el('summary', { text: rest.length === 1 ? TEXT.history.moreOne : fillText(TEXT.history.more, { count: String(rest.length) }) }),
        el('ol', { class: 'activity' }, rest.map(item))
      ]) : null
    ];
  }

  /** "On file": Featured App type, issuer type, Party ID (with a copy button) and product site; null when all are missing. */
  function onFileSection(app) {
    const rows = [];
    function row(label, value) {
      rows.push(el('div', { class: 'kv-row' }, [el('dt', { text: label }), value]));
    }
    const faType = textOf(app.faType);
    if (faType) row(TEXT.fa.faType, el('dd', { 'data-field': 'fa-type', text: faType }));
    const type = textOf(app.type);
    if (type) row(TEXT.fa.issuerType, el('dd', { 'data-field': 'type', text: type }));
    const partyId = textOf(app.partyId);
    if (partyId) {
      row(TEXT.fa.partyId, el('dd', { class: 'party' }, [
        el('span', { class: 'mono party-id', 'data-field': 'party-id', text: partyId }),
        copyButton(partyId)
      ]));
    }
    const website = parseHttpsUrl(app.website);
    if (website) row(TEXT.fa.productSite, el('dd', { 'data-field': 'website' }, externalLink(website, displayUrl(website) + ' ↗', 'url-text')));
    return rows.length ? section('on-file', TEXT.fa.onFile, el('dl', { class: 'kv' }, rows)) : null;
  }

  /**
   * A copy button ("Copy Party ID" unless `words.label` says otherwise), only
   * where the browser allows writing to the clipboard. `words.name` is an
   * accessible name for buttons that repeat down a list.
   */
  function copyButton(text, words) {
    if (!window.isSecureContext || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return null;
    const idle = words && words.label ? words.label : TEXT.fa.copy;
    const label = el('span', { text: idle });
    const button = el('button', {
      class: 'copy', type: 'button', 'data-action': 'copy', 'aria-label': words && words.name ? words.name : null
    }, [icon('copy'), label]);
    let timer = 0;
    button.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () {
        label.textContent = TEXT.fa.copied;
        window.clearTimeout(timer);
        timer = window.setTimeout(function () { label.textContent = idle; }, 2000);
      }, function () {
        // Clipboard refused (permissions): the ID stays selectable on the page.
      });
    });
    return button;
  }

  /** The app's DVP status (from the FA board), as a line with a pill; null for an empty or unknown value. */
  function dvpStatusLine(app) {
    const statusKey = textOf(app.dvpStatus);
    if (!hasOwn(TEXT.fa.dvpStatus.states, statusKey)) return null;
    const status = TEXT.fa.dvpStatus.states[statusKey];
    return el('p', { class: 'dvp-status', 'data-dvp-status': statusKey }, [
      el('span', { class: 'dvp-status-label', text: TEXT.fa.dvpStatus.label }),
      ' ',
      pill(status.label, status.tone, statusKey)
    ]);
  }

  /**
   * "DVP": the app's DVP status (from the FA board), then one card per DVP
   * request (from the DVP board); null when there is neither.
   */
  function dvpListSection(code, apps, app) {
    const requests = dvpOf(app);
    const statusLine = dvpStatusLine(app);
    if (requests.length === 0 && !statusLine) return null;
    if (requests.length === 0) return section('dvp', TEXT.fa.dvpHeading, statusLine);

    const cards = requests.map(function (request) {
      const state = normalizeState(request.state, TEXT.dvp.states, 'in_review');
      const words = TEXT.dvp.states[state];
      const ref = textOf(request.requestRef).replace(/^#/, '');
      const meta = joinParts([submittedText(request.submitted), ref ? fillText(TEXT.dvp.ref, { ref: ref }) : '']);
      // The spaces between the parts keep the card's text (and so the
      // link's accessible name) readable.
      const content = [
        el('span', { class: 'app-name', text: textOf(request.name) || TEXT.dvp.untitled }),
        ' ',
        pill(words.label, words.tone, state),
        progressBar(dvpSteps(request, state).map(function (s) { return s.state; })),
        meta ? [' ', el('span', { class: 'app-meta', text: meta })] : null
      ];
      // A card links to the request's page when the request has a usable id.
      const id = idOf(request);
      const card = id
        ? el('a', { class: 'app app-sm', href: dvpHref(code, apps, app, request), 'data-dvp-id': id }, content)
        : el('div', { class: 'app app-sm' }, content);
      return el('li', null, card);
    });
    return section('dvp', TEXT.fa.dvpHeading, [statusLine, el('ul', { class: 'app-list' }, cards)]);
  }

  // ---- The DVP request page

  /** A DVP request's page. */
  function showDvp(code, apps, app, request) {
    const appName = textOf(app.name) || TEXT.fa.untitled;
    const appLink = appHref(code, apps, app);
    const state = normalizeState(request.state, TEXT.dvp.states, 'in_review');
    const words = TEXT.dvp.states[state];
    const name = textOf(request.name) || TEXT.dvp.untitled;
    const steps = dvpSteps(request, state);

    const ref = textOf(request.requestRef).replace(/^#/, '');
    const eyebrow = ref
      ? TEXT.dvp.eyebrow + TEXT.separator + fillText(TEXT.dvp.ref, { ref: ref })
      : TEXT.dvp.eyebrow;

    // "For Featured App <app name> · Submitted <date>", the app name linking back.
    const meta = fill(TEXT.dvp.forApp, { name: el('a', { href: appLink, text: appName }) });
    const submitted = submittedText(request.submitted);
    if (submitted) meta.push(TEXT.separator, submitted);

    const ended = state === 'not_approved' || state === 'closed';
    const finalApproval = formatDate(request.finalApproval);
    const tiles = tilesRow([
      dateTile(TEXT.tiles.submitted, request.submitted),
      finalApproval
        ? { label: TEXT.tiles.finalApproval, value: finalApproval, sub: '' }
        : ended ? null : { label: TEXT.tiles.finalApproval, value: TEXT.tiles.notYet, sub: '' },
      dateTile(TEXT.tiles.lastUpdated, request.updated)
    ]);

    show('dvp', name, [
      hero([
        el('a', {
          class: 'back',
          href: appLink,
          'aria-label': fillText(TEXT.dvp.backLabel, { name: appName }),
          text: fillText(TEXT.dvp.back, { name: appName })
        }),
        heroTitle(pageHead(eyebrow, name, meta), words, state, steps),
        timeline(TEXT.dvp.progressLabel, steps)
      ]),
      tiles,
      columns([
        statusBox(words, words.contact ? contactLine() : null, request.updated),
        dvpHistorySection(app, request),
        publicRecordSection(request.requestUrl)
      ], [
        appCard(app, appLink),
        helpCard(TEXT.help.dvp)
      ], !tiles)
    ]);
  }

  /** "For Featured App": a card back to the application, with its status and DVP status. */
  function appCard(app, appLink) {
    const state = normalizeState(app.state, TEXT.fa.states, 'in_review');
    const words = TEXT.fa.states[state];
    const meta = joinParts([textOf(app.institution), submittedText(app.submitted)]);
    return section('for-app', TEXT.dvp.appCard, [
      el('a', { class: 'app app-sm', href: appLink }, [
        el('span', { class: 'app-name', text: textOf(app.name) || TEXT.fa.untitled }),
        ' ',
        pill(words.label, words.tone, state),
        meta ? [' ', el('span', { class: 'app-meta', text: meta })] : null
      ]),
      dvpStatusLine(app)
    ]);
  }

  /** "Public record": the request's post on the accountability list; null without an https URL. */
  function publicRecordSection(requestUrl) {
    const url = parseHttpsUrl(requestUrl);
    if (!url) return null;
    return el('section', { class: 'card p-update', 'data-section': 'record' }, [
      el('span', { class: 'card-icon' }, icon('message')),
      el('div', { class: 'update-body' }, [
        el('h2', { class: 'card-h', text: TEXT.dvp.publicRecord }),
        el('p', { text: TEXT.dvp.recordIntro }),
        externalLink(url, fillText(TEXT.dvp.recordLink, { url: displayUrl(url) }), 'url-text')
      ])
    ]);
  }

  // ---- The public list of featured apps

  /**
   * The public list (#featured): the numbers in the band, then search, type
   * filters and one row per app, then the revoked apps (when any), then how
   * to use the list in other tools. `list` is { updated, apps } from
   * readFeatured(); `apiUrl` is the web app. The search covers both lists.
   * Searching and filtering re-render the rows only, so focus stays put.
   */
  function showFeatured(list, apiUrl) {
    const w = TEXT.featured;
    const isRevoked = function (app) { return app.status === 'revoked'; };
    const apps = list.apps.filter(function (app) { return !isRevoked(app); });
    const revoked = list.apps.filter(isRevoked);
    const filters = featuredFilters(apps);
    const state = { filter: filters[0], query: '' };

    const rows = el('ul', { class: 'pub-list' });
    const revokedRows = el('ul', { class: 'pub-list' });
    const foot = el('p', { class: 'pub-foot', 'aria-live': 'polite' });
    const updated = historyTime(list.updated);
    function render() {
      const query = state.query.trim().toLowerCase();
      const matches = function (app) {
        if (!query) return true;
        return textOf(app.name).toLowerCase().indexOf(query) !== -1 ||
          partyIdsOf(app).some(function (id) { return id.toLowerCase().indexOf(query) !== -1; });
      };
      const shown = apps.filter(state.filter.test).filter(matches);
      rows.textContent = '';
      append(rows, shown.length ? shown.map(featuredRow) : el('li', { class: 'pub-empty', text: apps.length ? w.empty : w.none }));
      foot.textContent = joinParts([
        fillText(w.showing, { shown: String(shown.length), total: String(apps.length) }),
        updated ? fillText(w.updated, { day: updated.day, time: updated.time }) : ''
      ]);
      const shownRevoked = revoked.filter(matches);
      revokedRows.textContent = '';
      append(revokedRows, shownRevoked.length ? shownRevoked.map(featuredRow) : el('li', { class: 'pub-empty', text: w.revoked.empty }));
    }

    const search = el('input', {
      id: 'pub-search', class: 'pub-input', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: w.searchPlaceholder
    });
    search.addEventListener('input', function () { state.query = search.value; render(); });

    const chips = filters.map(function (f) {
      const button = el('button', { class: 'filter', type: 'button', 'aria-pressed': String(f === state.filter), 'data-filter': f.key }, [
        f.label, ' ', el('span', { class: 'filter-count', text: String(f.count) })
      ]);
      button.addEventListener('click', function () {
        state.filter = f;
        chips.forEach(function (chip) { chip.setAttribute('aria-pressed', String(chip === button)); });
        render();
      });
      return button;
    });

    const feedUrl = apiUrl + (apiUrl.indexOf('?') === -1 ? '?' : '&') + 'view=featured';
    const feedLink = parseHttpsUrl(feedUrl);
    const csvLink = parseHttpsUrl(feedUrl + '&format=csv');
    const provisional = apps.filter(function (app) { return app.status === 'provisional'; }).length;
    const assetMoving = apps.filter(function (app) { return textOf(app.type) === w.assetMovingType; }).length;
    const stats = [
      { label: w.stats.total, value: apps.length },
      { label: w.stats.assetMoving, value: assetMoving },
      provisional ? { label: w.stats.provisional, value: provisional, warn: true } : null
    ].filter(Boolean);

    show('featured', w.title, [
      hero([
        el('a', { class: 'back', href: '#', text: w.back }),
        el('div', { class: 'pub-hero' }, [
          heroHead(w.eyebrow, w.heading, w.intro),
          el('dl', { class: 'pub-stats' }, stats.map(function (s) {
            return el('div', { class: 'pub-stat' + (s.warn ? ' warn' : '') }, [
              el('dt', { text: s.label }),
              el('dd', { text: String(s.value) })
            ]);
          }))
        ])
      ]),
      el('div', { class: 'wrap overlap' }, el('section', { class: 'card pub-card', 'data-section': 'featured', 'aria-label': w.heading }, [
        el('div', { class: 'pub-tools' }, [
          el('div', { class: 'pub-search' }, [el('label', { for: 'pub-search', text: w.searchLabel }), search]),
          el('div', { class: 'pub-actions' }, [
            csvLink ? externalLink(csvLink, w.csv, 'p-btn secondary') : null,
            feedLink ? externalLink(feedLink, w.json, 'p-btn secondary') : null
          ])
        ]),
        el('div', { class: 'filters', role: 'group', 'aria-label': w.filtersLabel }, chips),
        el('div', { class: 'pub-head', 'aria-hidden': 'true' }, [
          el('span', { text: w.columns.app }), el('span', { text: w.columns.type }), el('span', { text: w.columns.status }),
          el('span', { text: w.columns.since }), el('span', { text: w.columns.record })
        ]),
        rows,
        foot
      ])),
      revoked.length ? el('div', { class: 'wrap pub-gap' }, el('section', { class: 'card pub-card', 'data-section': 'revoked', 'aria-labelledby': 'pub-revoked-h' }, [
        el('h2', { class: 'card-h', id: 'pub-revoked-h' }, [w.revoked.heading, ' ', el('span', { class: 'filter-count', text: String(revoked.length) })]),
        el('p', { class: 'p-fine', text: w.revoked.intro }),
        el('div', { class: 'pub-head', 'aria-hidden': 'true' }, [
          el('span', { text: w.columns.app }), el('span', { text: w.columns.type }), el('span', { text: w.columns.status }),
          el('span', { text: w.columns.revokedOn }), el('span', { text: w.columns.record })
        ]),
        revokedRows
      ])) : null,
      el('div', { class: 'wrap pub-more' }, [
        feedLink ? el('section', { class: 'card pub-feed', 'data-section': 'feed' }, [
          el('h2', { class: 'card-h', text: w.feed.heading }),
          el('p', { text: w.feed.text }),
          el('div', { class: 'feed-url' }, [
            el('code', { class: 'mono feed-code', text: 'GET ' + feedLink.href }),
            copyButton(feedLink.href, { label: w.feed.copy, name: w.feed.copyName })
          ]),
          el('p', { class: 'p-fine', text: w.feed.fields })
        ]) : null,
        el('section', { class: 'card pub-about', 'data-section': 'about' }, [
          el('h2', { class: 'card-h', text: w.about.heading }),
          w.about.items.map(function (text) { return el('p', { class: 'p-fine', text: text }); }),
          el('p', { class: 'p-fine' }, fill(w.about.apply, { link: el('a', { href: '#', text: w.about.applyLink }) }))
        ])
      ])
    ]);
    render();
  }

  /**
   * The filter chips: "All", one per FA Type label in the data
   * (TEXT.featured.typeOrder first), "Type not set" and "Provisional" when
   * any app has them. Each is { key, label, count, test(app) }.
   */
  function featuredFilters(apps) {
    const w = TEXT.featured;
    const types = {};
    let none = 0;
    let provisional = 0;
    apps.forEach(function (app) {
      const type = textOf(app.type);
      if (type) types[type] = (types[type] || 0) + 1;
      else none += 1;
      if (app.status === 'provisional') provisional += 1;
    });
    const rank = function (type) {
      const i = w.typeOrder.indexOf(type);
      return i === -1 ? w.typeOrder.length : i;
    };
    const filters = [{ key: 'all', label: w.filters.all, count: apps.length, test: function () { return true; } }];
    Object.keys(types).sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); }).forEach(function (type) {
      filters.push({ key: 'type', label: type, count: types[type], test: function (app) { return textOf(app.type) === type; } });
    });
    if (none) filters.push({ key: 'none', label: w.filters.none, count: none, test: function (app) { return !textOf(app.type); } });
    if (provisional) filters.push({ key: 'provisional', label: w.filters.provisional, count: provisional, test: function (app) { return app.status === 'provisional'; } });
    return filters;
  }

  /** An app's Party IDs (strings only). */
  function partyIdsOf(app) {
    return Array.isArray(app.partyIds) ? app.partyIds.map(textOf).filter(Boolean) : [];
  }

  /**
   * One app on the public list: name, type, status, since (the date it was
   * featured, or revoked), announcement, then its Party IDs (with copy
   * buttons) on a line of their own. Each cell starts with its column name
   * for screen readers (the header row is visual).
   */
  function featuredRow(app) {
    const w = TEXT.featured;
    const name = textOf(app.name) || TEXT.fa.untitled;
    const type = textOf(app.type);
    const status = hasOwn(w.status, app.status) ? w.status[app.status] : w.status.featured;
    const date = formatDate(app.since);
    const since = date && app.sinceExact === false ? fillText(w.sinceBy, { date: date }) : date;
    const record = parseHttpsUrl(app.record);
    const ids = partyIdsOf(app);
    const label = function (text) { return el('span', { class: 'visually-hidden', text: text + ': ' }); };
    return el('li', { class: 'pub-row', 'data-status': hasOwn(w.status, app.status) ? app.status : 'featured' }, [
      el('span', { class: 'pub-name', text: name }),
      el('span', { class: 'pub-type' + (type ? '' : ' muted') }, [label(w.columns.type), type || w.typeNotSet]),
      el('span', { class: 'pub-status' }, [label(w.columns.status), pill(status.label, status.tone)]),
      el('span', { class: 'pub-since' }, [label(app.status === 'revoked' ? w.columns.revokedOn : w.columns.since), since || '—']),
      el('span', { class: 'pub-record' }, [
        label(w.columns.record),
        record ? externalLink(record, w.record) : el('span', { class: 'muted', text: w.noRecord })
      ]),
      el('div', { class: 'pub-party' }, ids.length ? ids.map(function (id) {
        return el('span', { class: 'pub-party-row' }, [
          el('span', { class: 'pub-party-label', text: w.partyId }),
          el('span', { class: 'mono pub-party-id', 'data-field': 'party-id', text: id }),
          copyButton(id, { label: w.copy, name: fillText(w.copyName, { name: name }) })
        ]);
      }) : el('span', { class: 'pub-party-label', text: w.noPartyId })),
      app.status === 'provisional' ? el('p', { class: 'pub-note', text: w.provisionalNote }) : null
    ]);
  }

  /** Reads the public list's JSON body: { updated, apps }, or null for anything unusable. */
  function readFeatured(body) {
    if (!isObject(body) || body.error || !Array.isArray(body.apps)) return null;
    return { updated: textOf(body.updated), apps: body.apps.filter(isObject) };
  }

  // ---- Footer

  /** Fills the footer (every screen) with the links in TEXT.siteFooter. Runs once. */
  function renderFooter() {
    const footer = document.querySelector('[data-footer]');
    if (!footer) return;
    const words = TEXT.siteFooter;
    const groups = words.groups.map(function (group) {
      const links = group.links.map(function (link) {
        if (link.email) return emailLink() || null;
        if (link.hash) return el('a', { href: '#' + link.hash, text: link.text });
        const url = parseHttpsUrl(link.url === 'reapply' ? CONFIG.reapplyUrl : link.url);
        return url ? externalLink(url, link.text) : null;
      }).filter(Boolean);
      return links.length ? el('div', { class: 'foot-group' }, [el('p', { class: 'foot-h', text: group.heading })].concat(links)) : null;
    });
    footer.textContent = '';
    append(footer, el('div', { class: 'wrap foot-inner' }, [
      el('div', { class: 'foot-about' }, [
        // The logo already has a text alternative in the header; here it's decoration.
        el('img', { class: 'foot-logo', src: 'cf-logo-dark.svg', width: '108', height: '30', alt: '' }),
        el('p', { text: words.about })
      ]),
      el('nav', { class: 'foot-links', 'aria-label': words.label }, groups)
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
    showLoading();
    const url = apiUrl + (apiUrl.indexOf('?') === -1 ? '?' : '&') + 'link=' + encodeURIComponent(code);
    startGet(url, function (id, body) { finish(id, readAnswer(body)); });
  }

  /** Asks Apps Script for the public list, showing the loading screen meanwhile. */
  function loadFeatured() {
    cancelRequest();
    session.code = null;
    session.answer = null;

    const apiUrl = configuredApiUrl();
    if (!apiUrl) {
      showError(TEXT.featured.error);
      return;
    }
    showLoading(TEXT.featured.loading);
    startGet(apiUrl + (apiUrl.indexOf('?') === -1 ? '?' : '&') + 'view=featured', function (id, body) {
      if (id !== session.pending) return;  // stale, cancelled or already finished
      endRequest();
      if (parseRoute(window.location.hash).kind !== 'featured') return;  // the visitor moved on
      const list = readFeatured(body);
      if (list) showFeatured(list, apiUrl);
      else showError(TEXT.featured.error);
    });
  }

  /**
   * Starts a plain GET to Apps Script as the request in flight: no custom
   * headers and no cache option, so no CORS preflight. `done(id, body)` gets
   * the request's number and the parsed JSON, or null for a network error,
   * an abort, a bad status, a body that isn't JSON or a timeout.
   */
  function startGet(url, done) {
    requestCount += 1;
    const id = requestCount;
    session.pending = id;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    session.controller = controller;
    session.timer = window.setTimeout(function () {
      done(id, null);  // timed out: show the error screen
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const options = {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow'
    };
    if (controller) options.signal = controller.signal;

    let request;
    try {
      request = window.fetch(url, options);
    } catch (err) {
      done(id, null);
      return;
    }
    request
      .then(function (response) {
        if (!response.ok) throw new Error('Unexpected HTTP status');
        return response.json();  // rejects on a body that isn't JSON
      })
      .then(
        function (body) { done(id, body); },
        function () { done(id, null); }
      );
  }

  /** Marks the request in flight as finished. */
  function endRequest() {
    session.pending = 0;
    window.clearTimeout(session.timer);
    session.timer = 0;
    session.controller = null;
  }

  /** Handles the end of request `id`: a good answer, or null for any failure. */
  function finish(id, answer) {
    if (id !== session.pending) return;  // stale, cancelled or already finished
    endRequest();
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
    if (route.kind === 'featured') {
      loadFeatured();
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
  renderFooter();
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
})();
