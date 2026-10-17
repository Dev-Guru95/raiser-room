/**
 * Phase 8 — live sharing.
 *
 * Two surfaces live in this file and they are not the same thing:
 *
 *   · the OWNER surface, which goes through `authorise` like everything else;
 *   · the RECIPIENT surface, which is reached by a token and has no membership
 *     at all.
 *
 * They are kept visibly apart below, because the failure mode is an owner-only
 * check drifting into the recipient path, or a recipient function quietly
 * gaining the ability to read something nobody granted. Every recipient
 * function starts by resolving the token and taking the access decision, and
 * does nothing before it.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import {
  mintToken, hashToken, looksLikeToken, accessDecision, resolveExpiry,
  visibleFolders, watermarkSpec, downloadPosture, similarQuestions,
  consistencyWarning, notificationDraft, shareMode,
  SHARE_MODES, SUBJECT_KINDS, DEFAULT_EXPIRY_DAYS, ShareError,
} from '../domain/sharing.js';
import { visibleAtStage, STAGES, STAGE_MEANING } from '../domain/dataroom.js';
import { regenerationDiff } from '../domain/freshness.js';
import { getRoom } from './dataroom.js';
import { markReleased } from './freshness.js';
import { requireEntitlement } from './billing.js';
import { ILLUSTRATIVE_MARKER_KEY } from '../domain/illustrative.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth?.userId ?? 'recipient', action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

// ════════════════════════════════════════════════════ OWNER SURFACE ══

/**
 * Create a link for one named recipient.
 *
 * The raw token is returned exactly once. It is not stored and cannot be
 * recovered — if the user loses it, they issue a new link, which is also the
 * behaviour that makes "who has access" answerable.
 */
export function createShare(ctx, orgId, input = {}) {
  return usage.around(ctx, orgId, 'SHARE_CREATED', () => doCreateShare(ctx, orgId, input));
}

function doCreateShare(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  // Issuing a link is a write. A link already issued keeps working — a
  // subscription lapsing must not cut off an investor mid-diligence.
  requireEntitlement(ctx, orgId, 'LIVE_SHARING');
  const now = ctx.now();

  const kind = SUBJECT_KINDS.includes(input.subject_kind) ? input.subject_kind : null;
  if (!kind) throw new ShareError('invalid_subject', `subject_kind must be one of ${SUBJECT_KINDS.join(', ')}`);

  const mode = shareMode(input.share_mode) ? input.share_mode : 'PINNED';

  const recipient = String(input.recipient_name ?? '').trim();
  if (recipient.length < 2) {
    throw new ShareError('recipient_required',
      'Name the recipient. A link issued to nobody in particular cannot be withdrawn from anybody in '
      + 'particular, and the access record is the point.');
  }

  let artifactId = null;
  if (kind === 'ARTIFACT') {
    const artifact = assertBelongsToOrg(ctx.db.get('artifact', input.artifact_id), orgId);
    if (artifact.state === 'BLOCKED') {
      throw new ShareError('not_generated', 'this artifact was blocked and never produced', 409);
    }
    artifactId = artifact.id;
  }

  let stage = null;
  if (kind === 'ROOM') {
    stage = input.stage;
    if (!STAGES.includes(stage)) {
      throw new ShareError('invalid_stage',
        `A room link must say which stage the recipient is at: ${STAGES.join(', ')}. `
        + 'Deciding that at the point of a request produces inconsistent disclosure.');
    }
  }

  const { token, token_hash, token_prefix } = mintToken();

  const share = ctx.db.insert('share', {
    org_id: orgId, subject_kind: kind, artifact_id: artifactId, share_mode: mode,
    recipient_name: recipient, recipient_org: input.recipient_org ?? null, stage,
    token_hash, token_prefix,
    allow_download: input.allow_download === false ? 0 : 1,
    expires_at: resolveExpiry(input.expires_at, now),
    revoked_at: null, revoked_by: null, revoke_reason: null, last_published_at: null,
    created_by: ctx.auth.userId, created_at: now,
  });

  // Sharing IS releasing. Phase 7 grades a stale document by whether anyone
  // outside the company holds it, and this is the moment that becomes true.
  if (artifactId) {
    const artifact = ctx.db.get('artifact', artifactId);
    if (!artifact.released_at) {
      markReleased(ctx, orgId, artifactId, {
        note: `Shared with ${recipient}${input.recipient_org ? ` (${input.recipient_org})` : ''}`,
      });
    }
  }

  audit(ctx, orgId, 'share.created', 'share', share.id, {
    kind, recipient, mode, stage, expires_at: share.expires_at,
  });

  return ok({
    share: present(share),
    // Said once, clearly, because there is no second chance to show it.
    token,
    token_note: 'This link is shown once and is not stored anywhere it can be read back. If it is '
      + 'lost, revoke it and issue another — which is also what keeps the access record honest.',
    mode: shareMode(mode),
    download: downloadPosture(share.allow_download === 1),
  }, 201);
}

