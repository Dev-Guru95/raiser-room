/**
 * Document extraction rules.
 *
 * WHAT THIS MODULE IS, AND WHAT IT IS NOT
 *
 * This module contains no model and reads no bytes. It contains the rules that
 * govern what happens to whatever an extractor returns: how a document is
 * classified, when a document is honestly declared unreadable, what a candidate
 * must carry before it may be shown to a reviewer, and — the part that matters
 * most — the review state machine, which has no path from "a machine read this"
 * to "this is a fact" that does not pass through a human.
 *
 * The extractor itself is a provider behind `src/extract/interface.js`. Its
 * accuracy is NOT verified by this test suite and must not be claimed. These
 * rules are what stop a bad extraction from becoming a confident wrong number.
 */

export class ExtractionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The kinds of document the pipeline knows how to read differently. */
export const DOC_KINDS = Object.freeze([
  'DECK',           // pitch deck / IM
  'ACCOUNTS',       // statutory or management accounts
  'MODEL',          // spreadsheet financial model
  'CAP_TABLE',      // cap table / share register
  'CONTRACT',       // customer, supplier or financing agreement
  'TRANSFER_SHEET', // our own fillable form — read deterministically, no model
  'OTHER',
]);

/** Extraction run states. */
export const EXTRACTION_STATES = Object.freeze([
  'RUNNING',
  'NEEDS_REVIEW',  // candidates are waiting for a human
  'REVIEWED',      // every candidate has been decided
  'UNSUPPORTED',   // honestly unreadable — see UNSUPPORTED_REASONS
  'FAILED',        // the extractor errored
]);

/** Candidate states. There is no state meaning "confirmed by the machine". */
export const CANDIDATE_STATES = Object.freeze([
  'AWAITING_REVIEW',
  'CONFIRMED',        // accepted as read
  'EDITED_CONFIRMED', // the reviewer changed the value, then accepted it
  'REJECTED',
]);

const DECIDED = Object.freeze(['CONFIRMED', 'EDITED_CONFIRMED', 'REJECTED']);
export const isDecided = (state) => DECIDED.includes(state);

/**
 * Why a document was declared unreadable.
 *
 * Saying "I cannot read this" is a feature. The alternative — running a model
 * over a bad scan and presenting whatever comes back — produces confident
 * nonsense, and the figures most often mangled are digits and decimal points.
 * A concentration figure corrupted from 68% to 6.8% would arrive wearing a
 * clean provenance label, which is worse than no extraction at all.
 */
export const UNSUPPORTED_REASONS = Object.freeze({
  SCANNED_OR_IMAGE_ONLY:
    'This looks like a scan or an image-only PDF — there is almost no selectable text in it. '
    + 'Reading digits off a scan is where extraction goes wrong most often, so this file is kept '
    + 'as a reference document and nothing has been read from it. Upload a text PDF or a '
    + 'spreadsheet if you want the figures extracted.',
  PASSWORD_PROTECTED:
    'This file is encrypted or password-protected, so nothing can be read from it. '
    + 'Remove the protection and upload it again.',
  UNSUPPORTED_FORMAT:
    'This file type is not one the extractor reads. It is stored as a reference document.',
  EMPTY:
    'This file contains no readable content.',
});

/** A PDF with less text than this per page is treated as a scan. */
export const MIN_TEXT_CHARS_PER_PAGE = 120;

const EXTRACTABLE_MIME = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
]);

// ──────────────────────────────────────────────────────── classification ──

/**
 * Filename and MIME tokens that suggest a kind.
 *
 * Deliberately a lookup table rather than a model. Classification decides which
 * extraction prompt and which fact keys are in play, so it needs to be
 * inspectable, correctable, and the same every time. A user override always
 * wins and is never second-guessed.
 */
const KIND_HINTS = Object.freeze([
  ['TRANSFER_SHEET', ['transfer', 'transfersheet', 'raiseroom']],
  ['CAP_TABLE', ['captable', 'cap', 'shareholders', 'shareholding', 'register', 'waterfall', 'safe', 'options']],
  ['ACCOUNTS', ['accounts', 'statutory', 'management', 'p&l', 'pandl', 'profitandloss', 'balance', 'trial', 'ledger', 'xero', 'quickbooks']],
  ['MODEL', ['model', 'forecast', 'projection', 'budget', 'plan', 'cashflow', 'scenario']],
  ['DECK', ['deck', 'pitch', 'teaser', 'im', 'memorandum', 'investor', 'overview']],
  ['CONTRACT', ['contract', 'agreement', 'msa', 'sow', 'nda', 'terms', 'licence', 'license', 'lease']],
]);

const MIME_HINTS = Object.freeze({
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'DECK',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'MODEL',
  'text/csv': 'MODEL',
});

/**
 * Classify a document from what we know without opening it.
 *
 * @returns {{kind: string, confidence: number, basis: string, needs_confirmation: boolean}}
 */
