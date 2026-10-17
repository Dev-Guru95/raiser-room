/**
 * Fact rules — the compliance core of the product.
 *
 * Specification §3.1: the AI never originates a number. That is enforced here,
 * in the type system of the data, not in a prompt and not in UI copy.
 */

/**
 * The closed set of ways a fact can come into existence.
 *
 * There is deliberately NO `AI_GENERATED` value and there must never be one.
 * If a future change needs the AI to contribute a figure, that change is wrong.
 */
export const FACT_SOURCES = Object.freeze([
  'USER_ENTERED',       // the user typed it
  'DOCUMENT_EXTRACTED', // pulled from an upload, NOT yet confirmed
  'USER_CONFIRMED',     // extracted, then explicitly confirmed by a human
  'CALCULATED',         // derived by a stored formula from other facts
]);

export const UNITS = Object.freeze([
  'USD', 'EUR', 'GBP', 'percent', 'count', 'months', 'ratio',
]);

/**
 * Sources that must point at the document they came from.
 *
 * USER_CONFIRMED is in this list, and that matters. Confirming an extraction
 * must not sever the link to the page the figure was read from — if it did,
 * confirmation would *destroy* provenance at the exact moment the figure starts
 * being relied on. The reviewer's "yes" is evidence about a document; without
 * the document it is evidence about nothing.
 */
export const DOCUMENT_BACKED_SOURCES = Object.freeze(['DOCUMENT_EXTRACTED', 'USER_CONFIRMED']);

/**
 * Sources a downstream consumer may rely on.
 *
 * DOCUMENT_EXTRACTED is absent on purpose. An unconfirmed extraction is a
 * proposal: it may not be scored, charted, put in a deck, or counted towards
 * data-room completeness. Nothing else in the codebase is permitted to read
 * facts without passing them through `isUsable` first.
 */
export const USABLE_SOURCES = Object.freeze(['USER_ENTERED', 'USER_CONFIRMED', 'CALCULATED']);

/** A fact a consumer may rely on: current, and not awaiting human confirmation. */
export function isUsable(fact) {
  if (!fact || fact.superseded_by) return false;
  return USABLE_SOURCES.includes(fact.source);
}

/** Filter a fact list down to what may be relied on. */
export function usableFacts(facts) {
  return (facts ?? []).filter(isUsable);
}

export class FactError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Validate and normalise a fact before it is written.
 *
 * @param {object} input       untrusted caller input
 * @param {object} [previous]  the fact being superseded, when correcting
 * @returns {object} a row ready to insert
 */
export function buildFact(input, previous = null) {
  const source = String(input.source ?? previous?.source ?? '');

  if (!FACT_SOURCES.includes(source)) {
    throw new FactError(
      'invalid_source',
      'Fact.source must be USER_ENTERED | DOCUMENT_EXTRACTED | USER_CONFIRMED | CALCULATED. ' +
      'The AI never originates a number, so no AI_GENERATED source exists.',
    );
  }

  const factKey = String(input.fact_key ?? previous?.fact_key ?? '').trim();
  const label = String(input.label ?? previous?.label ?? '').trim();
  if (!factKey) throw new FactError('missing_key', 'fact_key is required');
  if (!label) throw new FactError('missing_label', 'label is required');

  // ── values ────────────────────────────────────────────────────────────────
  let valueNumeric = null;
  if (input.value_numeric !== undefined && input.value_numeric !== null && input.value_numeric !== '') {
    const n = Number(input.value_numeric);
    if (!Number.isFinite(n)) throw new FactError('bad_number', 'value_numeric must be a finite number');
    valueNumeric = n;
  } else if (input.value_numeric === undefined && previous) {
    valueNumeric = previous.value_numeric ?? null;
  }

  const valueText = input.value_text !== undefined
    ? (input.value_text != null ? String(input.value_text) : null)
    : (previous?.value_text ?? null);

  const valueDate = input.value_date !== undefined
    ? (input.value_date != null ? String(input.value_date) : null)
    : (previous?.value_date ?? null);

  if (valueNumeric === null && valueText === null && valueDate === null) {
    throw new FactError('missing_value', 'a value is required (value_numeric, value_text or value_date)');
  }

  // ── CALCULATED must be auditable ──────────────────────────────────────────
  //
  // NOTE: formula and input_fact_ids are scoped to CALCULATED and are NOT
  // inherited from the previous fact for any other source. Carrying them
  // forward would leave a stale formula attached to a hand-entered figure,
  // which is exactly the kind of quiet provenance rot this store exists to
  // prevent. This was a real bug in the first implementation.
  let formula = null;
  let inputFactIds = null;

  if (source === 'CALCULATED') {
    formula = String(input.formula ?? previous?.formula ?? '').trim();
    const ids = Array.isArray(input.input_fact_ids)
      ? input.input_fact_ids.map(String)
      : (previous?.input_fact_ids ? JSON.parse(previous.input_fact_ids) : []);
    if (!formula || ids.length === 0) {
      throw new FactError('calculated_needs_provenance',
        'CALCULATED facts require a formula and at least one input fact id');
    }
    inputFactIds = JSON.stringify(ids);
  }

  // ── unit ──────────────────────────────────────────────────────────────────
  const unit = input.unit !== undefined
    ? (UNITS.includes(input.unit) ? input.unit : null)
    : (previous?.unit ?? null);

  // ── document provenance ───────────────────────────────────────────────────
  //
  // Scoped to the document-backed sources in both directions, and both bugs
  // here were real:
  //
  //   · `source_doc_id` was kept only for DOCUMENT_EXTRACTED, so confirming an
  //     extracted figure nulled the link to the document it was read from. The
  //     confirmed fact — the one that then gets used — carried no provenance.
  //
  //   · `source_page` was kept for *every* source, so a hand-typed figure could
  //     claim it came from page 7 of a document it had no link to. A page
  //     number with no document behind it is a false citation.
  const documentBacked = DOCUMENT_BACKED_SOURCES.includes(source);

  let sourceDocId = null;
  let sourcePage = null;

  if (documentBacked) {
    sourceDocId = input.source_doc_id !== undefined
      ? (input.source_doc_id ? String(input.source_doc_id) : null)
      : (previous?.source_doc_id ?? null);

    if (!sourceDocId) {
      throw new FactError('document_required',
        `${source} facts must name the document they came from. A confirmation with no ` +
        'document behind it is not a confirmation of anything.');
    }

    const page = Number(input.source_page ?? previous?.source_page);
    sourcePage = Number.isFinite(page) ? Math.round(page) : null;
  }

  return {
    fact_key: factKey,
    label,
    value_numeric: valueNumeric,
    value_text: valueText,
    value_date: valueDate,
    unit,
    period_start: input.period_start !== undefined ? (input.period_start ?? null) : (previous?.period_start ?? null),
    period_end: input.period_end !== undefined ? (input.period_end ?? null) : (previous?.period_end ?? null),
    source,
    source_doc_id: sourceDocId,
    source_page: sourcePage,
    formula,
    input_fact_ids: inputFactIds,
  };
}

/**
 * Confirmation is stamped server-side, never accepted from the client.
 * A client that could set confirmed_by could claim a human verified a figure
 * that no human ever saw.
 */
export function confirmationStamp(source, userId, now) {
  return source === 'USER_CONFIRMED'
    ? { confirmed_at: now, confirmed_by: userId }
    : { confirmed_at: null, confirmed_by: null };
}
