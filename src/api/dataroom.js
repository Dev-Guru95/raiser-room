/**
 * Phase 2 — the data room and diligence tracker.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import {
  FOLDERS, STAGES, STAGE_MEANING, DATAROOM_SOURCE,
  itemsForPath, visibleAtStage, checkFilename, staleDocuments, DEFAULT_STALE_DAYS,
} from '../domain/dataroom.js';
import { recordMilestone } from './timing.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * Build the room: ten folders and the checklist that applies to this org's path.
 *
 * A SALE org gets normalisation and transferability items a RAISE org does not,
 * and vice versa. That is the whole reason `Organisation.path` exists.
 */
export function buildRoom(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const org = ctx.db.get('organisation', orgId);
  if (ctx.db.count('data_room_node', { org_id: orgId }) > 0) throw new AccessError('already_built', 409);

  const now = ctx.now();
  const nodeByKey = new Map();
  for (const f of FOLDERS) {
    const node = ctx.db.insert('data_room_node', {
      org_id: orgId, parent_id: null, sort_key: f.key, name: f.name,
      required: 1, stage: f.stage, created_at: now,
    });
    nodeByKey.set(f.key, node.id);
  }

  const items = itemsForPath(org.path ?? 'UNDECIDED');
  for (const i of items) {
    ctx.db.insert('data_room_item', {
      org_id: orgId, node_id: nodeByKey.get(i.folder), item_ref: i.ref, name: i.name,
      required: i.required ? 1 : 0, document_id: null, not_applicable: 0, na_reason: null,
      created_at: now,
    });
  }

  recordMilestone(ctx, orgId, 'ROOM_BUILT', now);
  audit(ctx, orgId, 'dataroom.built', 'organisation', orgId,
    { path: org.path, folders: FOLDERS.length, items: items.length });
  return ok({ folders: FOLDERS.length, items: items.length, path: org.path }, 201);
}

/**
 * The room, with completeness.
 *
 * Three-state per item, borrowed from how the audit handles approvals:
 * present / not applicable with a written reason / missing. "Not applicable"
 * without a reason is just missing with better manners, so the reason is required.
 */
