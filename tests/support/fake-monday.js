'use strict';
/**
 * fake-monday.js: an in-memory stand-in for Monday's GraphQL API, shaped like
 * the real answers recorded on the sandbox boards (DESIGN.md, Appendix A).
 *
 * It understands exactly the requests Code.gs makes:
 *   - boards(ids) { items_page(limit) { cursor items {...} } }   (first page)
 *   - next_items_page(cursor, limit) { cursor items {...} }      (next pages)
 *   - boards(ids) { columns(ids) { id type settings } }          (column check)
 *   - mutation { w0: change_multiple_column_values(...) ... }    (aliased writes)
 *
 * Rows also carry "forbidden" columns (email, Entry ID, FAAC notes...) holding
 * SENTINEL values, so tests can prove those never leave the script.
 */

const FA = '18420896395';
const DVP = '18436778970';
const LINK_COL = 'link_status1';
const REL_COL = 'board_relation_x1';

const SENTINELS = {
  email_mm4ke170: 'SENTINEL-EMAIL@example.com',
  text_mm4kvrar: 'SENTINEL-RESPONSIBLE@example.com',
  text_mm51m9b1: 'SENTINEL-ENTRY-ID',
  text_mm54j2kf: 'SENTINEL-FAAC-THOUGHTS',
  color_mm7e35qc: 'SENTINEL-TIER',
  long_text_mm4khjn6: 'SENTINEL-LOCKING-PARTY'
};

// ---------------------------------------------------------------- column value builders (real shapes)
const cv = {
  text: (id, t) => ({ id, type: 'text', text: t || '', value: t ? JSON.stringify(t) : null }),
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
  }),
  relation: (id, ids) => ({ id, type: 'board_relation', text: null, value: null, linked_item_ids: (ids || []).map(String) })
};

/**
 * A raw FA item in Monday's shape. Every field optional.
 * f = {id, name, created_at, status, statusChangedAt, type, submitted, lockVerified,
 *      lockedAmount, testing, partyId, website, announcement, sendEmail, statusLink}
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
    cv.status('color_mm6eay19', f.sendEmail),
    f.statusLinkRaw ? Object.assign({ id: LINK_COL, type: 'link' }, f.statusLinkRaw) : cv.link(LINK_COL, f.statusLink, f.statusLink ? 'Status link' : '')
  ];
  // Forbidden columns, present on the board but never to be requested.
  Object.keys(SENTINELS).forEach((id) => cols.push(cv.text(id, SENTINELS[id])));
  return { id: String(f.id), name: f.name, created_at: f.created_at || '2026-07-07T15:16:37Z', column_values: cols };
}

/** A raw DVP item. d = {id, name, status, submitted, finalApproval, requestUrl, requestText, faIds} */
function dvpItem(d) {
  return {
    id: String(d.id),
    name: d.name,
    created_at: '2026-11-03T16:10:53Z',
    column_values: [
      cv.date('date_mm8dsx4y', d.submitted),
      cv.date('date_mm8dm7a0', d.finalApproval),
      cv.status('color_mm8dhgvr', d.status),
      cv.link('link_mm8rp25j', d.requestUrl, d.requestText),
      cv.relation(REL_COL, d.faIds),
      cv.longText('long_textyug17rnr', 'SENTINEL-DVP-ANSWER')
    ]
  };
}

const SEND_EMAIL_LABELS = ['Working on it', 'Done', 'Stuck', 'Locking Check', 'Decline', '', 'Office Hour Request', 'Updated Process', 'Endorsements', 'FA Type Email'];

/**
 * Creates a fake Monday server.
 * @param {{fa: Array, dvp?: Array, statusLinkLabel?: boolean, statusLinkLabelDeactivated?: boolean}} data
 */
function createFakeMonday(data) {
  const boards = {};
  boards[FA] = { items: data.fa.slice(), labels: SEND_EMAIL_LABELS.concat(data.statusLinkLabel ? ['Status link'] : []) };
  boards[DVP] = { items: (data.dvp || []).slice() };
  const fake = {
    boards: boards,
    requestedColumnIds: new Set(),
    mutations: 0,          // number of mutation requests
    aliasesPerMutation: [],
    failNext: [],          // queue of {status, body} answers to return before normal handling
    failItems: new Set(),  // item ids whose writes fail with InvalidItemIdException
    failMutationsWith: null, // an answer returned for every mutation (e.g. HTTP 429)
    writeRejectsLabel: false, // label passes the settings check but the write says missingLabel (race)
    labelDeactivated: Boolean(data.statusLinkLabelDeactivated),
    item: (id) => boards[FA].items.find((i) => i.id === String(id)) || boards[DVP].items.find((i) => i.id === String(id)),
    cell: (itemId, colId) => (fake.item(itemId) || { column_values: [] }).column_values.find((c) => c.id === colId),
    handle: (req) => handle(fake, req)
  };
  return fake;
}

function ok(body, headers) { return { code: 200, body: JSON.stringify(body), headers: headers || {} }; }