/** Withdraw access, immediately. */
export function revokeShare(ctx, orgId, shareId, { reason } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const share = assertBelongsToOrg(ctx.db.get('share', shareId), orgId);
  if (share.revoked_at) throw new ShareError('already_revoked', 'this link is already withdrawn', 409);

  const updated = ctx.db.update('share', shareId, {
    revoked_at: ctx.now(), revoked_by: ctx.auth.userId,
    revoke_reason: String(reason ?? '').trim() || null,
  });
  audit(ctx, orgId, 'share.revoked', 'share', shareId, { recipient: share.recipient_name, reason });

  return ok({
    share: present(updated),
    note: 'The link stops working immediately. Anything already downloaded is still out there — a '
        + 'withdrawal ends access, it does not recall a copy.',
  });
}

export function listShares(ctx, orgId, { includeInactive = true } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const now = ctx.now();

  let rows = ctx.db.find('share', { org_id: orgId });
  if (!includeInactive) {
    rows = rows.filter((s) => !s.revoked_at && String(now).localeCompare(String(s.expires_at)) <= 0);
  }

  return ok({
    shares: rows
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((s) => {
        const views = ctx.db.find('share_view', { share_id: s.id });
        return {
          ...present(s),
          state: stateOf(s, now),
          views: views.length,
          last_opened_at: views.map((v) => v.opened_at).sort().at(-1) ?? null,
          questions: ctx.db.count('share_question', { share_id: s.id }),
        };
      }),
    modes: SHARE_MODES,
  });
}

const stateOf = (share, now) => {
  if (share.revoked_at) return 'REVOKED';
  if (String(now).localeCompare(String(share.expires_at)) > 0) return 'EXPIRED';
  return 'ACTIVE';
};

function present(share) {
  return {
    id: share.id, subject_kind: share.subject_kind, artifact_id: share.artifact_id,
    share_mode: share.share_mode, recipient_name: share.recipient_name,
    recipient_org: share.recipient_org, stage: share.stage,
    // The prefix only. The hash is never returned, because there is no reason
    // for it to leave the database and every reason for it not to.
    token_prefix: share.token_prefix,
    allow_download: share.allow_download === 1,
    expires_at: share.expires_at, revoked_at: share.revoked_at, revoke_reason: share.revoke_reason,
    last_published_at: share.last_published_at, created_at: share.created_at,
  };
}

/**
 * Who is holding a version that has been superseded, and what to say to them.
 *
 * A PINNED share keeps serving what was sent until the owner publishes the
 * update. This is the list of people that applies to, with the message already
 * written.
 */
export function pendingUpdates(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const org = ctx.db.get('organisation', orgId);
  const factsById = new Map(ctx.db.find('fact', { org_id: orgId }).map((f) => [f.id, f]));
  const now = ctx.now();

  const pending = [];
  for (const share of ctx.db.find('share', { org_id: orgId })) {
    if (share.subject_kind !== 'ARTIFACT' || stateOf(share, now) !== 'ACTIVE') continue;
    if (share.share_mode !== 'PINNED') continue;

    const pinned = ctx.db.get('artifact', share.artifact_id);
    if (!pinned) continue;

    const successor = pinned.superseded_by ? ctx.db.get('artifact', pinned.superseded_by) : null;
    const diff = regenerationDiff(pinned, factsById);
    if (!successor && !diff.figures_moving) continue;

    pending.push({
      share: present(share),
      pinned_artifact_id: pinned.id,
      current_artifact_id: successor?.id ?? null,
      figures_moving: diff.figures_moving,
      changes: diff.changes,
      draft: notificationDraft(share, {
        changes: diff.changes, company: org.name, artifactTitle: pinned.title,
      }),
    });
  }

  return ok({
    pending,
    count: pending.length,
    headline: pending.length
      ? `${pending.length} recipient${pending.length === 1 ? ' is' : 's are'} holding a version that `
        + 'has since been superseded.'
      : null,
  });
}

