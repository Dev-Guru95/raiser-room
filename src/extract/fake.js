/**
 * A deterministic extractor for tests and local development.
 *
 * It returns fixed candidates from a scripted table rather than reading
 * anything. That is the point: the rules around extraction can then be tested
 * exhaustively and repeatably, with no model, no network and no flake.
 *
 * It also includes fixtures for the ways an extractor misbehaves — a candidate
 * with no locator, a candidate claiming its own provenance, a scan with no
 * text — because those are the inputs the rules exist to survive.
 */

/** @param {object} script  { probe, candidates } keyed by document kind */
export function fakeExtractor(script = {}, { id = 'fake-extractor', version = 'test-1' } = {}) {
  return {
    id,
    version,

    async probe({ mimeType, storageKey } = {}) {
      const override = script.probe?.[storageKey] ?? script.probe?.[mimeType];
      return override ?? { pages: 12, textCharacters: 24_000, encrypted: false };
    },

    async extract({ kind, storageKey } = {}) {
      const candidates = script.candidates?.[storageKey] ?? script.candidates?.[kind] ?? [];
      return { candidates };
    },
  };
}

/** A pitch deck with the figures a deck usually carries. */
export const DECK_CANDIDATES = Object.freeze([
  {
    fact_key: 'financials.arr', label: 'ARR', value_numeric: 4_200_000, unit: 'USD',
    period_start: '2025-01-01', period_end: '2025-12-31',
    source_page: 7, locator: '“ARR $4.2m” — headline, growth slide', confidence: 0.86,
  },
  {
    fact_key: 'plan.nrr_claimed', label: 'Net revenue retention (stated)', value_numeric: 140, unit: 'percent',
    source_page: 9, locator: '“140% net revenue retention”', confidence: 0.81,
  },
  {
    fact_key: 'people.headcount', label: 'Headcount', value_numeric: 38, unit: 'count',
    source_page: 14, locator: '“38 people across 3 offices”', confidence: 0.74,
  },
]);

/** Management accounts covering the same period, disagreeing with the deck. */
export const ACCOUNTS_CANDIDATES = Object.freeze([
  {
    fact_key: 'financials.arr', label: 'ARR', value_numeric: 3_800_000, unit: 'USD',
    period_start: '2025-01-01', period_end: '2025-12-31',
    source_page: 3, locator: "Sheet 'Summary', cell D14", confidence: 0.93,
  },
  {
    fact_key: 'financials.revenue.ttm', label: 'Revenue, trailing twelve months', value_numeric: 3_600_000,
    unit: 'USD', source_page: 3, locator: "Sheet 'Summary', cell D9", confidence: 0.92,
  },
  {
    fact_key: 'financials.cogs.ttm', label: 'Cost of sales, trailing twelve months', value_numeric: 1_300_000,
    unit: 'USD', source_page: 3, locator: "Sheet 'Summary', cell D10", confidence: 0.9,
  },
  {
    fact_key: 'financials.gross_margin', label: 'Gross margin', value_numeric: 78, unit: 'percent',
    source_page: 4, locator: "Sheet 'Summary', cell D11 — stated", confidence: 0.88,
  },
]);

/** A model whose retention assumption does not match the narrative. */
export const MODEL_CANDIDATES = Object.freeze([
  {
    fact_key: 'model.nrr_assumed', label: 'Net revenue retention (model assumption)', value_numeric: 118,
    unit: 'percent', source_page: 1, locator: "Sheet 'Assumptions', cell B12", confidence: 0.95,
  },
]);

/** A scan: pages, but almost no selectable text. */
export const SCANNED_PROBE = Object.freeze({ pages: 30, textCharacters: 400, encrypted: false });

/** Candidates that break the contract. Used to prove the rules hold. */
export const MALFORMED_CANDIDATES = Object.freeze({
  noLocator: { fact_key: 'financials.arr', label: 'ARR', value_numeric: 1_000_000, unit: 'USD' },
  noValue: { fact_key: 'financials.arr', label: 'ARR', locator: 'page 2, somewhere' },
  noKey: { label: 'ARR', value_numeric: 1, locator: 'page 2' },
  // An extractor trying to mark its own output as confirmed.
  claimsConfirmed: {
    fact_key: 'financials.arr', label: 'ARR', value_numeric: 9_999_999, unit: 'USD',
    locator: 'page 2', source: 'USER_CONFIRMED', confirmed_by: 'the-model', confidence: 1,
  },
});
