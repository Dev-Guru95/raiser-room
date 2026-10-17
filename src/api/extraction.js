/**
 * Phase 3 — document extraction, the confirmation screen, and conflicts.
 *
 * The confirmation step is the most important thing in this phase. Everything
 * else here exists to make sure a figure a machine read cannot reach the fact
 * store without a named human saying so, at a recorded time, with the source
 * in front of them.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { buildFact, confirmationStamp, usableFacts } from '../domain/facts.js';
import {
  classifyDocument, extractabilityOf, normaliseCandidate, candidateToFactInput,
  hasEdits, reviewProgress, assertBulkConfirmable, isDecided, ExtractionError,
} from '../domain/extraction.js';
import {
  detectConflicts, validateResolution, conflictSummary, unresolvedBlockers,
  CONFLICT_SOURCE, crossKeyRule,
} from '../domain/conflicts.js';
import { parseTransferSheet, isEmptySheet, TRANSFER_SHEET_VERSION } from '../domain/transfer-sheet.js';
import { assertExtractor } from '../extract/interface.js';
import { recordMilestone } from './timing.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

const docLabels = (ctx, orgId) =>
  Object.fromEntries(ctx.db.find('document', { org_id: orgId }).map((d) => [d.id, d.filename]));

// ───────────────────────────────────────────────────────────── classification ──

/** What kind of document is this? Reported with its basis, never applied silently. */
export function suggestKind(ctx, orgId, docId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const doc = assertBelongsToOrg(ctx.db.get('document', docId), orgId);
  return ok({
    document: { id: doc.id, filename: doc.filename, kind: doc.kind },
    suggestion: classifyDocument({ filename: doc.filename, mimeType: doc.mime_type }),
  });
}

// ──────────────────────────────────────────────────────────────── extraction ──

/**
 * Run an extraction over a confirmed upload.
 *
 * Order matters here: probe first, decide honestly whether the file is readable,
 * and only then ask the extractor for candidates. Running the extractor over a
 * scan and filtering the output afterwards is how confident nonsense gets in —
 * by then there is a plausible-looking number with a page reference attached.
 */
export async function runExtraction(ctx, orgId, docId, extractor, options = {}) {
  return usage.aroundAsync(ctx, orgId, 'EXTRACTION_RUN', () => doRunExtraction(ctx, orgId, docId, extractor, options));
}