export function getRoom(ctx, orgId, { stage = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');

  const nodes = ctx.db.find('data_room_node', { org_id: orgId })
    .sort((a, b) => a.sort_key.localeCompare(b.sort_key));
  const items = ctx.db.find('data_room_item', { org_id: orgId });
  const docs = ctx.db.find('document', { org_id: orgId });
  const docById = new Map(docs.map((d) => [d.id, d]));

  let reqTotal = 0; let reqDone = 0;
  const folders = [];

  for (const n of nodes) {
    if (stage && !visibleAtStage(n.stage, stage)) continue;
    const mine = items.filter((i) => i.node_id === n.id);
    const present = mine.filter((i) => i.document_id && docById.get(i.document_id)?.uploaded_at);
    const na = mine.filter((i) => i.not_applicable);
    const required = mine.filter((i) => i.required);
    const requiredSatisfied = required.filter((i) =>
      (i.document_id && docById.get(i.document_id)?.uploaded_at) || i.not_applicable);

    reqTotal += required.length;
    reqDone += requiredSatisfied.length;

    folders.push({
      node_id: n.id, key: n.sort_key, name: n.name, stage: n.stage,
      stage_means: STAGE_MEANING[n.stage],
      items: mine.map((i) => ({
        id: i.id, ref: i.item_ref, name: i.name, required: !!i.required,
        state: i.not_applicable ? 'NOT_APPLICABLE'
          : (i.document_id && docById.get(i.document_id)?.uploaded_at) ? 'PRESENT' : 'MISSING',
        document_id: i.document_id, na_reason: i.na_reason,
      })),
      completeness: required.length ? pct(requiredSatisfied.length, required.length) : 100,
      present: present.length, not_applicable: na.length, missing: mine.length - present.length - na.length,
    });
  }

  return ok({
    source: DATAROOM_SOURCE,
    folders,
    completeness: reqTotal ? pct(reqDone, reqTotal) : 0,
    required_total: reqTotal, required_satisfied: reqDone,
    stage_filter: stage,
  });
}

/** Attach a document to a checklist item. */
export function satisfyItem(ctx, orgId, itemId, documentId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const item = assertBelongsToOrg(ctx.db.get('data_room_item', itemId), orgId);
  const doc = assertBelongsToOrg(ctx.db.get('document', documentId), orgId);
  if (!doc.uploaded_at) throw new AccessError('upload_incomplete', 409);

  const updated = ctx.db.update('data_room_item', itemId, {
    document_id: documentId, not_applicable: 0, na_reason: null,
  });
  ctx.db.update('document', documentId, { data_room_node_id: item.node_id });
  audit(ctx, orgId, 'dataroom.item_satisfied', 'data_room_item', itemId,
    { item_ref: item.item_ref, document_id: documentId });
  noteRoomProgress(ctx, orgId);
  return ok({ item: updated });
}

/** Mark an item not applicable. A written reason is mandatory. */
export function markNotApplicable(ctx, orgId, itemId, reason) {
  authorise(membershipOf(ctx, orgId), 'write');
  const item = assertBelongsToOrg(ctx.db.get('data_room_item', itemId), orgId);

  const text = String(reason ?? '').trim();
  if (text.length < 10) {
    throw new AccessError('reason_required', 400, {
      detail: 'Not applicable needs a written reason. Without one it is missing with better manners, ' +
              'and a counterparty will read it that way.',
    });
  }

  const updated = ctx.db.update('data_room_item', itemId, {
    not_applicable: 1, na_reason: text, document_id: null,
  });
  audit(ctx, orgId, 'dataroom.item_not_applicable', 'data_room_item', itemId,
    { item_ref: item.item_ref, reason: text });
  noteRoomProgress(ctx, orgId);
  return ok({ item: updated });
}

/**
 * Record how far through the required room this organisation has got.
 *
 * Half is on clock A — filing what you already have. Complete is on clock B,
 * because the last few required items are reliably the ones that need somebody
 * else to sign something.
 */
function noteRoomProgress(ctx, orgId) {
  const items = ctx.db.find('data_room_item', { org_id: orgId }).filter((i) => i.required);
  if (!items.length) return;

  const docs = new Map(ctx.db.find('document', { org_id: orgId }).map((d) => [d.id, d]));
  const satisfied = items.filter((i) =>
    i.not_applicable || (i.document_id && docs.get(i.document_id)?.uploaded_at)).length;

  const share = satisfied / items.length;
  if (share >= 0.5) recordMilestone(ctx, orgId, 'ROOM_REQUIRED_HALF');
  if (share >= 1) recordMilestone(ctx, orgId, 'ROOM_REQUIRED_COMPLETE');
}

/** What a counterparty at this stage would actually see. */
export function stagePreview(ctx, orgId, stage) {
  authorise(membershipOf(ctx, orgId), 'read');
  if (!STAGES.includes(stage)) throw new AccessError('invalid_stage', 400);

  const room = getRoom(ctx, orgId, { stage }).body;
  const visibleNodeIds = new Set(room.folders.map((f) => f.node_id));
  const docs = ctx.db.find('document', { org_id: orgId })
    .filter((d) => d.uploaded_at && visibleNodeIds.has(d.data_room_node_id));

  return ok({
    stage, means: STAGE_MEANING[stage],
    folders: room.folders.map((f) => ({ key: f.key, name: f.name })),
    documents: docs.map((d) => ({ id: d.id, filename: d.filename })),
    withheld_folders: FOLDERS.filter((f) => !visibleAtStage(f.stage, stage)).map((f) => f.name),
  });
}

/** Room hygiene: naming, staleness, unfiled documents. */
export function roomHealth(ctx, orgId, { staleDays = DEFAULT_STALE_DAYS } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');

  const nodes = ctx.db.find('data_room_node', { org_id: orgId });
  const keyByNode = new Map(nodes.map((n) => [n.id, n.sort_key]));
  const docs = ctx.db.find('document', { org_id: orgId }).filter((d) => d.uploaded_at);

  const naming = [];
  for (const d of docs) {
    const r = checkFilename(d.filename, { folderKey: keyByNode.get(d.data_room_node_id) ?? null });
    if (!r.ok) naming.push({ document_id: d.id, filename: d.filename, ...r });
  }

  const items = ctx.db.find('data_room_item', { org_id: orgId });
  const claimed = new Set(items.map((i) => i.document_id).filter(Boolean));

  return ok({
    naming_problems: naming,
    stale: staleDocuments(docs, { asOf: ctx.now(), staleDays }),
    unfiled: docs.filter((d) => !claimed.has(d.id))
      .map((d) => ({ document_id: d.id, filename: d.filename })),
    missing_required: items
      .filter((i) => i.required && !i.not_applicable && !i.document_id)
      .map((i) => ({ item_ref: i.item_ref, name: i.name })),
  });
}

/**
 * Import a counterparty's diligence request list and map it to the room.
 * Coverage is reported, never asserted — matching is a heuristic and the user
 * confirms it.
 */
export function mapRequestList(ctx, orgId, lines) {
  authorise(membershipOf(ctx, orgId), 'read');
  const items = ctx.db.find('data_room_item', { org_id: orgId });
  const docById = new Map(ctx.db.find('document', { org_id: orgId }).map((d) => [d.id, d]));

  const mapped = [];
  for (const raw of (lines ?? [])) {
    const line = String(raw).trim();
    if (!line) continue;
    const best = bestMatch(line, items);
    mapped.push({
      request: line,
      matched_item_ref: best?.item.item_ref ?? null,
      matched_name: best?.item.name ?? null,
      confidence: best ? best.score : 0,
      covered: !!(best && (best.item.document_id
        ? docById.get(best.item.document_id)?.uploaded_at : best.item.not_applicable)),
      needs_review: !best || best.score < 0.4,
    });
  }

  return ok({
    mapped,
    covered: mapped.filter((m) => m.covered).length,
    uncovered: mapped.filter((m) => !m.covered).length,
    needs_review: mapped.filter((m) => m.needs_review).length,
    note: 'Matching is a heuristic. Review anything flagged before relying on the coverage figure.',
  });
}

/** Token overlap. Deliberately simple and explainable — no model involved. */
function bestMatch(line, items) {
  const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const want = tokens(line);
  if (!want.size) return null;

  let best = null;
  for (const item of items) {
    const have = tokens(item.name);
    let hits = 0;
    for (const t of want) if (have.has(t)) hits++;
    const score = hits / Math.max(want.size, 1);
    if (score > 0 && (!best || score > best.score)) best = { item, score: round2(score) };
  }
  return best;
}

const pct = (a, b) => Math.round((a / b) * 1000) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export { FOLDERS, STAGES, checkFilename };

// ─────────────────────────────────────────────── folders, added by hand ──
//
// These exist because the advisor needs them, but they are ordinary user
// capabilities and are written as such. An action the advisor can take that a
// person cannot is a privilege, and the advisor is not supposed to have any.

/**
 * Add a folder to the room.
 *
 * The ten standard folders are built by `buildRoom`. This is for the eleventh —
 * the one a particular company needs and the template does not have.
 */
export function createFolder(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const name = String(input.name ?? '').trim();
  if (!name) throw new AccessError('name_required', 400, { detail: 'A folder needs a name.' });
  if (name.length > 80) throw new AccessError('name_too_long', 400);

  const stage = input.stage ?? 'PRE_MEETING';
  if (!STAGES.includes(stage)) throw new AccessError('invalid_stage', 400, { allowed: STAGES });

  let parentId = input.parent_id ?? null;
  if (parentId) {
    // Through `assertBelongsToOrg`, so a parent id from another organisation is
    // a 404 and not a confirmation that the id exists.
    assertBelongsToOrg(ctx.db.get('data_room_node', parentId), orgId);
  } else {
    parentId = null;
  }

  const siblings = ctx.db.find('data_room_node', { org_id: orgId })
    .filter((n) => (n.parent_id ?? null) === parentId);
  if (siblings.some((n) => n.name.toLowerCase() === name.toLowerCase())) {
    // Two folders with the same name in one room is a filing error waiting to
    // happen, and a counterparty reading the index cannot tell them apart.
    throw new AccessError('duplicate_folder', 409, {
      detail: `There is already a folder called "${name}" here.`,
    });
  }

  const node = ctx.db.insert('data_room_node', {
    org_id: orgId, parent_id: parentId,
    sort_key: input.sort_key ?? nextSortKey(siblings),
    name, required: input.required ? 1 : 0, stage, created_at: ctx.now(),
  });
  audit(ctx, orgId, 'dataroom.folder_created', 'data_room_node', node.id,
    { name, stage, parent_id: parentId });
  return ok({ folder: node }, 201);
}

/**
 * Sort keys are strings, and they sort as strings.
 *
 * So "10" comes before "9" unless the numbers are padded, which is how a data
 * room index ends up reading 1, 10, 11, 2 — the kind of detail a counterparty
 * notices before they notice anything else.
 */
function nextSortKey(siblings) {
  const numeric = siblings
    .map((n) => Number(String(n.sort_key).replace(/\D/g, '')))
    .filter(Number.isFinite);
  const next = (numeric.length ? Math.max(...numeric) : 0) + 1;
  return String(next).padStart(2, '0');
}

/** Rename a folder, move it in the order, or change the stage it appears at. */
export function updateFolder(ctx, orgId, nodeId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const node = assertBelongsToOrg(ctx.db.get('data_room_node', nodeId), orgId);

  const updates = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new AccessError('name_required', 400);
    updates.name = name;
  }
  if (input.sort_key !== undefined) {
    const key = String(input.sort_key).trim();
    if (!key) throw new AccessError('sort_key_required', 400);
    updates.sort_key = key;
  }
  if (input.stage !== undefined) {
    if (!STAGES.includes(input.stage)) throw new AccessError('invalid_stage', 400, { allowed: STAGES });
    // Loosening a folder's stage makes documents visible to counterparties who
    // could not see them before. That is a real disclosure, so it is audited
    // with both values rather than just the new one.
    updates.stage = input.stage;
  }
  if (!Object.keys(updates).length) throw new AccessError('nothing_to_update', 400);

  const updated = ctx.db.update('data_room_node', nodeId, updates);
  audit(ctx, orgId, 'dataroom.folder_updated', 'data_room_node', nodeId,
    { from: { name: node.name, sort_key: node.sort_key, stage: node.stage }, to: updates });
  return ok({ folder: updated });
}

