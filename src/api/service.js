/**
 * Service layer — the ported Phase 0 surface, framework-agnostic.
 *
 * Every function takes (ctx, input) and returns { status, body }. No Request,
 * no Response, no framework import. That is what makes it testable, and the
 * absence of exactly this property is why four broken handlers were reported
 * as one in the previous implementation.
 *
 * ctx = { db, auth: { userId, email }, now() }
 *
 * THE INVARIANT, in one sentence:
 *   resolve the caller's membership for :orgId FIRST, authorise, and only then
 *   touch any row — and re-check org ownership on every row fetched by id.
 */

import { randomUUID } from 'node:crypto';
import { authorise, assertNotLastOwner, assertBelongsToOrg, AccessError, ROLES } from '../domain/access.js';
import { buildFact, confirmationStamp, FactError } from '../domain/facts.js';
import { recordMilestone } from './timing.js';
import * as usage from './usage.js';
import { invitation } from '../email/messages.js';

const PATHS = ['RAISE', 'SALE', 'UNDECIDED'];
const DOC_KINDS = ['DECK', 'ACCOUNTS', 'MODEL', 'CONTRACT', 'CAP_TABLE', 'OTHER'];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const ok = (body, status = 200) => ({ status, body });

/** Every mutation writes an audit row. No exceptions. */
function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: ctx.now(),
  });
}

/** Resolve the caller's membership, or null. The gate for everything below. */
function membershipOf(ctx, orgId) {
  return ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });
}

// ─────────────────────────────────────────────────────────── organisations ──

export function createOrganisation(ctx, input) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw new AccessError('invalid_name', 400);

  const path = PATHS.includes(input.path) ? input.path : 'UNDECIDED';
  const currency = /^[A-Z]{3}$/.test(String(input.currency ?? '')) ? input.currency : 'USD';

  let targetAmount = null;
  if (input.target_amount !== undefined && input.target_amount !== null && input.target_amount !== '') {
    const n = Number(input.target_amount);
    if (!Number.isFinite(n) || n < 0) throw new AccessError('invalid_target_amount', 400);
    targetAmount = Math.round(n);
  }

  const now = ctx.now();
  const org = ctx.db.insert('organisation', { name, path, currency, target_amount: targetAmount, created_at: now });
  ctx.db.insert('membership', {
    org_id: org.id, user_id: ctx.auth.userId, email: ctx.auth.email ?? null, role: 'OWNER', created_at: now,
  });
  audit(ctx, org.id, 'organisation.created', 'organisation', org.id, { name, path });
  recordMilestone(ctx, org.id, 'ORG_CREATED', now);

  return ok({ organisation: { ...org, role: 'OWNER' } }, 201);
}

/**
 * List the caller's organisations, claiming any invite addressed to them.
 *
 * This endpoint WRITES (it creates a membership when claiming). In the previous
 * implementation it was treated as read-only and shipped without the fix that
 * every other write received — so a second user clicking an invitation failed
 * on their very first request.
 */
export function listOrganisations(ctx) {
  const email = (ctx.auth.email ?? '').toLowerCase();
  const now = ctx.now();

  if (email) {
    for (const inv of ctx.db.find('invite', { email })) {
      if (inv.claimed_at || inv.revoked_at) continue;
      const org = ctx.db.get('organisation', inv.org_id);
      if (!org) continue;                                  // invite to a deleted org
      const already = ctx.db.findOne('membership', { org_id: inv.org_id, user_id: ctx.auth.userId });
      if (!already) {
        ctx.db.insert('membership', {
          org_id: inv.org_id, user_id: ctx.auth.userId, email,
          role: ROLES.includes(inv.role) ? inv.role : 'VIEWER',
          created_at: now,
        });
        audit(ctx, inv.org_id, 'invite.claimed', 'invite', inv.id, { role: inv.role });
      }
      ctx.db.update('invite', inv.id, { claimed_at: now, claimed_by: ctx.auth.userId });
    }
  }

  const out = [];
  for (const m of ctx.db.find('membership', { user_id: ctx.auth.userId })) {
    const org = ctx.db.get('organisation', m.org_id);
    if (org) out.push({ ...org, role: m.role });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok({ organisations: out });
}

export function updateOrganisation(ctx, orgId, input) {
  authorise(membershipOf(ctx, orgId), 'own');
  const org = assertBelongsToOrg({ ...ctx.db.get('organisation', orgId), org_id: orgId }, orgId);

  const updates = {}; const changes = {};
  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 120) throw new AccessError('invalid_name', 400);
    updates.name = name; changes.name = { from: org.name, to: name };
  }
  if (input.path !== undefined) {
    if (!PATHS.includes(input.path)) throw new AccessError('invalid_path', 400);
    updates.path = input.path; changes.path = { from: org.path, to: input.path };
  }
  if (!Object.keys(updates).length) throw new AccessError('nothing_to_update', 400);

  const updated = ctx.db.update('organisation', orgId, updates);
  audit(ctx, orgId, 'organisation.updated', 'organisation', orgId, changes);
  return ok({ organisation: updated });
}