/**
 * Publish an update to a pinned share.
 *
 * A deliberate act. Until it happens the recipient keeps seeing what they were
 * sent, which is the whole point of PINNED — and after it happens they are
 * owed the message that `pendingUpdates` already wrote.
 */
export function publishUpdate(ctx, orgId, shareId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const share = assertBelongsToOrg(ctx.db.get('share', shareId), orgId);
  if (share.subject_kind !== 'ARTIFACT') throw new ShareError('not_an_artifact_share', 'only artifact links pin a version', 409);
  if (share.share_mode !== 'PINNED') throw new ShareError('not_pinned', 'this link already follows the latest version', 409);

  const pinned = ctx.db.get('artifact', share.artifact_id);
  const successor = pinned?.superseded_by ? ctx.db.get('artifact', pinned.superseded_by) : null;
  if (!successor) throw new ShareError('nothing_to_publish', 'there is no newer version of this document', 409);

  const now = ctx.now();
  const updated = ctx.db.update('share', shareId, {
    artifact_id: successor.id, last_published_at: now,
  });

  if (!successor.released_at) {
    markReleased(ctx, orgId, successor.id, { note: `Published to ${share.recipient_name}` });
  }

  audit(ctx, orgId, 'share.update_published', 'share', shareId, {
    from: pinned.id, to: successor.id, recipient: share.recipient_name,
  });

  return ok({
    share: present(updated),
    reminder: `${share.recipient_name} now sees the new version. Tell them it changed — the link will `
      + 'not do it for you, and a counterparty who notices a figure move without being told weighs '
      + 'what else might have moved quietly.',
  });
}

// ════════════════════════════════════════════════ RECIPIENT SURFACE ══
//
// No membership. No `authorise`. Everything below starts from a token and
// nothing is read before the access decision is taken.

/** Resolve a token to a share, or to nothing. Never reveals why. */
function resolveToken(ctx, token) {
  if (!looksLikeToken(token)) return null;
  return ctx.db.findOne('share', { token_hash: hashToken(token) });
}

/**
 * Which version of an artifact a share shows.
 *
 * PINNED does not move: the recipient keeps seeing what they were sent until
 * the owner deliberately publishes an update to them. FOLLOW_LATEST resolves
 * forward through supersession, with a seen-set because a cycle in the chain
 * would otherwise hang the request rather than return a wrong answer — and of
 * the two, hanging is the one nobody debugs.
 *
 * One function, used by both the page and the document behind it. Written
 * twice, they drifted the moment the second one was added: a mutation that
 * made PINNED silently follow the latest broke only the first copy and was
 * still reported as caught.
 */
function versionFor(ctx, share) {
  let artifact = share.artifact_id ? ctx.db.get('artifact', share.artifact_id) : null;
  if (!artifact || share.share_mode !== 'FOLLOW_LATEST') return artifact;

  const seen = new Set([artifact.id]);
  while (artifact?.superseded_by && !seen.has(artifact.superseded_by)) {
    seen.add(artifact.superseded_by);
    artifact = ctx.db.get('artifact', artifact.superseded_by) ?? artifact;
  }
  return artifact;
}

/**
 * Open a shared document or room.
 *
 * @param {object} ctx  needs { db, now }. `auth` is NOT used and must not be.
 */