// ───────────────────────────────────────────────────── document requests ──

/**
 * Record a request for a document.
 *
 * Recorded, not sent. There is no mail channel in this product, and a request
 * that quietly goes nowhere is worse than one plainly marked as waiting — the
 * first makes someone think they have chased a supplier when they have not.
 */
export function requestDocument(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const note = String(input.note ?? '').trim();
  if (!note) throw new AccessError('note_required', 400, {
    detail: 'A request has to say what is being asked for.',
  });

  let itemId = input.item_id ?? null;
  if (itemId) assertBelongsToOrg(ctx.db.get('data_room_item', itemId), orgId);
  else itemId = null;

  const row = ctx.db.insert('document_request', {
    org_id: orgId, item_id: itemId,
    recipient: input.recipient ?? null,
    note, state: 'PENDING_SEND',
    proposal_id: input.proposal_id ?? null,
    created_by: ctx.auth.userId, created_at: ctx.now(),
  });
  audit(ctx, orgId, 'dataroom.document_requested', 'document_request', row.id,
    { item_id: itemId, recipient: input.recipient ?? null });

  return ok({
    request: row,
    note: 'Recorded. Sending is not built yet, so this is a reminder of what you owe someone a chase '
        + 'about rather than a message that has gone out.',
  }, 201);
}

export function listDocumentRequests(ctx, orgId, { includeClosed = false } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const rows = ctx.db.find('document_request', { org_id: orgId })
    .filter((r) => includeClosed || !['FULFILLED', 'CANCELLED'].includes(r.state))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return ok({ requests: rows, total: rows.length });
}