export function classifyDocument({ filename = '', mimeType = '', declaredKind = null } = {}) {
  if (declaredKind) {
    if (!DOC_KINDS.includes(declaredKind)) {
      throw new ExtractionError('invalid_doc_kind', `kind must be one of ${DOC_KINDS.join(', ')}`);
    }
    return { kind: declaredKind, confidence: 1, basis: 'declared by the user', needs_confirmation: false };
  }

  const tokens = new Set(String(filename).toLowerCase().match(/[a-z&]+/g) ?? []);
  const squashed = String(filename).toLowerCase().replace(/[^a-z&]/g, '');

  for (const [kind, hints] of KIND_HINTS) {
    const hit = hints.find((h) => tokens.has(h) || squashed.includes(h));
    if (hit) {
      return {
        kind,
        confidence: 0.6,
        basis: `the filename contains "${hit}"`,
        needs_confirmation: true,
      };
    }
  }

  const byMime = MIME_HINTS[mimeType];
  if (byMime) {
    return { kind: byMime, confidence: 0.4, basis: `the file type is ${mimeType}`, needs_confirmation: true };
  }

  return {
    kind: 'OTHER',
    confidence: 0,
    basis: 'nothing in the filename or file type identified it',
    needs_confirmation: true,
  };
}

// ───────────────────────────────────────────────────────── extractability ──

/**
 * Decide whether this document can honestly be read.
 *
 * @param {object} probe  { mimeType, pages, textCharacters, encrypted }
 * @returns {{supported: boolean, reason: string|null, message: string|null}}
 */
export function extractabilityOf(probe = {}) {
  const { mimeType = '', pages = null, textCharacters = null, encrypted = false } = probe;

  if (encrypted) return refuse('PASSWORD_PROTECTED');
  if (!EXTRACTABLE_MIME.includes(mimeType)) return refuse('UNSUPPORTED_FORMAT');

  if (textCharacters !== null && textCharacters !== undefined) {
    if (Number(textCharacters) <= 0) return refuse('EMPTY');

    // Per page, not in total: a 60-page scan with a text cover page would pass
    // a total-characters check and then yield nothing from the 59 pages that
    // hold the numbers.
    const perPage = pages && pages > 0 ? Number(textCharacters) / Number(pages) : Number(textCharacters);
    if (perPage < MIN_TEXT_CHARS_PER_PAGE) return refuse('SCANNED_OR_IMAGE_ONLY');
  }

  return { supported: true, reason: null, message: null };
}

const refuse = (reason) => ({ supported: false, reason, message: UNSUPPORTED_REASONS[reason] });

// ────────────────────────────────────────────────────────────── candidates ──

/**
 * Validate and normalise one candidate before it is stored.
 *
 * Three requirements, each of which exists because of what its absence allows:
 *
 *   · a `locator` — the verbatim snippet or cell reference the figure was read
 *     from. Without it the reviewer is being asked to approve a number against
 *     nothing, which is a rubber stamp with extra steps.
 *   · a value.
 *   · no `source` field. A candidate does not get to describe its own
 *     provenance; provenance is decided by what the human does next.
 */
export function normaliseCandidate(raw = {}, { documentId, extractionId } = {}) {
  if (!documentId || !extractionId) {
    throw new ExtractionError('candidate_context_required', 'a candidate must belong to a document and a run');
  }

  const factKey = String(raw.fact_key ?? '').trim();
  const label = String(raw.label ?? '').trim();
  if (!factKey) throw new ExtractionError('candidate_missing_key', 'a candidate needs a fact_key');
  if (!label) throw new ExtractionError('candidate_missing_label', 'a candidate needs a label');

  const locator = String(raw.locator ?? '').trim();
  if (locator.length < 3) {
    throw new ExtractionError('candidate_missing_locator',
      'a candidate must carry the text or cell reference it was read from. Asking a reviewer '
      + 'to approve a figure with nothing to check it against is a rubber stamp.');
  }

  let valueNumeric = null;
  if (raw.value_numeric !== undefined && raw.value_numeric !== null && raw.value_numeric !== '') {
    const n = Number(raw.value_numeric);
    if (!Number.isFinite(n)) {
      throw new ExtractionError('candidate_bad_number', `value_numeric must be a finite number, got ${JSON.stringify(raw.value_numeric)}`);
    }
    valueNumeric = n;
  }
  const valueText = raw.value_text != null && raw.value_text !== '' ? String(raw.value_text) : null;
  const valueDate = raw.value_date != null && raw.value_date !== '' ? String(raw.value_date) : null;

  if (valueNumeric === null && valueText === null && valueDate === null) {
    throw new ExtractionError('candidate_missing_value', 'a candidate with no value is not a candidate');
  }

  // Confidence is the extractor's own opinion of itself. It is stored so a
  // reviewer can sort by it, and it is used for NOTHING else — in particular it
  // never gates, skips or shortcuts review. See `promote()`.
  let confidence = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    const c = Number(raw.confidence);
    if (Number.isFinite(c)) confidence = Math.min(1, Math.max(0, c));
  }

  const page = Number(raw.source_page);

  return {
    extraction_id: extractionId,
    document_id: documentId,
    fact_key: factKey,
    label,
    value_numeric: valueNumeric,
    value_text: valueText,
    value_date: valueDate,
    unit: raw.unit != null ? String(raw.unit) : null,
    period_start: raw.period_start != null ? String(raw.period_start) : null,
    period_end: raw.period_end != null ? String(raw.period_end) : null,
    source_page: Number.isFinite(page) ? Math.round(page) : null,
    locator,
    confidence,
    state: 'AWAITING_REVIEW',
  };
}