// ────────────────────────────────────────────────────────────── data room ──

export const DATA_ROOM_FOLDERS = Object.freeze([
  ['01', 'Executive overview', true],
  ['02', 'Corporate and governance', true],
  ['03', 'Cap table and financing', true],
  ['04', 'Financials and forecast', true],
  ['05', 'Metrics and traction', false],
  ['06', 'Customers and market', false],
  ['07', 'Product, technology, IP and security', false],
  ['08', 'Team and operations', false],
  ['09', 'Legal, contracts and compliance', false],
  ['10', 'Process and Q&A log', false],
]);

export function seedDataRoom(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'write');
  if (ctx.db.count('data_room_node', { org_id: orgId }) > 0) {
    throw new AccessError('already_seeded', 409);
  }
  const now = ctx.now();
  for (const [sortKey, name, required] of DATA_ROOM_FOLDERS) {
    ctx.db.insert('data_room_node', {
      org_id: orgId, parent_id: null, sort_key: sortKey, name,
      required: required ? 1 : 0, stage: 'PRE_MEETING', created_at: now,
    });
  }
  audit(ctx, orgId, 'dataroom.seeded', 'organisation', orgId, { folders: DATA_ROOM_FOLDERS.length });
  return ok({ folders: DATA_ROOM_FOLDERS.length }, 201);
}

// ────────────────────────────────────────────────────────────────── facts ──

export function createFact(ctx, orgId, input) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = buildFact(input);
  const now = ctx.now();
  const fact = ctx.db.insert('fact', {
    org_id: orgId, ...row, ...confirmationStamp(row.source, ctx.auth.userId, now),
    superseded_by: null, created_by: ctx.auth.userId, created_at: now,
  });
  audit(ctx, orgId, 'fact.created', 'fact', fact.id, { fact_key: fact.fact_key, source: fact.source });
  return ok({ fact }, 201);
}

/** Corrections are never in-place. A new row is written; the old one points at it. */
export function supersedeFact(ctx, orgId, factId, input) {
  authorise(membershipOf(ctx, orgId), 'write');

  const previous = assertBelongsToOrg(ctx.db.get('fact', factId), orgId);
  if (previous.superseded_by) {
    throw new AccessError('already_superseded', 409, { superseded_by: previous.superseded_by });
  }

  const row = buildFact(input, previous);
  const now = ctx.now();
  const next = ctx.db.insert('fact', {
    org_id: orgId, ...row, ...confirmationStamp(row.source, ctx.auth.userId, now),
    superseded_by: null, created_by: ctx.auth.userId, created_at: now,
  });
  ctx.db.update('fact', factId, { superseded_by: next.id });
  audit(ctx, orgId, 'fact.superseded', 'fact', next.id, { superseded: factId, fact_key: next.fact_key });
  return ok({ fact: next, superseded_fact_id: factId }, 201);
}

export function listFacts(ctx, orgId) {
  const role = authorise(membershipOf(ctx, orgId), 'read');
  const all = ctx.db.find('fact', { org_id: orgId });
  return ok({
    my_role: role,
    facts: all.filter((f) => !f.superseded_by).sort((a, b) => a.fact_key.localeCompare(b.fact_key)),
    superseded: all.filter((f) => f.superseded_by),
  });
}