async function doRunExtraction(ctx, orgId, docId, extractor, { kind = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  assertExtractor(extractor);

  const doc = assertBelongsToOrg(ctx.db.get('document', docId), orgId);
  if (!doc.uploaded_at) throw new AccessError('upload_incomplete', 409);

  const open = ctx.db.find('extraction', { document_id: docId })
    .find((e) => e.state === 'RUNNING' || e.state === 'NEEDS_REVIEW');
  if (open) {
    throw new ExtractionError('extraction_in_progress',
      'This document already has an extraction awaiting review. Finish that one first — two runs over '
      + 'the same file would put the same figure in front of you twice.', 409);
  }

  const resolved = classifyDocument({
    filename: doc.filename, mimeType: doc.mime_type, declaredKind: kind ?? doc.kind,
  });

  const now = ctx.now();
  const run = ctx.db.insert('extraction', {
    org_id: orgId, document_id: docId,
    extractor_id: extractor.id, extractor_version: extractor.version,
    doc_kind: resolved.kind, state: 'RUNNING', unsupported_reason: null,
    pages: null, text_characters: null, candidate_count: 0,
    started_at: now, finished_at: null, reviewed_at: null, reviewed_by: null, created_at: now,
  });

  // ── probe ──
  let probe;
  try {
    probe = await extractor.probe({ storageKey: doc.storage_key, mimeType: doc.mime_type });
  } catch (err) {
    return fail(ctx, orgId, run, doc, 'probe_failed', err);
  }

  const readable = extractabilityOf({
    mimeType: doc.mime_type,
    pages: probe?.pages ?? null,
    textCharacters: probe?.textCharacters ?? null,
    encrypted: !!probe?.encrypted,
  });

  if (!readable.supported) {
    const updated = ctx.db.update('extraction', run.id, {
      state: 'UNSUPPORTED', unsupported_reason: readable.reason,
      pages: probe?.pages ?? null, text_characters: probe?.textCharacters ?? null,
      finished_at: ctx.now(),
    });
    ctx.db.update('document', docId, { extract_state: 'UNSUPPORTED' });
    audit(ctx, orgId, 'extraction.unsupported', 'document', docId,
      { reason: readable.reason, extractor: extractor.id });

    return ok({
      extraction: updated,
      supported: false,
      reason: readable.reason,
      // Said plainly to the user, rather than a silent empty result that reads
      // as "there was nothing in this document".
      message: readable.message,
      candidates: [],
    }, 200);
  }

  // ── extract ──
  let result;
  try {
    result = await extractor.extract({
      storageKey: doc.storage_key, mimeType: doc.mime_type,
      kind: resolved.kind, pages: probe?.pages ?? null,
    });
  } catch (err) {
    return fail(ctx, orgId, run, doc, 'extract_failed', err);
  }

  const rejected = [];
  const stored = [];
  const nowAfter = ctx.now();

  for (const raw of result?.candidates ?? []) {
    let row;
    try {
      row = normaliseCandidate(raw, { documentId: docId, extractionId: run.id });
    } catch (err) {
      // One malformed candidate does not discard the run — but it is reported,
      // never dropped silently. A silently dropped candidate is a figure the
      // user believes was considered and was not.
      rejected.push({ candidate: raw?.fact_key ?? '(no key)', code: err.code, problem: err.message });
      continue;
    }
    stored.push(ctx.db.insert('extraction_candidate', { org_id: orgId, ...row, created_at: nowAfter }));
  }

  const updated = ctx.db.update('extraction', run.id, {
    state: stored.length ? 'NEEDS_REVIEW' : 'REVIEWED',
    pages: probe?.pages ?? null, text_characters: probe?.textCharacters ?? null,
    candidate_count: stored.length,
    finished_at: nowAfter,
    reviewed_at: stored.length ? null : nowAfter,
    reviewed_by: stored.length ? null : ctx.auth.userId,
  });
  ctx.db.update('document', docId, { extract_state: stored.length ? 'NEEDS_REVIEW' : 'REVIEWED' });

  const conflicts = recordConflicts(ctx, orgId, stored);

  audit(ctx, orgId, 'extraction.completed', 'document', docId, {
    extractor: extractor.id, extractor_version: extractor.version,
    candidates: stored.length, rejected: rejected.length, conflicts: conflicts.length,
  });

  return ok({
    extraction: updated,
    supported: true,
    candidates: stored,
    rejected_candidates: rejected,
    conflicts,
    // Stated on every run so it is never implied that anything here is a fact.
    note: 'Nothing has been added to your records. Every figure below is waiting for you to confirm it.',
  }, 201);
}

function fail(ctx, orgId, run, doc, code, err) {
  ctx.db.update('extraction', run.id, { state: 'FAILED', finished_at: ctx.now() });
  ctx.db.update('document', doc.id, { extract_state: 'FAILED' });
  audit(ctx, orgId, 'extraction.failed', 'document', doc.id, { code, detail: String(err?.message ?? err) });
  throw new ExtractionError(code, `The extractor could not read this document: ${err?.message ?? err}`, 502);
}

// ────────────────────────────────────────────────────────── the review screen ──

/**
 * Serve the candidates for review, and stamp them as seen.
 *
 * `viewed_at` is set here, on the server, when the rows are handed to a client.
 * It is what `assertBulkConfirmable` checks, so bulk confirm can only ever
 * accept figures that were actually put in front of somebody. A flag the client
 * sets would be a promise; this is a record.
 */
export function getExtraction(ctx, orgId, extractionId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const run = assertBelongsToOrg(ctx.db.get('extraction', extractionId), orgId);
  const doc = assertBelongsToOrg(ctx.db.get('document', run.document_id), orgId);

  const candidates = ctx.db.find('extraction_candidate', { extraction_id: extractionId });
  const now = ctx.now();
  const seen = candidates.map((c) =>
    (c.viewed_at || isDecided(c.state) ? c : ctx.db.update('extraction_candidate', c.id, { viewed_at: now })));

  const conflicts = ctx.db.find('conflict', { org_id: orgId }).filter((c) => !c.resolved_at);
  const byRef = new Map();
  for (const c of conflicts) {
    for (const ref of [c.left_ref, c.right_ref]) {
      if (!ref.startsWith('candidate:')) continue;
      const id = ref.slice('candidate:'.length);
      if (!byRef.has(id)) byRef.set(id, []);
      byRef.get(id).push(c);
    }
  }

  return ok({
    extraction: run,
    document: { id: doc.id, filename: doc.filename, kind: doc.kind },
    unsupported_reason: run.unsupported_reason,
    candidates: seen.map((c) => ({
      ...c,
      conflicts: byRef.get(c.id) ?? [],
      // Repeated per row, because this is the screen where somebody is about to
      // click forty times.
      what_this_means: 'Read this against the source shown, then confirm, correct or reject it.',
    })),
    progress: reviewProgress(seen),
  });
}

/**
 * Decide one candidate.
 *
 * `decision` is 'CONFIRM' or 'REJECT'. A confirm with `edits` records
 * EDITED_CONFIRMED and writes the reviewer's value, leaving the original
 * extraction visible on the candidate row — so what the machine said and what
 * the human corrected it to are both permanently on the record.
 */
export function decideCandidate(ctx, orgId, candidateId, input = {}) {
  return usage.around(ctx, orgId, 'EXTRACTION_DECIDED', () => doDecideCandidate(ctx, orgId, candidateId, input));
}

function doDecideCandidate(ctx, orgId, candidateId, { decision, edits = null, reason = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const candidate = assertBelongsToOrg(ctx.db.get('extraction_candidate', candidateId), orgId);

  if (isDecided(candidate.state)) {
    throw new ExtractionError('already_decided', `this figure was already ${candidate.state.toLowerCase()}`, 409);
  }

  const now = ctx.now();

  if (decision === 'REJECT') {
    const text = String(reason ?? '').trim();
    if (text.length < 3) {
      throw new ExtractionError('reject_reason_required',
        'Say briefly why this was rejected. In three months this is the only record of why a figure '
        + 'in your own document was not used.');
    }
    const updated = ctx.db.update('extraction_candidate', candidateId, {
      state: 'REJECTED', decided_at: now, decided_by: ctx.auth.userId, reject_reason: text,
    });
    audit(ctx, orgId, 'extraction.candidate_rejected', 'extraction_candidate', candidateId,
      { fact_key: candidate.fact_key, reason: text });
    maybeCloseRun(ctx, orgId, candidate.extraction_id);
    return ok({ candidate: updated, fact: null });
  }

  if (decision !== 'CONFIRM') {
    throw new ExtractionError('invalid_decision', "decision must be 'CONFIRM' or 'REJECT'");
  }

  const edited = hasEdits(candidate, edits);
  const input = candidateToFactInput(candidate, edited ? edits : null);
  const row = buildFact(input);

  const fact = ctx.db.insert('fact', {
    org_id: orgId, ...row, ...confirmationStamp(row.source, ctx.auth.userId, now),
    superseded_by: null, created_by: ctx.auth.userId, created_at: now,
  });

  const updated = ctx.db.update('extraction_candidate', candidateId, {
    state: edited ? 'EDITED_CONFIRMED' : 'CONFIRMED',
    decided_at: now, decided_by: ctx.auth.userId, fact_id: fact.id,
  });

  audit(ctx, orgId, 'extraction.candidate_confirmed', 'fact', fact.id, {
    candidate_id: candidateId, fact_key: fact.fact_key,
    edited, extractor_value: candidate.value_numeric ?? candidate.value_text,
    confirmed_value: fact.value_numeric ?? fact.value_text,
  });

  maybeCloseRun(ctx, orgId, candidate.extraction_id);
  return ok({ candidate: updated, fact }, 201);
}

/**
 * Confirm everything still outstanding in a run.
 *
 * Guarded by `assertBulkConfirmable`, which refuses unless every outstanding
 * candidate has been served to a client at least once. This is the function
 * most likely to be "improved" later into something that skips review; the
 * guard, and the test on it, are what stop that.
 */
export function bulkConfirm(ctx, orgId, extractionId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const run = assertBelongsToOrg(ctx.db.get('extraction', extractionId), orgId);

  const candidates = ctx.db.find('extraction_candidate', { extraction_id: extractionId });
  const pending = assertBulkConfirmable(candidates);

  const facts = [];
  for (const c of pending) {
    facts.push(decideCandidate(ctx, orgId, c.id, { decision: 'CONFIRM' }).body.fact);
  }

  audit(ctx, orgId, 'extraction.bulk_confirmed', 'extraction', extractionId,
    { count: facts.length, document_id: run.document_id });
  return ok({ confirmed: facts.length, facts });
}

/** Close the run once nothing is outstanding. */
function maybeCloseRun(ctx, orgId, extractionId) {
  const run = ctx.db.get('extraction', extractionId);
  if (!run || run.reviewed_at) return;

  const progress = reviewProgress(ctx.db.find('extraction_candidate', { extraction_id: extractionId }));
  if (!progress.complete) return;

  const now = ctx.now();
  ctx.db.update('extraction', extractionId, { state: 'REVIEWED', reviewed_at: now, reviewed_by: ctx.auth.userId });
  ctx.db.update('document', run.document_id, { extract_state: 'REVIEWED' });
  audit(ctx, orgId, 'extraction.reviewed', 'extraction', extractionId, progress);
  recordMilestone(ctx, orgId, 'FIRST_EXTRACTION_REVIEWED');
}

// ───────────────────────────────────────────────────────────────── conflicts ──

/** Detect and store conflicts raised by a set of new candidates. */
function recordConflicts(ctx, orgId, candidates) {
  if (!candidates.length) return [];

  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const found = detectConflicts(facts, candidates, docLabels(ctx, orgId));

  const now = ctx.now();
  const existing = new Set(ctx.db.find('conflict', { org_id: orgId })
    .map((c) => [c.left_ref, c.right_ref].sort().join('|')));

  const stored = [];
  for (const c of found) {
    const pair = [c.left_ref, c.right_ref].sort().join('|');
    if (existing.has(pair)) continue;
    existing.add(pair);
    stored.push(ctx.db.insert('conflict', {
      org_id: orgId, ...c,
      resolved_at: null, resolved_by: null, resolution: null, resolution_note: null,
      created_at: now,
    }));
  }
  return stored;
}

export function listConflicts(ctx, orgId, { includeResolved = false } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const all = ctx.db.find('conflict', { org_id: orgId });
  const shown = includeResolved ? all : all.filter((c) => !c.resolved_at);

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  shown.sort((a, b) => (order[a.severity] - order[b.severity])
    || String(a.created_at).localeCompare(String(b.created_at)));

  return ok({
    source: CONFLICT_SOURCE,
    conflicts: shown.map((c) => ({ ...c, rule: crossKeyRule(c.rule_ref) })),
    summary: conflictSummary(all),
  });
}

/**
 * Record how a contradiction was settled.
 *
 * Choosing a side does not change either figure. Correcting a figure is a
 * separate, deliberate act through `supersedeFact` — because "we decided the
 * accounts were right" and "we changed the deck" are different things, and
 * conflating them would let a resolution quietly rewrite a record.
 */
export function resolveConflict(ctx, orgId, conflictId, input) {
  return usage.around(ctx, orgId, 'CONFLICT_RESOLVED', () => doResolveConflict(ctx, orgId, conflictId, input));
}

function doResolveConflict(ctx, orgId, conflictId, input) {
  authorise(membershipOf(ctx, orgId), 'write');
  const conflict = assertBelongsToOrg(ctx.db.get('conflict', conflictId), orgId);
  if (conflict.resolved_at) throw new AccessError('already_resolved', 409);

  const { resolution, note } = validateResolution(input);
  const now = ctx.now();

  const updated = ctx.db.update('conflict', conflictId, {
    resolved_at: now, resolved_by: ctx.auth.userId, resolution, resolution_note: note,
  });
  audit(ctx, orgId, 'conflict.resolved', 'conflict', conflictId,
    { resolution, note, rule_ref: conflict.rule_ref, severity: conflict.severity });

  recordMilestone(ctx, orgId, 'FIRST_CONFLICT_RESOLVED');
  return ok({ conflict: updated });
}

/**
 * Whether anything may be generated from this organisation's facts yet.
 * Phase 5 calls this before rendering a deck, a one-pager or a model.
 */
export function generationReadiness(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const conflicts = ctx.db.find('conflict', { org_id: orgId });
  const blockers = unresolvedBlockers(conflicts);
  return ok({
    can_generate: blockers.length === 0,
    blockers: blockers.map((c) => ({
      id: c.id, severity: c.severity, detail: c.detail,
      left: c.left_summary, right: c.right_summary,
    })),
    reason: blockers.length
      ? 'Two of your own records disagree on a figure that would appear in the document. Settle those '
        + 'first — a generated document is only as good as the facts under it.'
      : null,
    summary: conflictSummary(conflicts),
  });
}

// ───────────────────────────────────────────────────────────── transfer sheet ──

/**
 * Import a filled Transfer Sheet.
 *
 * `fieldValues` comes from `tools/read_transfer_sheet.py` — raw AcroForm field
 * values, read byte-exact. Everything that decides what a value *means* happens
 * in `parseTransferSheet`, which is pure and tested.
 *
 * The result is handed to `redeemWorkbook`, so a Transfer Sheet and a hand-typed
 * onramp follow exactly one code path. These facts are USER_ENTERED: the user
 * typed them into the form themselves and reading a form field back is
 * transcription, not extraction. Nothing was inferred, so nothing is marked as
 * having been.
 */
export function importTransferSheet(ctx, orgId, fieldValues, options = {}) {
  return usage.around(ctx, orgId, 'TRANSFER_SHEET_IMPORTED', () => doImportTransferSheet(ctx, orgId, fieldValues, options));
}

function doImportTransferSheet(ctx, orgId, fieldValues, { redeem } = {}) {
  authorise(membershipOf(ctx, orgId), 'own');

  const parsed = parseTransferSheet(fieldValues ?? {});

  if (isEmptySheet(parsed)) {
    throw new ExtractionError('empty_transfer_sheet',
      'Nothing could be read from this sheet. If you printed it and filled it in by hand, type the '
      + 'figures in instead — a scan is stored for reference but is not read.', 400);
  }

  const errors = parsed.problems.filter((p) => p.severity === 'ERROR');
  const result = redeem(ctx, orgId, parsed.input);

  audit(ctx, orgId, 'transfer_sheet.imported', 'organisation', orgId, {
    sheet_version: parsed.version, current_version: TRANSFER_SHEET_VERSION,
    fields_read: parsed.filled, problems: parsed.problems.length,
  });

  return ok({
    ...result.body,
    sheet: {
      version: parsed.version,
      current_version: TRANSFER_SHEET_VERSION,
      fields_read: parsed.filled,
      // Returned rather than thrown. Twenty-nine good boxes are imported and the
      // three that could not be read are named, because refusing the whole sheet
      // over one typo is how people give up, and dropping them silently is how a
      // figure goes missing without anyone knowing.
      problems: parsed.problems,
      needs_attention: errors.length,
    },
  }, result.status);
}

export { ExtractionError };
