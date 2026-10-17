/**
 * The artifact catalogue — every document a raise or sale room is expected to
 * contain, declared as data.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY DECLARATIVE
 *
 * Thirty hand-written document generators would be thirty places for the same
 * bug, and the thirtieth would be written in a hurry. Instead an artifact is a
 * list of BLOCKS — a cover, a row of figures, a chart, a table, some prose, an
 * evidence footnote, an appendix — and each block declares the fact keys it
 * needs. Breadth then comes from the catalogue rather than from code, and a new
 * artifact is a declaration that cannot introduce a new class of defect.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT MATTERS
 *
 * **No figure is ever typed into an artifact.** Every number on every page is a
 * reference into the fact store, resolved at render time. That is what makes
 * the central claim true at the document layer: the deck and the model cannot
 * contradict each other, because the deck has no numbers of its own to
 * contradict anything with.
 *
 * A block whose facts are missing does not get filled in with a placeholder or
 * a plausible value. It is reported as missing, and if it is required, the
 * artifact does not generate.
 */

export class ArtifactError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Block types the renderer understands. A catalogue entry may use only these. */
export const BLOCK_TYPES = Object.freeze([
  'COVER', 'SECTION', 'KPI_ROW', 'CHART', 'TABLE', 'PROSE',
  'CHECKLIST', 'EVIDENCE', 'APPENDIX', 'DISCLAIMER',
]);

/** Which process a document belongs to. */
export const PATHS = Object.freeze(['RAISE', 'SALE', 'BOTH']);

const A = (spec) => Object.freeze({ path: 'BOTH', size: 'a4', ...spec });

/**
 * The catalogue.
 *
 * `requires` are fact keys without which the artifact is meaningless and will
 * not generate. `uses` are keys that improve it and whose absence is reported
 * but not blocking — the difference between "this document would be wrong" and
 * "this document would be thinner".
 */