// ────────────────────────────────────────────────────────────── documents ──

/**
 * Issue a presigned upload ticket.
 *
 * The register row is created in state AWAITING_UPLOAD and is NOT a document
 * yet. An abandoned upload therefore leaves an obviously incomplete row that a
 * sweep can reclaim, rather than a row that looks like a real document pointing
 * at an object which never arrived.
 */
export function createUploadTicket(ctx, orgId, input, storage) {
  authorise(membershipOf(ctx, orgId), 'write');

  const filename = String(input.filename ?? '').trim();
  if (!filename) throw new AccessError('filename_required', 400);

  const sizeBytes = Number(input.size_bytes ?? 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new AccessError('invalid_size', 400);
  if (sizeBytes > MAX_UPLOAD_BYTES) throw new AccessError('file_too_large', 400);

  const kind = DOC_KINDS.includes(input.kind) ? input.kind : 'OTHER';
  const mimeType = String(input.mime_type ?? 'application/octet-stream');
  const docId = randomUUID();
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const storageKey = `orgs/${orgId}/documents/${docId}/${safeName}`;

  const now = ctx.now();
  const doc = ctx.db.insert('document', {
    id: docId, org_id: orgId, filename, mime_type: mimeType, storage_key: storageKey,
    size_bytes: Math.round(sizeBytes), kind, extract_state: 'AWAITING_UPLOAD',
    data_room_node_id: input.data_room_node_id ?? null,
    uploaded_by: ctx.auth.userId, uploaded_at: null, created_at: now,
  });
  audit(ctx, orgId, 'document.upload_ticket_issued', 'document', doc.id, { filename, size_bytes: doc.size_bytes });

  return ok({
    document: { id: doc.id, filename, kind },
    upload: storage.presignUpload(storageKey, { contentType: mimeType, expiresInSeconds: 600 }),
  }, 201);
}

/** Called by the client once the PUT succeeds. Only now is it a real document. */
export function confirmUpload(ctx, orgId, docId) {
  return usage.around(ctx, orgId, 'DOCUMENT_UPLOADED', () => doConfirmUpload(ctx, orgId, docId));
}

function doConfirmUpload(ctx, orgId, docId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const doc = assertBelongsToOrg(ctx.db.get('document', docId), orgId);
  const updated = ctx.db.update('document', docId, { extract_state: 'PENDING', uploaded_at: ctx.now() });
  audit(ctx, orgId, 'document.upload_confirmed', 'document', docId, { filename: doc.filename });
  recordMilestone(ctx, orgId, 'FIRST_DOCUMENT_CONFIRMED');
  return ok({ document: updated });
}

export function createDownloadUrl(ctx, orgId, docId, storage) {
  authorise(membershipOf(ctx, orgId), 'read');
  const doc = assertBelongsToOrg(ctx.db.get('document', docId), orgId);
  if (doc.extract_state === 'AWAITING_UPLOAD') throw new AccessError('upload_incomplete', 409);

  // §3.7 — every issue of a download URL is audited, including by viewers.
  audit(ctx, orgId, 'document.download_url_issued', 'document', docId, { filename: doc.filename });
  return ok({
    document: { id: doc.id, filename: doc.filename },
    download: storage.presignDownload(doc.storage_key, { expiresInSeconds: 300 }),
  });
}

export function deleteDocument(ctx, orgId, docId, storage) {
  authorise(membershipOf(ctx, orgId), 'own');
  const doc = assertBelongsToOrg(ctx.db.get('document', docId), orgId);
  storage.remove(doc.storage_key);
  ctx.db.remove('document', docId);
  audit(ctx, orgId, 'document.deleted', 'document', docId, { filename: doc.filename });
  return ok({ success: true });
}

// ──────────────────────────────────────────────────────────────── members ──

export function createInvite(ctx, orgId, input) {
  authorise(membershipOf(ctx, orgId), 'write');

  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AccessError('invalid_email', 400);
  const role = ['EDITOR', 'VIEWER'].includes(input.role) ? input.role : 'VIEWER';

  if (ctx.db.findOne('membership', { org_id: orgId, email })) {
    throw new AccessError('already_a_member', 409);
  }

  const live = ctx.db.find('invite', { org_id: orgId, email }).filter((i) => !i.claimed_at && !i.revoked_at);
  const invite = live.length
    ? ctx.db.update('invite', live[0].id, { role, invited_by: ctx.auth.userId })
    : ctx.db.insert('invite', { org_id: orgId, email, role, invited_by: ctx.auth.userId, created_at: ctx.now() });

  audit(ctx, orgId, 'invite.created', 'invite', invite.id, { email, role });

  // ──────────────────────────────────────────────────────────────────────────
  // DELIVERY, WHICH IS AN EXTRA RATHER THAN THE MECHANISM
  //
  // The invite is already recorded and already claimable by whoever next signs
  // up with that address — that is what `listOrganisations` does, and it worked
  // before this product could send mail at all. So a message here is a
  // convenience: without a provider, or with one that refuses, the invite is
  // still live and the roster page still shows it to be passed on by hand.
  //
  // Which is why the send is not awaited and its failure is not raised. This
  // function is synchronous by contract, the caller has already been told the
  // invite exists, and turning a provider outage into a failed invitation would
  // discard a row that is perfectly good.
  if (ctx.emailer) {
    const org = ctx.db.get('organisation', orgId);
    const inviter = ctx.auth?.userId ? ctx.db.get('user_account', ctx.auth.userId) : null;
    try {
      const message = invitation({
        to: email,
        baseUrl: ctx.baseUrl ?? '',
        organisation: org?.name ?? '',
        invitedBy: inviter?.name ?? null,
      });
      Promise.resolve()
        .then(() => ctx.emailer.send(message))
        .catch((err) => {
          console.error(`[email] invitation not accepted by the provider: ${err?.code ?? 'unknown'}`);
        });
    } catch (err) {
      // A message that cannot even be composed — no BASE_URL, say — is a
      // deployment fault, not a reason to refuse somebody's invitation.
      console.error(`[email] invitation could not be composed: ${err?.code ?? 'unknown'}`);
    }
  }

  return ok({ invite }, 201);
}

export function changeMemberRole(ctx, orgId, membershipId, newRole) {
  authorise(membershipOf(ctx, orgId), 'own');
  if (!ROLES.includes(newRole)) throw new AccessError('invalid_role', 400);

  const target = assertBelongsToOrg(ctx.db.get('membership', membershipId), orgId);
  assertNotLastOwner(target, ctx.db.count('membership', { org_id: orgId, role: 'OWNER' }), { toRole: newRole });

  const updated = ctx.db.update('membership', membershipId, { role: newRole });
  audit(ctx, orgId, 'membership.role_changed', 'membership', membershipId, { from: target.role, to: newRole });
  return ok({ member: updated });
}

export function removeMember(ctx, orgId, membershipId) {
  authorise(membershipOf(ctx, orgId), 'own');

  const target = assertBelongsToOrg(ctx.db.get('membership', membershipId), orgId);
  assertNotLastOwner(target, ctx.db.count('membership', { org_id: orgId, role: 'OWNER' }));

  ctx.db.remove('membership', membershipId);
  audit(ctx, orgId, 'membership.removed', 'membership', membershipId, { user_id: target.user_id });
  return ok({ success: true });
}

export function listMembers(ctx, orgId) {
  const role = authorise(membershipOf(ctx, orgId), 'read');
  return ok({
    my_role: role,
    members: ctx.db.find('membership', { org_id: orgId }),
    pending_invites: ctx.db.find('invite', { org_id: orgId }).filter((i) => !i.claimed_at && !i.revoked_at),
  });
}

export function listAudit(ctx, orgId, { limit = 50 } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const rows = ctx.db.find('audit_log', { org_id: orgId })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return ok({ entries: rows.slice(0, Math.min(Math.max(limit, 1), 200)) });
}

export { AccessError, FactError };