export function openShare(ctx, token, { clientFamily = null } = {}) {
  const now = ctx.now();
  const share = resolveToken(ctx, token);
  const decision = accessDecision(share, { now });

  if (!decision.allowed) {
    // A refusal is logged against the organisation when there is one to log
    // against. A token that resolves to nothing has no organisation, and
    // inventing somewhere to record it would be guessing.
    if (share) {
      audit({ ...ctx, auth: { userId: 'recipient' } }, share.org_id, 'share.access_refused',
        'share', share.id, { code: decision.code, recipient: share.recipient_name });
    }
    // Counted against the organisation that owns the link, not against the
    // recipient — there is no account on the other end of a share link, and the
    // useful fact is that somebody's link refused somebody, which is a thing the
    // sender would want fixed. A token resolving to nothing is counted nowhere,
    // for the same reason it is audited nowhere.
    if (share) usage.record(ctx, share.org_id, 'SHARE_OPENED', { outcome: 'REFUSED' });
    return { status: decision.status, body: { allowed: false, code: decision.code, says: decision.says } };
  }

  usage.record(ctx, share.org_id, 'SHARE_OPENED');

  const org = ctx.db.get('organisation', share.org_id);

  const artifact = versionFor(ctx, share);

  const view = ctx.db.insert('share_view', {
    org_id: share.org_id, share_id: share.id, artifact_id: artifact?.id ?? null,
    opened_at: now, closed_at: null, duration_seconds: null,
    client_family: clientFamily, created_at: now,
  });

  audit({ ...ctx, auth: { userId: 'recipient' } }, share.org_id, 'share.opened', 'share', share.id, {
    recipient: share.recipient_name, artifact_id: artifact?.id ?? null, view_id: view.id,
  });

  const body = {
    allowed: true,
    view_id: view.id,
    company: org?.name ?? null,
    recipient: share.recipient_name,
    // ──────────────────────────────────────────────────────────────────────
    // THE RECIPIENT IS THE PERSON WHO MOST NEEDS TO BE TOLD
    //
    // A worked-example organisation can issue links like any other, and the
    // demonstration deployment issues two. The person following one has never
    // seen this product, has no account, and has no way at all to know the
    // figures in front of them are invented — they are looking at what appears
    // to be a company's data room, sent to them by name.
    //
    // The owner-facing pages carry the notice because somebody inside the
    // company might screenshot one. This matters more, not less.
    illustrative: Boolean(
      ctx.db.findOne('fact', { org_id: share.org_id, fact_key: ILLUSTRATIVE_MARKER_KEY }),
    ),
    // The two things a reader is entitled to know on every single view.
    as_at: artifact?.generated_at ?? share.created_at,
    mode: shareMode(share.share_mode),
    expires_at: share.expires_at,
    watermark: watermarkSpec(share, { now, company: org?.name }),
    download: downloadPosture(share.allow_download === 1),
  };

  if (share.subject_kind === 'ARTIFACT') {
    body.document = artifact
      ? { id: artifact.id, title: artifact.title, kind: artifact.artifact_kind }
      : null;
    body.updated_since_sent = !!(share.last_published_at);
  } else {
    // A room link shows only what the recipient's stage allows, decided when
    // the link was made rather than when a request arrives.
    const room = roomForShare(ctx, share);
    body.room = room;
    body.stage = { id: share.stage, means: STAGE_MEANING[share.stage] };
  }

  return ok(body);
}

function roomForShare(ctx, share) {
  const owner = { ...ctx, auth: { userId: share.created_by } };
  const room = getRoom(owner, share.org_id).body;
  const visible = visibleFolders(room.folders, share, visibleAtStage);

  return {
    folders: visible.map((f) => ({
      key: f.key, name: f.name,
      items: f.items
        .filter((i) => i.state === 'PRESENT')
        .map((i) => ({ ref: i.ref, name: i.name, document_id: i.document_id })),
    })),
    withheld_count: room.folders.length - visible.length,
    // Said rather than hidden. A counterparty who can see that four folders
    // exist and are not open to them at this stage is better informed than one
    // who cannot tell whether they are missing or empty.
    note: 'Some folders open at later stages of a process.',
  };
}

/** Record that a view ended. Gives the access log a duration rather than a timestamp. */
export function closeShareView(ctx, token, viewId) {
  const share = resolveToken(ctx, token);
  const decision = accessDecision(share, { now: ctx.now() });
  if (!decision.allowed) return { status: decision.status, body: { allowed: false, code: decision.code } };

  const view = ctx.db.get('share_view', viewId);
  if (!view || view.share_id !== share.id) throw new ShareError('view_not_found', 'no such view', 404);
  if (view.closed_at) return ok({ view });

  const now = ctx.now();
  const seconds = Math.max(0, Math.round((Date.parse(now) - Date.parse(view.opened_at)) / 1000));
  return ok({ view: ctx.db.update('share_view', viewId, { closed_at: now, duration_seconds: seconds }) });
}