export const ARTIFACTS = Object.freeze([
  // ── narrative ────────────────────────────────────────────────────────────
  A({
    kind: 'PITCH_DECK', title: 'Investor deck', path: 'RAISE', size: 'slide',
    purpose: 'The raise narrative, with every figure traced to a source.',
    requires: ['company.name'],
    uses: ['financials.arr', 'financials.revenue.ttm', 'financials.gross_margin',
      'people.headcount', 'commercial.concentration.top1', 'plan.assumption.1'],
    blocks: ['COVER', 'KPI_ROW', 'PROSE', 'CHART:revenue_trend', 'CHART:concentration',
      'TABLE:financial_summary', 'PROSE:market', 'EVIDENCE', 'TABLE:use_of_funds',
      'PROSE:assumptions', 'APPENDIX', 'DISCLAIMER'],
  }),
  A({
    kind: 'INFORMATION_MEMORANDUM', title: 'Information memorandum', path: 'SALE',
    purpose: 'The long-form sale document.',
    requires: ['company.name'],
    uses: ['financials.reported_profit', 'financials.normalised_earnings', 'commercial.concentration.top1'],
    blocks: ['COVER', 'SECTION', 'PROSE', 'KPI_ROW', 'TABLE:financial_summary',
      'CHART:normalisation_bridge', 'TABLE:normalisation', 'CHART:concentration',
      'TABLE:contract_register', 'CHART:org', 'PROSE:market', 'EVIDENCE', 'APPENDIX', 'DISCLAIMER'],
  }),
  A({
    kind: 'TEASER', title: 'Anonymised teaser', path: 'SALE', size: 'a4',
    purpose: 'One page, no identifying detail, for first contact.',
    requires: [],
    uses: ['financials.revenue.ttm', 'financials.normalised_earnings', 'people.headcount'],
    blocks: ['COVER', 'PROSE', 'KPI_ROW', 'DISCLAIMER'],
    anonymised: true,
  }),
  A({
    kind: 'ONE_PAGER', title: 'Company one-pager',
    purpose: 'The summary that gets forwarded.',
    requires: ['company.name'],
    uses: ['financials.arr', 'people.headcount'],
    blocks: ['COVER', 'KPI_ROW', 'PROSE', 'CHART:revenue_trend', 'DISCLAIMER'],
  }),
  A({
    kind: 'EXECUTIVE_SUMMARY', title: 'Executive summary',
    purpose: 'Two pages of prose, every figure referenced.',
    requires: ['company.name'],
    uses: [], blocks: ['SECTION', 'PROSE', 'KPI_ROW', 'EVIDENCE', 'APPENDIX'],
  }),

  // ── financial ────────────────────────────────────────────────────────────
  A({
    kind: 'FINANCIAL_SUMMARY', title: 'Financial summary',
    purpose: 'Trading history, presented consistently.',
    requires: ['financials.revenue.ttm'],
    uses: ['financials.gross_margin', 'financials.cogs.ttm', 'financials.reported_profit'],
    blocks: ['SECTION', 'TABLE:financial_summary', 'CHART:revenue_trend', 'APPENDIX'],
  }),
  A({
    kind: 'NORMALISATION_BRIDGE', title: 'Normalisation bridge',
    purpose: 'Reported profit to underlying earnings, with every adjustment evidenced.',
    requires: ['financials.reported_profit', 'financials.normalised_earnings'],
    uses: ['financials.normalisation_period'],
    blocks: ['SECTION', 'CHART:normalisation_bridge', 'TABLE:normalisation', 'APPENDIX'],
  }),
  A({
    kind: 'KPI_PACK', title: 'KPI pack',
    purpose: 'The operating metrics, defined and reproducible.',
    requires: [],
    uses: ['financials.arr', 'metrics.nrr', 'metrics.churn', 'people.headcount'],
    blocks: ['SECTION', 'KPI_ROW', 'TABLE:kpi', 'CHART:kpi_trend', 'APPENDIX'],
  }),
  A({
    kind: 'UNIT_ECONOMICS', title: 'Unit economics',
    purpose: 'Cost to acquire against lifetime value, from actual cost data.',
    requires: [],
    uses: ['metrics.cac', 'metrics.ltv', 'metrics.payback_months'],
    blocks: ['SECTION', 'TABLE:unit_economics', 'CHART:unit_economics', 'APPENDIX'],
  }),
  A({
    kind: 'COHORT_ANALYSIS', title: 'Cohort analysis',
    purpose: 'Whether revenue stays.',
    requires: [],
    uses: ['metrics.nrr'],
    blocks: ['SECTION', 'CHART:cohorts', 'TABLE:cohorts', 'APPENDIX'],
  }),
  A({
    kind: 'REVENUE_ANALYSIS', title: 'Revenue analysis',
    purpose: 'Where the revenue comes from, broken down.',
    requires: ['financials.revenue.ttm'],
    uses: [],
    blocks: ['SECTION', 'CHART:revenue_by_segment', 'TABLE:revenue_by_segment', 'APPENDIX'],
  }),
  A({
    kind: 'FORECAST_VS_ACTUAL', title: 'Forecast against actual',
    purpose: 'The last three forecasts set against what happened.',
    requires: [],
    uses: [],
    blocks: ['SECTION', 'CHART:forecast_variance', 'TABLE:forecast_variance', 'APPENDIX'],
  }),
  A({
    kind: 'USE_OF_FUNDS', title: 'Use of funds', path: 'RAISE',
    purpose: 'What the money is for, and what it buys.',
    requires: ['raise.target_amount'],
    uses: [],
    blocks: ['SECTION', 'TABLE:use_of_funds', 'CHART:use_of_funds', 'APPENDIX'],
  }),
  A({
    kind: 'WORKING_CAPITAL', title: 'Working capital analysis', path: 'SALE',
    purpose: 'The normal level of working capital, for the completion mechanism.',
    requires: [],
    uses: [],
    blocks: ['SECTION', 'CHART:working_capital', 'TABLE:working_capital', 'APPENDIX'],
  }),

  A({
    kind: 'FORECAST_CREDIBILITY', title: 'Forecast credibility record',
    purpose: 'Forecasts set against actuals, with the variances explained — criterion 2.4, '
           + 'by record rather than by assertion.',
    requires: [], uses: [],
    blocks: ['COVER', 'KPI_ROW', 'SECTION', 'TABLE:forecast_cycles', 'CHART:forecast_variance',
      'TABLE:variance_register', 'DISCLAIMER'],
  }),
  A({
    kind: 'BOARD_PACK', title: 'Board pack',
    purpose: 'The month, from the same facts everything else is built from.',
    requires: [],
    uses: ['financials.revenue.ttm', 'financials.arr', 'people.headcount'],
    blocks: ['COVER', 'KPI_ROW', 'CHART:revenue_trend', 'SECTION', 'TABLE:variance_register',
      'TABLE:kpi', 'SECTION', 'TABLE:gap_register', 'APPENDIX', 'DISCLAIMER'],
  }),
  A({
    kind: 'INVESTOR_UPDATE', title: 'Investor update',
    purpose: 'What moved this period, and why — written once, from the record.',
    requires: [],
    uses: ['financials.arr', 'financials.runway_months'],
    blocks: ['SECTION', 'KPI_ROW', 'PROSE', 'TABLE:variance_register', 'CHART:revenue_trend', 'DISCLAIMER'],
  }),

  // ── corporate ────────────────────────────────────────────────────────────
  A({
    kind: 'CAP_TABLE', title: 'Capitalisation table',
    purpose: 'Who owns what, fully diluted, reconciled.',
    requires: [],
    uses: ['cap_table.fully_diluted_shares'],
    blocks: ['SECTION', 'TABLE:cap_table', 'CHART:ownership', 'APPENDIX'],
  }),
  A({
    kind: 'DILUTION_WATERFALL', title: 'Dilution waterfall',
    purpose: 'Every instrument modelled through to shares.',
    requires: [],
    uses: ['cap_table.fully_diluted_shares'],
    blocks: ['SECTION', 'TABLE:waterfall', 'CHART:dilution', 'APPENDIX'],
  }),
  A({
    kind: 'OPTION_LEDGER', title: 'Option ledger',
    purpose: 'Every grant, approved and documented.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:options', 'APPENDIX'],
  }),

  // ── commercial ───────────────────────────────────────────────────────────
  A({
    kind: 'CUSTOMER_CONCENTRATION', title: 'Customer concentration',
    purpose: 'Top customers by revenue and by gross profit, with the trend.',
    requires: ['commercial.concentration.top1'],
    uses: ['commercial.concentration.top3', 'commercial.concentration.top5',
      'commercial.concentration.top1.prior', 'commercial.concentration.direction'],
    blocks: ['SECTION', 'KPI_ROW', 'CHART:concentration', 'CHART:concentration_trend',
      'TABLE:top_customers', 'APPENDIX'],
  }),
  A({
    kind: 'CONTRACT_REGISTER', title: 'Contract register',
    purpose: 'Every material agreement, with its change-of-control position.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:contract_register', 'APPENDIX'],
  }),
  A({
    kind: 'PIPELINE_SUMMARY', title: 'Pipeline summary',
    purpose: 'What is in front of the business, weighted consistently.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:pipeline', 'CHART:pipeline', 'APPENDIX'],
  }),

  // ── people ───────────────────────────────────────────────────────────────
  A({
    kind: 'ORG_CHART', title: 'Organisation chart',
    purpose: 'How the business is structured, and where it depends on individuals.',
    requires: [], uses: ['people.headcount'],
    blocks: ['SECTION', 'CHART:org', 'TABLE:key_people', 'APPENDIX'],
  }),
  A({
    kind: 'KEY_PERSON_REGISTER', title: 'Key-person register',
    purpose: 'What each person uniquely holds, and who could cover it.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:key_people', 'PROSE', 'APPENDIX'],
  }),

  // ── market, the only externally sourced document ─────────────────────────
  A({
    kind: 'MARKET_SECTION', title: 'Market context',
    purpose: 'The market, built only from sources a reader can check.',
    requires: [], uses: [],
    blocks: ['SECTION', 'PROSE:market', 'CHART:market', 'EVIDENCE', 'DISCLAIMER'],
    external_only: true,
  }),

  // ── process and the room ─────────────────────────────────────────────────
  A({
    kind: 'DATA_ROOM_INDEX', title: 'Data room index',
    purpose: 'Contents, with what is present and what is reasoned away.',
    requires: [], uses: [],
    blocks: ['SECTION', 'CHECKLIST', 'TABLE:room_index'],
  }),
  A({
    kind: 'DILIGENCE_TRACKER', title: 'Diligence request tracker',
    purpose: 'Every request, its owner and its status.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:diligence', 'CHART:diligence_progress'],
  }),
  A({
    kind: 'QA_LOG', title: 'Question and answer log',
    purpose: 'Every answer given to any party, so they stay consistent.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:qa_log'],
  }),
  A({
    kind: 'READINESS_REPORT', title: 'Readiness report',
    purpose: 'The score, the band, and what sits behind them.',
    requires: [], uses: [],
    blocks: ['COVER', 'KPI_ROW', 'CHART:readiness_radar', 'TABLE:domain_scores',
      'SECTION', 'TABLE:gap_register', 'CHART:gap_plan', 'DISCLAIMER'],
  }),
  A({
    kind: 'VALUATION_READINESS', title: 'Valuation readiness pack',
    purpose: 'Everything an independent valuer will ask you to evidence, and what you have.',
    requires: ['company.name'],
    uses: ['financials.reported_profit', 'financials.normalised_earnings',
      'commercial.concentration.top1', 'commercial.retention.net'],
    // No SECTION break: every block below carries its own heading, and an extra
    // one left the artifact's title stranded mid-page above a half-empty sheet.
    blocks: ['COVER', 'PROSE', 'TABLE:valuation_evidence',
      'TABLE:normalisation', 'CHART:normalisation_bridge', 'CHART:concentration',
      'EVIDENCE', 'APPENDIX', 'DISCLAIMER'],
  }),
  A({
    kind: 'GAP_PLAN', title: 'Gap plan',
    purpose: 'The work, in fix order, with owners and dates.',
    requires: [], uses: [],
    blocks: ['SECTION', 'CHART:gap_plan', 'TABLE:gap_register'],
  }),
  A({
    kind: 'DISCLOSURE_SCHEDULE', title: 'Disclosure schedule', path: 'SALE',
    purpose: 'What is being disclosed against the warranties.',
    requires: [], uses: [],
    blocks: ['SECTION', 'TABLE:disclosures', 'DISCLAIMER'],
  }),
  A({
    kind: 'PROVENANCE_APPENDIX', title: 'Provenance appendix',
    purpose: 'Every figure used, where it came from, and who confirmed it.',
    requires: [], uses: [],
    blocks: ['SECTION', 'APPENDIX'],
  }),
]);

