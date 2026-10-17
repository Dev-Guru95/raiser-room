/**
 * The extractor contract.
 *
 * Everything in `src/domain/` is pure and tested. This is the seam where that
 * stops: an extractor opens real files and, for most document kinds, asks a
 * language model what is in them. Its accuracy is NOT verified by this test
 * suite, and that boundary is drawn here deliberately rather than left to be
 * discovered.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 *
 * An extractor is an object:
 *
 *   {
 *     id:      'anthropic-doc-v1',   // stable identifier, stored on every run
 *     version: '2026-10-01',         // bump when behaviour changes
 *
 *     async probe({ storageKey, mimeType }) -> {
 *       pages:           number | null,
 *       textCharacters:  number | null,   // selectable text, not rendered pixels
 *       encrypted:       boolean,
 *     },
 *
 *     async extract({ storageKey, mimeType, kind, pages }) -> {
 *       candidates: [{
 *         fact_key, label,
 *         value_numeric | value_text | value_date,
 *         unit, period_start, period_end,
 *         source_page,
 *         locator,        // REQUIRED: the verbatim text or cell reference
 *         confidence,     // the extractor's own opinion. Advisory only.
 *       }]
 *     }
 *   }
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT AN EXTRACTOR MAY NOT DO
 *
 * 1. It may not write to the database. It returns candidates; the service
 *    layer decides what becomes of them.
 *
 * 2. It may not return a candidate without a `locator`. A reviewer approving a
 *    figure with nothing to check it against is a rubber stamp, and a rubber
 *    stamp carrying a USER_CONFIRMED label is worse than no review at all.
 *
 * 3. It may not infer, round, convert or combine. If the deck says "£3.8m" the
 *    candidate is 3,800,000 GBP, not a USD conversion — the exchange rate used
 *    would be the extractor originating a number, which is the one thing this
 *    product does not permit.
 *
 * 4. It may not produce a candidate for something the document does not state.
 *    An absent figure is absent. A plausible figure is the failure mode that
 *    this whole architecture exists to make impossible.
 *
 * 5. Its `confidence` is stored and shown, and gates nothing. There is no
 *    threshold above which review is skipped. See `assertBulkConfirmable`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT TESTED
 *
 * Tested: that an extractor returning rubbish cannot corrupt the fact store —
 * malformed candidates are rejected, locator-less candidates are rejected,
 * nothing is auto-confirmed, conflicts surface, and an unreadable document is
 * declared unreadable rather than guessed at.
 *
 * Not tested, and not to be claimed: whether a real extractor finds the right
 * number on page 14 of a real pitch deck. That requires a labelled corpus and
 * a measured accuracy figure, neither of which exists yet.
 */

export const EXTRACTOR_CONTRACT_VERSION = '1';

export class ExtractorError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Validate an extractor object before it is trusted with a document. */
export function assertExtractor(extractor) {
  if (!extractor || typeof extractor !== 'object') {
    throw new ExtractorError('no_extractor', 'an extractor is required');
  }
  for (const field of ['id', 'version']) {
    if (!extractor[field]) {
      throw new ExtractorError('extractor_unidentified',
        `an extractor must carry ${field} — "which reader produced this" is part of the provenance `
        + 'of everything it returns');
    }
  }
  for (const method of ['probe', 'extract']) {
    if (typeof extractor[method] !== 'function') {
      throw new ExtractorError('extractor_incomplete', `an extractor must implement ${method}()`);
    }
  }
  return extractor;
}