/**
 * Turn a reviewed candidate into the input for a fact.
 *
 * The returned `source` is USER_CONFIRMED and is hard-coded here. It is not
 * taken from the candidate, not taken from the caller, and not conditional on
 * confidence. The only way to reach this function is through a human decision.
 *
 * @param {object} candidate
 * @param {object} [edits]  reviewer corrections: value_numeric / value_text /
 *                          value_date / unit / period_start / period_end
 */
export function candidateToFactInput(candidate, edits = null) {
  if (!candidate) throw new ExtractionError('candidate_not_found', 'no candidate', 404);

  // An explicit guard rather than an accident of the schema.
  //
  // `extraction_candidate` has no `source` column, so today a candidate cannot
  // carry one. That is a structural protection, and structural protections are
  // exactly the kind that get removed by a future migration nobody connects to
  // this rule. If a candidate ever arrives describing its own provenance,
  // something upstream is trying to promote itself and must stop here.
  for (const field of ['source', 'confirmed_at', 'confirmed_by']) {
    if (candidate[field] !== undefined && candidate[field] !== null) {
      throw new ExtractionError('candidate_claims_provenance',
        `A candidate carried "${field}". Extraction output does not get to describe its own `
        + 'provenance — that is decided by what a human does next.');
    }
  }

  const e = edits ?? {};
  const pick = (field) => (e[field] !== undefined ? e[field] : candidate[field]);

  const input = {
    fact_key: candidate.fact_key,
    label: e.label !== undefined ? e.label : candidate.label,
    value_numeric: pick('value_numeric'),
    value_text: pick('value_text'),
    value_date: pick('value_date'),
    unit: pick('unit'),
    period_start: pick('period_start'),
    period_end: pick('period_end'),

    // Not negotiable, and not derived from anything the extractor said.
    source: 'USER_CONFIRMED',
    source_doc_id: candidate.document_id,
    source_page: candidate.source_page,
  };

  // A fact carries one value. If the reviewer typed a number over a figure that
  // had been read as text, the stale text must go rather than sit alongside it.
  if (e.value_numeric !== undefined && e.value_numeric !== null && e.value_numeric !== ''
      && e.value_text === undefined) {
    input.value_text = null;
  }

  return input;
}

/** Did the reviewer actually change anything? Decides CONFIRMED vs EDITED_CONFIRMED. */
export function hasEdits(candidate, edits) {
  if (!edits) return false;
  const fields = ['value_numeric', 'value_text', 'value_date', 'unit', 'period_start', 'period_end', 'label'];
  return fields.some((f) => {
    if (edits[f] === undefined) return false;
    const a = edits[f] === '' ? null : edits[f];
    const b = candidate[f] === '' ? null : candidate[f];
    if (a === null && b === null) return false;
    return String(a) !== String(b);
  });
}

/**
 * Whether an extraction run may be closed as REVIEWED.
 *
 * A run is reviewed when every candidate has been decided. There is no
 * "reviewed enough" and no timeout that reviews it for you.
 */
export function reviewProgress(candidates = []) {
  const total = candidates.length;
  const decided = candidates.filter((c) => isDecided(c.state)).length;
  const confirmed = candidates.filter((c) => c.state === 'CONFIRMED' || c.state === 'EDITED_CONFIRMED').length;
  return {
    total,
    decided,
    confirmed,
    rejected: candidates.filter((c) => c.state === 'REJECTED').length,
    awaiting: total - decided,
    complete: total > 0 && decided === total,
  };
}

/**
 * Guard the bulk-confirm action.
 *
 * Bulk confirm exists, because clicking through forty line items of a
 * management account one at a time is a worse outcome: people stop reading at
 * item six. But it may only be used on candidates the reviewer has actually
 * been shown. `viewed_at` is stamped when a candidate is served to the client,
 * so this is a check against the record rather than a promise in the UI.
 *
 * What is forbidden is the thing that would quietly destroy the product's
 * central claim: a code path that promotes candidates nobody has looked at.
 */
export function assertBulkConfirmable(candidates = []) {
  const pending = candidates.filter((c) => c.state === 'AWAITING_REVIEW');
  if (!pending.length) {
    throw new ExtractionError('nothing_to_confirm', 'every candidate in this run has already been decided', 409);
  }

  const unseen = pending.filter((c) => !c.viewed_at);
  if (unseen.length) {
    throw new ExtractionError('unreviewed_candidates',
      `${unseen.length} of these figures have not been displayed to anyone yet. `
      + 'Bulk confirm accepts what you have read; it does not accept what you have not seen.',
      409);
  }
  return pending;
}