const byKind = new Map(ARTIFACTS.map((a) => [a.kind, a]));
export const artifactSpec = (kind) => byKind.get(kind) ?? null;
export const ARTIFACT_KINDS = Object.freeze(ARTIFACTS.map((a) => a.kind));

/** Artifacts applicable to a company's chosen path. */
export function artifactsForPath(path) {
  const want = PATHS.includes(path) ? path : 'BOTH';
  return ARTIFACTS.filter((a) => a.path === 'BOTH' || want === 'BOTH' || a.path === want);
}

// ────────────────────────────────────────────────────────── the gate ──

/**
 * Decide whether an artifact can be generated, and say exactly why not.
 *
 * Four classes of blocker, in the order a user should deal with them.
 *
 * @param {object} spec      the catalogue entry
 * @param {object} context   { facts, conflicts, externalClaims, assets, path }
 */
export function generationBlockers(spec, context = {}) {
  const {
    facts = [], unresolvedHighConflicts = [], externalClaimBlockers = [],
    assetProblems = [], path = 'BOTH',
  } = context;

  const blockers = [];
  const present = new Set(facts.map((f) => f.fact_key));

  // 1 — contradictions. Rendering a document from facts known to disagree puts
  //     the product's name on the contradiction.
  if (unresolvedHighConflicts.length) {
    blockers.push({
      code: 'unresolved_conflicts',
      problem: `${unresolvedHighConflicts.length} unresolved contradiction`
             + `${unresolvedHighConflicts.length === 1 ? '' : 's'} between your own records. `
             + 'Settle those first — a generated document is only as good as the facts under it.',
      detail: unresolvedHighConflicts.map((c) => c.detail ?? c.id),
    });
  }

  // 2 — required facts.
  const missing = (spec.requires ?? []).filter((k) => !present.has(k));
  if (missing.length) {
    blockers.push({
      code: 'missing_required_facts',
      problem: `This document cannot be built without ${missing.join(', ')}. `
             + 'Nothing is filled in with a placeholder, because a placeholder in a document that leaves '
             + 'the building becomes a real number to whoever reads it.',
      detail: missing,
    });
  }

  // 3 — external claims that cannot be cited properly.
  if (externalClaimBlockers.length) {
    blockers.push({
      code: 'uncitable_external_claims',
      problem: `${externalClaimBlockers.length} external claim`
             + `${externalClaimBlockers.length === 1 ? '' : 's'} cannot be rendered: `
             + 'a market statement without a complete, in-date citation is the thing a reader checks first.',
      detail: externalClaimBlockers,
    });
  }

  // 4 — images that would print badly.
  if (assetProblems.length) {
    blockers.push({
      code: 'asset_quality',
      problem: 'An image would print below the quality floor. A blurry logo is the first thing a reader '
             + 'sees and the easiest thing to fix.',
      detail: assetProblems,
    });
  }

  // Path mismatch is a warning, not a blocker — a company that has not decided
  // between raising and selling should still be able to produce either.
  const pathMismatch = spec.path !== 'BOTH' && path !== 'BOTH' && spec.path !== path;

  return { blockers, warnings: pathMismatch ? [{ code: 'path_mismatch', problem: `${spec.kind} is a ${spec.path} document and this company is on the ${path} path.` }] : [] };
}

/** What an artifact would be missing if it were generated now. Advisory. */
export function coverage(spec, facts = []) {
  const present = new Set(facts.map((f) => f.fact_key));
  const required = spec.requires ?? [];
  const optional = spec.uses ?? [];
  const have = [...required, ...optional].filter((k) => present.has(k));
  const total = required.length + optional.length;

  return {
    required_present: required.filter((k) => present.has(k)).length,
    required_total: required.length,
    optional_present: optional.filter((k) => present.has(k)).length,
    optional_total: optional.length,
    missing_optional: optional.filter((k) => !present.has(k)),
    percent: total ? Math.round((have.length / total) * 100) : 100,
  };
}
