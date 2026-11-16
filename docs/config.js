/*
 * Featured App Status: site settings.
 *
 * Loaded by index.html before status.js. Everything here is public (it ships
 * to every visitor), so never put a token or any applicant data in this file.
 * The object is frozen so nothing else on the page can change it.
 */
window.FA_STATUS_CONFIG = Object.freeze({
  /*
   * The Google Apps Script web app's /exec URL (Deploy > Manage deployments >
   * Web app URL). The page calls it as `<apiUrl>?link=<token>` with a plain
   * GET, and POSTs the email form to it. While it still contains
   * REPLACE_WITH_DEPLOYMENT_ID the page makes no request: links show the
   * "couldn't load" screen, the form says it couldn't send, and the console
   * shows a warning.
   * It must stay on https://script.google.com, the only API host the page's
   * Content-Security-Policy (connect-src in index.html) allows.
   */
  apiUrl: 'https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec',

  /*
   * Where applicants write to the Featured App team: no email arriving,
   * questions about a decision, or a page that won't load. Shown as a
   * mailto: link on every screen.
   */
  supportEmail: 'ops@canton.foundation',

  /*
   * How to apply under the current process. Linked from applications closed
   * when the review process changed (state "closed_process"). Only an
   * https:// URL is shown as a link.
   */
  reapplyUrl: 'https://canton.foundation/featured-app-request/'
});