/** A recipient asks a question. */
export function askThroughShare(ctx, token, { question } = {}) {
  const share = resolveToken(ctx, token);
  const decision = accessDecision(share, { now: ctx.now() });
  if (!decision.allowed) return { status: decision.status, body: { allowed: false, code: decision.code } };

  const text = String(question ?? '').trim();
  if (text.length < 5) throw new ShareError('question_too_short', 'a question needs a few words');

  const now = ctx.now();
  const row = ctx.db.insert('share_question', {
    org_id: share.org_id, share_id: share.id, question: text, asked_at: now,
    answer: null, answered_at: null, answered_by: null, similar_to: null, created_at: now,
  });

  audit({ ...ctx, auth: { userId: 'recipient' } }, share.org_id, 'share.question_asked',
    'share_question', row.id, { recipient: share.recipient_name });

  usage.record(ctx, share.org_id, 'SHARE_QUESTION_ASKED');

  return ok({
    question: { id: row.id, question: row.question, asked_at: row.asked_at },
    note: 'Recorded. Questions and answers are logged so that everyone involved is told the same thing.',
  }, 201);
}

/**
 * Read a generated document through a share link.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HERE AND NOT IN THE WEB LAYER
 *
 * A recipient has no membership, so `readGenerated` cannot serve them — it
 * authorises on membership and would refuse. The tempting shortcut is for the
 * HTTP handler to resolve the token itself and then read the artifact as the
 * owner. That puts an authorisation decision in a request handler, which is
 * where every authorisation bug in this product's predecessor lived.
 *
 * So the decision stays here, next to the one that governs opening a link at
 * all, and uses the same `accessDecision`. The only thing this adds on top is
 * which artifact a share may show:
 *
 *   · An ARTIFACT share may show its own artifact, resolved forward through
 *     supersession when the mode follows the latest and not otherwise.
 *   · A ROOM share may show nothing. A room link is an index of source
 *     documents, not a licence to read anything the company has generated.
 *
 * A caller cannot pass an artifact id of its own choosing; the share decides.
 */
export function readThroughShare(ctx, token) {
  const share = resolveToken(ctx, token);
  const decision = accessDecision(share, { now: ctx.now() });
  if (!decision.allowed) {
    return { status: decision.status, body: { allowed: false, code: decision.code, says: decision.says } };
  }

  if (share.subject_kind !== 'ARTIFACT' || !share.artifact_id) {
    throw new ShareError('not_a_document_link',
      'This link is an index of the data room, not a document. There is nothing to render.', 409);
  }

  const artifact = versionFor(ctx, share);

  if (!artifact || artifact.org_id !== share.org_id) {
    throw new ShareError('document_missing', 'the document behind this link is not there', 404);
  }
  if (!artifact.generated_at) {
    throw new ShareError('not_generated',
      'the document behind this link has not been generated', 409);
  }

  const org = ctx.db.get('organisation', share.org_id);
  const bytes = artifact.html_key && ctx.storage?.get ? ctx.storage.get(artifact.html_key) : null;

  audit({ ...ctx, auth: { userId: 'recipient' } }, share.org_id, 'share.document_read',
    'artifact', artifact.id, { recipient: share.recipient_name, share_id: share.id });

  return ok({
    allowed: true,
    html: bytes ? bytes.toString('utf8') : null,
    document: { id: artifact.id, title: artifact.title, kind: artifact.artifact_kind },
    // The document carries the notice in its own markup, on every page, put
    // there when it was generated. Reported here as well so the page around it
    // does not have to guess.
    illustrative: Boolean(
      ctx.db.findOne('fact', { org_id: share.org_id, fact_key: ILLUSTRATIVE_MARKER_KEY }),
    ),
    as_at: artifact.generated_at,
    // The recipient is told the version is fixed or moving, in the same words
    // the owner chose when issuing the link. They are not told it is stale:
    // staleness is the owner's business, and "the figures behind this have
    // moved" is the owner's sentence to say, not the product's to leak.
    mode: shareMode(share.share_mode),
    watermark: watermarkSpec(share, { now: ctx.now(), company: org?.name }),
    download: downloadPosture(share.allow_download === 1),
  });
}

// ══════════════════════════════════════════ OWNER SURFACE, continued ══

/**
 * The question log — criterion 8.4, satisfied by using the product.
 */