function pick(item, columnIds, withRelation) {
  const ids = new Set(columnIds);
  return {
    id: item.id,
    name: item.name,
    created_at: item.created_at,
    column_values: item.column_values.filter((c) => ids.has(c.id)).map((c) => {
      const copy = { id: c.id, type: c.type, text: c.text, value: c.value };
      if (withRelation && c.type === 'board_relation') copy.linked_item_ids = c.linked_item_ids;
      return copy;
    })
  };
}

function handle(fake, req) {
  if (fake.failNext.length) return fake.failNext.shift();
  const query = req.payload.query;
  const v = req.payload.variables || {};

  if (/^\s*mutation/.test(query)) {
    if (fake.failMutationsWith) { fake.mutations++; return fake.failMutationsWith; }
    return mutate(fake, query, v);
  }

  if (query.indexOf('columns(ids:') !== -1) {
    const board = fake.boards[String(v.b)];
    if (!board) return ok({ data: { boards: [] } });
    const columns = (v.c || []).filter((id) => id === 'color_mm6eay19' || id === LINK_COL || id === REL_COL || /^(text|color|date|numeric|long_text|link)_/.test(id)).map((id) => {
      if (id === 'color_mm6eay19') {
        return { id, type: 'status', settings: { labels: fake.boards[FA].labels.map((label, index) => ({ id: index, label: label, index: index, is_deactivated: label === 'Status link' && fake.labelDeactivated })) } };
      }
      if (id === LINK_COL) return { id, type: 'link', settings: {} };
      if (id === REL_COL) return { id, type: 'board_relation', settings: { boardIds: [Number(FA)] } };
      return { id, type: id.split('_')[0] === 'color' ? 'status' : id.split('_')[0], settings: {} };
    });
    return ok({ data: { boards: [{ columns: columns }] } });
  }

  const withRelation = query.indexOf('BoardRelationValue') !== -1;
  (v.c || []).forEach((id) => fake.requestedColumnIds.add(id));
  const limit = v.l || 500;
  if (query.indexOf('next_items_page') !== -1) {
    const [boardId, offset] = String(v.cur).split(':');
    return ok({ data: { next_items_page: page(fake, boardId, Number(offset), limit, v.c, withRelation) } });
  }
  const board = fake.boards[String(v.b)];
  if (!board) return ok({ data: { boards: [] } });
  return ok({ data: { boards: [{ items_page: page(fake, String(v.b), 0, limit, v.c, withRelation) }] } });
}

function page(fake, boardId, offset, limit, columnIds, withRelation) {
  const items = fake.boards[boardId].items;
  const slice = items.slice(offset, offset + limit).map((item) => pick(item, columnIds || [], withRelation));
  const next = offset + limit < items.length ? boardId + ':' + (offset + limit) : null;
  return { cursor: next, items: slice };
}

function mutate(fake, query, v) {
  fake.mutations++;
  const aliases = query.match(/w\d+:/g) || [];
  fake.aliasesPerMutation.push(aliases.length);
  const data = {};
  const errors = [];
  aliases.forEach((a) => {
    const alias = a.slice(0, -1);
    const n = alias.slice(1);
    const itemId = String(v['i' + n]);
    const values = JSON.parse(v['v' + n]);
    const item = fake.boards[String(v.b)] && fake.boards[String(v.b)].items.find((i) => i.id === itemId);
    if (!item || fake.failItems.has(itemId)) {
      data[alias] = null;
      errors.push({ message: 'Item not found', path: [alias], extensions: { code: 'InvalidItemIdException', status_code: 200, error_data: { item_id: null } } });
      return;
    }
    // Validate first: a missing label fails the whole write for this item (as on the real API).
    for (const colId of Object.keys(values)) {
      const val = values[colId];
      if (val && typeof val === 'object' && 'label' in val && (fake.writeRejectsLabel || fake.boards[FA].labels.indexOf(val.label) === -1)) {
        data[alias] = null;
        errors.push({
          message: "This status label doesn't exist, possible statuses are: {...} value " + JSON.stringify(values),
          path: [alias],
          extensions: { code: 'ColumnValueException', status_code: 200, error_data: { column_id: colId, column_value: JSON.stringify(values), column_validation_error_code: 'missingLabel' } }
        });
        return;
      }
    }
    Object.keys(values).forEach((colId) => {
      const val = values[colId];
      const idx = item.column_values.findIndex((c) => c.id === colId);
      const type = idx === -1 ? (val && 'label' in val ? 'status' : 'link') : item.column_values[idx].type;
      let next;
      if (val === null) next = { id: colId, type: type, text: type === 'status' ? null : '', value: null };
      else if ('label' in val) next = cv.status(colId, val.label, '2026-11-16T13:00:00.000Z');
      else next = cv.link(colId, val.url, val.text, '2026-11-16T13:00:00.000Z');
      if (idx === -1) item.column_values.push(next); else item.column_values[idx] = next;
    });
    data[alias] = { id: itemId };
  });
  const body = { data: data };
  if (errors.length) body.errors = errors;
  return ok(body);
}

module.exports = { createFakeMonday, faItem, dvpItem, cv, FA, DVP, LINK_COL, REL_COL, SENTINELS };
