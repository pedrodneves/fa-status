'use strict';
/**
 * fake-monday.js: an in-memory stand-in for Monday's GraphQL API, shaped like
 * the real answers (column value shapes recorded on the real boards).
 *
 * It understands exactly the requests Code.gs makes:
 *   - boards(ids) { items_page(limit) { cursor items {...} } }   (first page)
 *   - next_items_page(cursor, limit) { cursor items {...} }      (next pages)
 *   - boards(ids) { columns(ids) { id type } }                   (setup check)
 * Anything starting with "mutation" is counted and refused: the script must
 * never send one.
 *
 * Rows also carry "forbidden" columns (Entry ID, FAAC notes, Tier...) holding
 * SENTINEL values, so tests can prove those never leave the script.
 */

const FA = '18420896395';
const DVP = '18436778970';

/** Columns that must never be requested. Their values must never appear anywhere. */
const SENTINELS = {
  text_mm51m9b1: 'SENTINEL-ENTRY-ID',
  text_mm54j2kf: 'SENTINEL-FAAC-THOUGHTS',
  color_mm7e35qc: 'SENTINEL-TIER',
  long_text_mm4khjn6: 'SENTINEL-LOCKING-PARTY',
  text_mm63jakx: 'SENTINEL-SLACK-USER'
};

// ---------------------------------------------------------------- column value builders (real shapes)
const cv = {
  text: (id, t) => ({ id, type: 'text', text: t || '', value: t ? JSON.stringify(t) : null }),
  email: (id, address) => ({ id, type: 'email', text: address || '', value: address ? JSON.stringify({ email: address, text: address }) : null }),
  status: (id, label, changedAt) => ({
    id, type: 'status', text: label || null,
    value: label ? JSON.stringify(changedAt ? { index: 1, changed_at: changedAt } : { index: 1 }) : null
  }),
  date: (id, d, changedAt) => ({
    id, type: 'date', text: d || '',
    value: d ? JSON.stringify(changedAt ? { date: d, changed_at: changedAt } : { date: d }) : null
  }),
  number: (id, n) => ({ id, type: 'numbers', text: n === undefined || n === null ? '' : String(n), value: n === undefined || n === null ? null : JSON.stringify(String(n)) }),
  longText: (id, t) => ({ id, type: 'long_text', text: t || '', value: t ? JSON.stringify({ text: t }) : null }),
  link: (id, url, text, changedAt) => ({
    id, type: 'link',
    text: url ? (text && text !== url ? text + ' - ' + url : url) : '',
    value: url ? JSON.stringify({ url: url, text: text || url, changed_at: changedAt || null }) : null
  })
};

/**
 * A raw FA item in Monday's shape. Every field optional.
 * f = {id, name, institution, email, responsible, status, statusChangedAt, type,
 *      submitted, lockVerified, lockedAmount, testing, partyId, website, announcement,
 *      sendEmail, sendEmailChangedAt}
 */
function faItem(f) {
  const cols = [
    cv.text('text_mm4k2vch', f.institution),
    cv.status('color_mm4kmej3', f.status, f.statusChangedAt),
    cv.status('color_mm4kpp3q', f.type),
    cv.date('date_mm4kw11a', f.submitted),
    cv.date('date_mm4kpckv', f.lockVerified),
    cv.number('numeric_mm4k6919', f.lockedAmount),
    cv.status('color_mm6be9ge', f.testing),
    cv.longText('long_text_mm4kq322', f.partyId),
    cv.link('link_mm4kmq24', f.website),
    cv.link('link_mm6hfp5g', f.announcement),
    cv.status('color_mm6eay19', f.sendEmail, f.sendEmailChangedAt),
    cv.email('email_mm4ke170', f.email),
    cv.text('text_mm4kvrar', f.responsible)
  ];
  Object.keys(SENTINELS).forEach((id) => cols.push(cv.text(id, SENTINELS[id])));
  return { id: String(f.id), name: f.name, column_values: cols };
}

/** A raw DVP item. d = {id, name, status, submitted, finalApproval, requestUrl, requestText} */
function dvpItem(d) {
  return {
    id: String(d.id),
    name: d.name,
    column_values: [
      cv.date('date_mm8dsx4y', d.submitted),
      cv.date('date_mm8dm7a0', d.finalApproval),
      cv.status('color_mm8dhgvr', d.status),
      cv.link('link_mm8rp25j', d.requestUrl, d.requestText),
      cv.longText('long_textyug17rnr', 'SENTINEL-DVP-ANSWER')
    ]
  };
}

/**
 * Creates a fake Monday server.
 * @param {{fa: Array, dvp?: Array, missingColumns?: Array<string>}} data
 */
function createFakeMonday(data) {
  const boards = {};
  boards[FA] = { items: data.fa.slice() };
  boards[DVP] = { items: (data.dvp || []).slice() };
  const fake = {
    boards: boards,
    missingColumns: new Set(data.missingColumns || []),
    requestedColumnIds: new Set(),
    queries: 0,
    mutations: 0,
    failNext: [], // queue of {code, body} answers returned before normal handling
    handle: (req) => handle(fake, req)
  };
  return fake;
}

function ok(body, headers) { return { code: 200, body: JSON.stringify(body), headers: headers || {} }; }

function pick(item, columnIds) {
  const ids = new Set(columnIds);
  return {
    id: item.id,
    name: item.name,
    column_values: item.column_values.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, type: c.type, text: c.text, value: c.value }))
  };
}

function handle(fake, req) {
  if (fake.failNext.length) return fake.failNext.shift();
  const query = req.payload.query;
  const v = req.payload.variables || {};

  if (/^\s*mutation/.test(query)) {
    fake.mutations++;
    return ok({ errors: [{ message: 'mutations are not allowed in tests', extensions: { code: 'TestRefusedMutation' } }] });
  }
  fake.queries++;

  if (query.indexOf('columns(ids:') !== -1) {
    const board = fake.boards[String(v.b)];
    if (!board) return ok({ data: { boards: [] } });
    const columns = (v.c || []).filter((id) => !fake.missingColumns.has(id)).map((id) => ({ id, type: id.split('_')[0] }));
    return ok({ data: { boards: [{ columns: columns }] } });
  }

  (v.c || []).forEach((id) => fake.requestedColumnIds.add(id));
  const limit = v.l || 500;
  if (query.indexOf('next_items_page') !== -1) {
    const [boardId, offset] = String(v.cur).split(':');
    return ok({ data: { next_items_page: page(fake, boardId, Number(offset), limit, v.c) } });
  }
  const board = fake.boards[String(v.b)];
  if (!board) return ok({ data: { boards: [] } });
  return ok({ data: { boards: [{ items_page: page(fake, String(v.b), 0, limit, v.c) }] } });
}

function page(fake, boardId, offset, limit, columnIds) {
  const items = fake.boards[boardId].items;
  const slice = items.slice(offset, offset + limit).map((item) => pick(item, columnIds || []));
  const next = offset + limit < items.length ? boardId + ':' + (offset + limit) : null;
  return { cursor: next, items: slice };
}

module.exports = { createFakeMonday, faItem, dvpItem, cv, FA, DVP, SENTINELS };