export function questionLog(ctx, orgId, { unansweredOnly = false } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const shares = new Map(ctx.db.find('share', { org_id: orgId }).map((s) => [s.id, s]));

  let rows = ctx.db.find('share_question', { org_id: orgId });
  if (unansweredOnly) rows = rows.filter((q) => !q.answer);

  return ok({
    questions: rows
      .sort((a, b) => String(b.asked_at).localeCompare(String(a.asked_at)))
      .map((q) => ({
        id: q.id, question: q.question, asked_at: q.asked_at,
        asked_by: shares.get(q.share_id)?.recipient_name ?? 'a recipient',
        asked_by_org: shares.get(q.share_id)?.recipient_org ?? null,
        answer: q.answer, answered_at: q.answered_at, answered_by: q.answered_by,
      })),
    unanswered: rows.filter((q) => !q.answer).length,
    basis: 'Every answer given to any party, recorded. An inconsistency between two answers is more '
         + 'damaging than either answer being imperfect.',
  });
}

/**
 * Draft an answer, and see what was already said to somebody else.
 *
 * Read-only: it exists so the consistency check happens BEFORE the answer is
 * committed, which is the only point at which it is useful.
 */
export function draftAnswer(ctx, orgId, questionId, { answer } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const question = assertBelongsToOrg(ctx.db.get('share_question', questionId), orgId);

  const previous = ctx.db.find('share_question', { org_id: orgId })
    .filter((q) => q.id !== questionId && q.answer);
  const similar = similarQuestions(question.question, previous);

  return ok({
    question: { id: question.id, question: question.question },
    similar,
    warning: answer ? consistencyWarning(answer, similar) : null,
  });
}

/** Answer a question. The answer goes to the recipient who asked. */
export function answerQuestion(ctx, orgId, questionId, input = {}) {
  return usage.around(ctx, orgId, 'QUESTION_ANSWERED', () => doAnswerQuestion(ctx, orgId, questionId, input));
}

function doAnswerQuestion(ctx, orgId, questionId, { answer } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const question = assertBelongsToOrg(ctx.db.get('share_question', questionId), orgId);
  if (question.answer) throw new ShareError('already_answered', 'this question has been answered', 409);

  const text = String(answer ?? '').trim();
  if (text.length < 5) throw new ShareError('answer_too_short', 'an answer needs a few words');

  const previous = ctx.db.find('share_question', { org_id: orgId })
    .filter((q) => q.id !== questionId && q.answer);
  const similar = similarQuestions(question.question, previous);

  const now = ctx.now();
  const updated = ctx.db.update('share_question', questionId, {
    answer: text, answered_at: now, answered_by: ctx.auth.userId,
    similar_to: similar[0]?.id ?? null,
  });

  audit(ctx, orgId, 'share.question_answered', 'share_question', questionId,
    { similar_to: similar[0]?.id ?? null });

  return ok({
    question: updated,
    // Reported, never blocking. Deciding whether two prose answers mean the
    // same thing is a judgement, and a product that made it would be wrong
    // often and confidently.
    warning: consistencyWarning(text, similar),
  });
}

/**
 * The access record — criterion 8.3.
 *
 * Who has access, what they received, and when they looked.
 */
export function accessRecord(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const now = ctx.now();
  const shares = ctx.db.find('share', { org_id: orgId });
  const views = ctx.db.find('share_view', { org_id: orgId });

  const rows = shares.map((s) => {
    const mine = views.filter((v) => v.share_id === s.id);
    const total = mine.reduce((sum, v) => sum + (v.duration_seconds ?? 0), 0);
    return {
      recipient: s.recipient_name, recipient_org: s.recipient_org,
      subject: s.subject_kind, stage: s.stage,
      state: stateOf(s, now),
      granted_at: s.created_at, expires_at: s.expires_at, revoked_at: s.revoked_at,
      opens: mine.length,
      first_opened_at: mine.map((v) => v.opened_at).sort()[0] ?? null,
      last_opened_at: mine.map((v) => v.opened_at).sort().at(-1) ?? null,
      total_seconds: total,
      versions_seen: [...new Set(mine.map((v) => v.artifact_id).filter(Boolean))].length,
    };
  });

  return ok({
    access: rows.sort((a, b) => String(b.granted_at).localeCompare(String(a.granted_at))),
    active: rows.filter((r) => r.state === 'ACTIVE').length,
    never_opened: rows.filter((r) => r.opens === 0).length,
    criterion: '8.3',
    privacy_note: 'No IP addresses are recorded. The recipient is already identified by the link they '
      + 'were given, so an address would add nothing to the record while creating personal data the '
      + 'company would then have to account for.',
  });
}

export { ShareError, DEFAULT_EXPIRY_DAYS };
