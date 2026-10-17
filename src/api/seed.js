/**
 * The worked example, as a service function.
 *
 * ILLUSTRATIVE ONLY. Every figure, name and workflow below is invented. The
 * notice is carried on every page the seeded data appears on, and
 * `ILLUSTRATIVE_NOTICE` is the single copy of it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SERVICE FUNCTION AND NOT A FIXTURE
 *
 * An empty product teaches nothing. Somebody who signs in, sees twelve empty
 * sections and a readiness score of nothing cannot tell whether the product is
 * any good, and the thing they most need to understand — that a figure carries
 * where it came from — is invisible until there are figures.
 *
 * So the example is loaded through the same public service functions a user's
 * own data goes through. Not SQL inserts, not a database file shipped in the
 * repo. That has three consequences, and each is worth the extra work:
 *
 *   1. It cannot drift. If `createFact` gains a rule, the example obeys it or
 *      the suite goes red. A fixture inserted with raw SQL would quietly become
 *      data the product can no longer produce.
 *
 *   2. It audits. The example's rows carry the same audit trail as any other,
 *      so the audit page is populated and honest about who did what.
 *
 *   3. It is a test. `test/seed.test.js` loads it and asserts the product can
 *      actually generate documents from it, which exercises more of the system
 *      end to end than any unit test does.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF THE EXAMPLE
 *
 * The company is deliberately not a model citizen. Its largest customer is 44%
 * of revenue and rising, its founder holds every top-ten relationship with no
 * deputy named, and two of its monthly forecasts missed. A demonstration
 * company that scores well everywhere would show none of the product's actual
 * work, which is finding the thing a counterparty will ask about and saying it
 * first.
 */

import { AccessError } from '../domain/access.js';
import * as svc from './service.js';
import * as assessments from './assessments.js';
import * as dataroom from './dataroom.js';
import * as artifacts from './artifacts.js';
import * as cadence from './cadence.js';
import * as prose from './prose.js';
import * as billing from './billing.js';
import { ALL_REFS } from '../domain/criteria.js';
import { ILLUSTRATIVE_NOTICE, ILLUSTRATIVE_MARKER_KEY } from '../domain/illustrative.js';

// Re-exported under the names this module has always used, so every existing
// caller and test keeps working. The strings themselves moved to
// `domain/illustrative.js` because the renderer needs them too, and the
// renderer cannot import this file — this one generates documents, so it
// already depends on the renderer.
export { ILLUSTRATIVE_NOTICE };
export const SEED_MARKER_KEY = ILLUSTRATIVE_MARKER_KEY;

export const EXAMPLE_COMPANY = 'Northwind Systems';

/** Is this organisation the worked example? Pages ask, to show the notice. */
export function isSeeded(ctx, orgId) {
  return Boolean(ctx.db.findOne('fact', { org_id: orgId, fact_key: SEED_MARKER_KEY }));
}

/**
 * Load the worked example into an organisation.
 *
 * Refuses on an organisation that already holds it, and refuses on one that has
 * real data — mixing invented figures into a company's own data room is the one
 * unrecoverable mistake this function could make, because afterwards nobody can
 * tell which figures were theirs.
 */
export function seedWorkedExample(ctx, orgId, { generate = true, entitle = false } = {}) {
  // `authorise` runs inside every call below. This one is an owner-level act,
  // so it is checked here too, before anything is written.
  const membership = ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });
  if (!membership) throw new AccessError('not_found', 404);
  if (membership.role !== 'OWNER') {
    throw new AccessError('forbidden', 403, {
      detail: 'Loading the worked example writes figures into this organisation, so only an owner can do it.',
    });
  }

  if (isSeeded(ctx, orgId)) {
    throw new AccessError('already_seeded', 409, {
      detail: 'This organisation already holds the worked example.',
    });
  }

  const existing = ctx.db.find('fact', { org_id: orgId }).filter((f) => !f.superseded_by);
  if (existing.length) {
    throw new AccessError('already_seeded', 409, {
      detail: 'This organisation already has figures of its own recorded. The worked example is only '
            + 'loaded into an empty organisation, because once invented figures and real ones are in '
            + 'the same data room nobody can tell them apart afterwards.',
    });
  }

  const storage = ctx.storage ?? nullStorage();

  // A demonstration that stops at a paywall demonstrates the paywall. The grant
  // is a real, marked subscription row rather than a hole in the gate — see
  // `grantDemonstration` for why that distinction is the whole point.
  if (entitle) billing.grantDemonstration(ctx, orgId, { reason: 'Worked example' });

  svc.createFact(ctx, orgId, {
    fact_key: SEED_MARKER_KEY, label: 'Illustrative example',
    value_text: ILLUSTRATIVE_NOTICE, source: 'USER_ENTERED',
  });

  // ── source documents ─────────────────────────────────────────────────────
  const internalDoc = (filename, kind) => {
    const d = svc.createUploadTicket(ctx, orgId, {
      filename, size_bytes: 400_000, mime_type: 'application/pdf', kind,
    }, storage).body.document;
    svc.confirmUpload(ctx, orgId, d.id);
    return d.id;
  };

  const accounts = internalDoc('Northwind-management-accounts-FY2025.pdf', 'ACCOUNTS');
  const deck = internalDoc('Northwind-board-pack-Q2-2026.pdf', 'DECK');
  const capTable = internalDoc('Northwind-cap-table-2026-06.xlsx', 'CAP_TABLE');

  // ── figures, every one carrying a document and a page ────────────────────
  const confirmed = (factKey, label, value, opts = {}) => svc.createFact(ctx, orgId, {
    fact_key: factKey, label, value_numeric: value, unit: opts.unit ?? 'USD',
    period_start: opts.start ?? null, period_end: opts.end ?? null,
    source: 'USER_CONFIRMED', source_doc_id: opts.doc ?? accounts, source_page: opts.page ?? 3,
  }).body.fact;

  svc.createFact(ctx, orgId, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });

  for (const [start, end, value] of [
    ['2022-01-01', '2022-12-31', 1_850_000],
    ['2023-01-01', '2023-12-31', 2_410_000],
    ['2024-01-01', '2024-12-31', 3_120_000],
    ['2025-01-01', '2025-12-31', 3_600_000],
  ]) {
    confirmed('financials.revenue.ttm', 'Revenue', value, { start, end, page: 4 });
  }

  const FY25 = { start: '2025-01-01', end: '2025-12-31' };
  confirmed('financials.cogs.ttm', 'Cost of sales', 1_300_000, { ...FY25, page: 4 });
  confirmed('financials.gross_margin', 'Gross margin', 63.9, { unit: 'percent', ...FY25, page: 4 });
  confirmed('financials.arr', 'Annual recurring revenue', 3_800_000, { end: '2026-06-30', page: 6, doc: deck });
  confirmed('financials.reported_profit', 'Reported profit', 420_000, { ...FY25, page: 9 });
  confirmed('financials.normalised_earnings', 'Normalised earnings', 610_000, { ...FY25, page: 11 });

  for (const [i, [label, value]] of [
    ['Owner remuneration above market', 145_000],
    ['One-off legal costs', 68_000],
    ['Discontinued product line', -42_000],
    ['Lease normalisation', 19_000],
  ].entries()) {
    confirmed(`financials.adjustment.${i + 1}`, label, value, { page: 11 });
  }

  confirmed('people.headcount', 'Headcount', 38, { unit: 'count', end: '2026-06-30', page: 2, doc: deck });

  // The concentration, which is the example's most instructive feature: it is
  // getting worse, and the product's job is to make the company say so first.
  confirmed('commercial.concentration.top1', 'Top customer share of revenue', 44.3, { unit: 'percent', page: 14 });
  confirmed('commercial.concentration.top3', 'Top 3 customers share of revenue', 72.4, { unit: 'percent', page: 14 });
  confirmed('commercial.concentration.top5', 'Top 5 customers share of revenue', 84.9, { unit: 'percent', page: 14 });
  confirmed('commercial.concentration.top1.prior', 'Top customer share, two years ago', 31.0,
    { unit: 'percent', page: 14 });

  for (const [i, [label, value]] of [
    ['Engineering hires', 2_600_000],
    ['Commercial expansion', 1_900_000],
    ['Platform and security', 900_000],
    ['Working capital', 600_000],
  ].entries()) {
    confirmed(`raise.use_of_funds.${i + 1}`, label, value, { page: 21, doc: deck });
  }
  confirmed('raise.target_amount', 'Target raise', 6_000_000, { page: 20, doc: deck });

  for (const [i, [name, pct]] of [
    ['Founders', 54.2], ['Seed investors', 22.7], ['Series A', 14.6], ['Option pool', 8.5],
  ].entries()) {
    confirmed(`cap_table.holder.${i + 1}`, name, pct, { unit: 'percent', page: 2, doc: capTable });
  }

  svc.createFact(ctx, orgId, {
    fact_key: 'people.key_person.1', label: 'Key-person dependency: A. Founder',
    value_text: 'A. Founder uniquely holds: every top-10 customer relationship. No deputy named.',
    source: 'USER_ENTERED',
  });
  svc.createFact(ctx, orgId, {
    fact_key: 'people.key_person.2', label: 'Key-person dependency: B. Shaw',
    value_text: 'B. Shaw uniquely holds: sole write access to production infrastructure. Deputy: C. Patel',
    source: 'USER_ENTERED',
  });

  // ── one properly cited external source ───────────────────────────────────
  const marketDoc = svc.createUploadTicket(ctx, orgId, {
    filename: 'Industry-body-logistics-software-review-2026.pdf',
    size_bytes: 900_000, mime_type: 'application/pdf', kind: 'OTHER',
  }, storage).body.document;
  svc.confirmUpload(ctx, orgId, marketDoc.id);

  artifacts.addExternalSource(ctx, orgId, {
    document_id: marketDoc.id,
    source_kind: 'INDUSTRY_BODY',
    publisher: 'Illustrative Logistics Technology Council',
    title: 'Annual review of logistics software adoption',
    published_at: '2026-03-01',
    url: 'https://example.org/illustrative-review-2026',
    accessed_at: '2026-10-01',
    claim_class: 'MARKET_SIZE',
  });

  svc.createFact(ctx, orgId, {
    fact_key: 'market.segment_adoption',
    label: 'Share of mid-market operators running dedicated logistics software',
    value_text: 'Fewer than half of mid-market operators run dedicated logistics software, '
              + 'with adoption concentrated among the largest fleets.',
    source: 'USER_CONFIRMED', source_doc_id: marketDoc.id, source_page: 12,
  });

  // ── assessment and gap register ──────────────────────────────────────────
  const weak = { '1.1': 2, '2.3': 2, '5.1': 1, '3.1': 2, '6.2': 2, '8.1': 3 };
  const scores = Object.fromEntries(ALL_REFS.map((ref) => [ref, weak[ref] ?? 4]));
  const a = assessments.createAssessment(ctx, orgId, { label: 'Baseline' }).body.assessment;
  assessments.scoreAssessment(ctx, orgId, a.id, scores);
  assessments.completeAssessment(ctx, orgId, a.id);

  const gaps = assessments.listGaps(ctx, orgId).body.gaps;
  const dues = ['2026-12-15', '2027-03-31', '2027-01-31', '2026-11-30', '2026-12-20'];
  gaps.slice(0, 5).forEach((g, i) => {
    assessments.updateGap(ctx, orgId, g.id, { owner_user_id: ctx.auth.userId, due_date: dues[i] });
  });

  try { dataroom.buildRoom(ctx, orgId); } catch { /* an org created through the UI already has one */ }

  // ── the room, half filled ────────────────────────────────────────────────
  //
  // Half, deliberately. A room at zero shows nothing, and a room at 37 of 37
  // shows a company with no work left, which is not a company that needs this
  // product. Half is also where the interesting states live: items filed, items
  // open, and two marked not-applicable with a written reason — which is the
  // one state people get wrong, because "N/A" with no reason reads to a
  // counterparty as missing with better manners.
  const items = new Map(ctx.db.find('data_room_item', { org_id: orgId })
    .map((i) => [i.item_ref, i]));

  for (const [ref, filename, kind] of ROOM_FILINGS) {
    const item = items.get(ref);
    if (!item) continue;
    const docId = internalDoc(filename, kind);
    try { dataroom.satisfyItem(ctx, orgId, item.id, docId); } catch { /* not in this path's room */ }
  }

  for (const [ref, reason] of ROOM_NOT_APPLICABLE) {
    const item = items.get(ref);
    if (!item) continue;
    try { dataroom.markNotApplicable(ctx, orgId, item.id, reason); } catch { /* not in this path's room */ }
  }

  // ── three closed monthly cycles, two of which missed ─────────────────────
  //
  // The forecast ledger is a paid capability, and the seed does not pick a hole
  // in that for its own convenience. On a plan without it the cycles are
  // skipped and said to be skipped, which shows the gate working rather than
  // pretending the product has no gates.
  const skipped = [];
  try {
    for (const [start, end, forecastValue, actualValue, why] of MONTHS) {
      const f = cadence.createForecast(ctx, orgId, {
        label: `Monthly plan ${end.slice(0, 7)}`,
        basis: 'Built bottom-up from weighted pipeline and the prior month run rate.',
      }).body.forecast;

      cadence.addForecastLine(ctx, orgId, f.id, {
        fact_key: 'financials.revenue.mrr', label: 'Monthly revenue',
        value_numeric: forecastValue, period_start: start, period_end: end, unit: 'USD',
      });
      cadence.lockForecast(ctx, orgId, f.id);

      svc.createFact(ctx, orgId, {
        fact_key: 'financials.revenue.mrr', label: 'Monthly revenue',
        value_numeric: actualValue, unit: 'USD',
        period_start: start, period_end: end, source: 'USER_ENTERED',
      });

      const closed = cadence.closePeriod(ctx, orgId, { period_start: start, period_end: end });
      for (const v of closed.body.variances) {
        if (v.needs_explanation) cadence.explainVariance(ctx, orgId, v.id, { explanation: why });
      }
    }
    cadence.recomputeTrajectory(ctx, orgId, 'financials.revenue.mrr');
  } catch (err) {
    if (err.code !== 'not_in_plan') throw err;
    skipped.push({
      what: 'The three closed forecast cycles',
      why: err.message,
      available_in: err.available_in ?? [],
    });
  }

  // ── the written passages ─────────────────────────────────────────────────
  //
  // Stored as prose blocks as well as handed to the generator. An earlier
  // version only passed them through, which produced documents containing
  // paragraphs that existed nowhere the user could find — so the writing page
  // in the worked example was empty and the translation queue had nothing in
  // it, which made two of the twelve phases invisible in the one organisation
  // built to demonstrate them.
  //
  // Every figure in these is a reference, so they pass the same check a user's
  // prose passes. If one ever stops passing, the example should fail loudly
  // rather than quietly drop a passage: the whole point of it is that it is
  // subject to the product's own rules.
  const written = [];
  for (const [slot, paragraphs] of Object.entries(EXAMPLE_PROSE)) {
    written.push(prose.writeProse(ctx, orgId, slot, paragraphs.join('\n\n')).body.prose);
  }

  // ── the documents ────────────────────────────────────────────────────────
  const produced = [];
  if (generate) {
    for (const kind of GENERATED_KINDS) {
      try {
        const res = artifacts.generate(ctx, orgId, kind, { prose: EXAMPLE_PROSE });
        produced.push({
          kind,
          blocked: Boolean(res.body.blocked),
          blockers: res.body.blockers?.map((b) => b.code) ?? [],
          facts: res.body.fact_refs?.length ?? 0,
          citations: res.body.citations?.length ?? 0,
        });
      } catch (err) {
        // A document that cannot be generated is information, not a failure of
        // the seed. The seed's job is to leave the organisation in a state the
        // product can work from, and it has.
        produced.push({ kind, blocked: true, blockers: [err.code ?? 'error'], facts: 0, citations: 0 });
      }
    }
  }

  return {
    status: 201,
    body: {
      organisation_id: orgId,
      company: EXAMPLE_COMPANY,
      notice: ILLUSTRATIVE_NOTICE,
      figures: ctx.db.find('fact', { org_id: orgId }).length,
      documents: ctx.db.find('document', { org_id: orgId }).length,
      gaps: gaps.length,
      passages: written.length,
      produced,
      skipped,
    },
  };
}

export const GENERATED_KINDS = [
  'READINESS_REPORT', 'PITCH_DECK', 'NORMALISATION_BRIDGE', 'CUSTOMER_CONCENTRATION',
  'CAP_TABLE', 'DATA_ROOM_INDEX', 'FORECAST_CREDIBILITY', 'BOARD_PACK',
  'VALUATION_READINESS',
];

/**
 * What is filed in the example's room, and against which item.
 *
 * These are register rows with filenames, which is what a data room index
 * genuinely is. No bytes sit behind them: there is no real set of accounts to
 * put there, and inventing a PDF of invented accounts would be a forgery rather
 * than an illustration.
 */
const ROOM_FILINGS = [
  ['01.2', 'Northwind-investor-deck-2026-Q3.pdf', 'DECK'],
  ['01.3', 'Northwind-use-of-funds-by-role.xlsx', 'MODEL'],
  ['02.1', 'Northwind-certificate-of-incorporation.pdf', 'CONSTITUTIONAL'],
  ['02.2', 'Northwind-amended-restated-certificate.pdf', 'CONSTITUTIONAL'],
  ['02.3', 'Northwind-board-minutes-2023-2026.pdf', 'CONSTITUTIONAL'],
  ['03.1', 'Northwind-cap-table-fully-diluted-2026-06.xlsx', 'CAP_TABLE'],
  ['03.3', 'Northwind-option-scheme-rules-and-grants.pdf', 'CONTRACT'],
  ['04.1', 'Northwind-statutory-accounts-FY2023-FY2025.pdf', 'ACCOUNTS'],
  ['04.2', 'Northwind-management-accounts-24-months.xlsx', 'ACCOUNTS'],
  ['04.4', 'Northwind-revenue-recognition-policy.pdf', 'OTHER'],
  ['04.6', 'Northwind-financial-model-driver-based.xlsx', 'MODEL'],
  ['04.7', 'Northwind-forecast-vs-actuals-3-cycles.xlsx', 'MODEL'],
  ['05.1', 'Northwind-retention-churn-expansion-definitions.pdf', 'OTHER'],
  ['06.1', 'Northwind-revenue-by-customer-24-months.xlsx', 'OTHER'],
  ['06.2', 'Northwind-customer-concentration-top-1-3-5.xlsx', 'OTHER'],
  ['07.2', 'Northwind-trade-marks-and-domains.pdf', 'OTHER'],
  ['07.4', 'Northwind-access-control-record.pdf', 'OTHER'],
  ['08.1', 'Northwind-employment-and-contractor-agreements.pdf', 'CONTRACT'],
  ['08.2', 'Northwind-key-person-register.pdf', 'OTHER'],
  ['09.3', 'Northwind-insurance-schedule-2026.pdf', 'OTHER'],
];

/**
 * The two items the example says do not apply, and why.
 *
 * Both reasons are the kind that survives a counterparty reading them: they say
 * what is true about the company, not that nobody got round to it.
 */
const ROOM_NOT_APPLICABLE = [
  ['04.8', 'The company has no debt, facilities, guarantees or security of any kind. The statutory '
         + 'accounts at 04.1 carry a nil balance on every relevant line.'],
  ['09.2', 'No disputes, claims or settlements in the last three years. Counsel has confirmed in '
         + 'writing that none is threatened or pending.'],
];

const MONTHS = [
  ['2026-01-01', '2026-01-31', 290_000, 301_000, 'On plan.'],
  ['2026-02-01', '2026-02-28', 305_000, 214_000,
    'Two enterprise renewals slipped into March after a procurement freeze at both accounts. '
    + 'Both were signed by 14 March; neither was lost.'],
  ['2026-03-01', '2026-03-31', 320_000, 415_000,
    'The two February renewals landed in the month, plus an unplanned seat expansion at the largest '
    + 'account. Roughly 90,000 of this is February revenue arriving late.'],
];

/**
 * The example's prose.
 *
 * Every figure in it is a `{{fact:…}}` reference, resolved at render time. Not
 * one number is typed into this file as prose, which is the same rule the
 * product enforces on its users and would be dishonest to exempt itself from.
 */
export const EXAMPLE_PROSE = {
  default: [
    'Northwind Systems sells fleet and routing software to mid-market logistics operators. '
    + 'Revenue reached {{fact:financials.revenue.ttm}} in the last full financial year, with annual '
    + 'recurring revenue of {{fact:financials.arr}} at the most recent measurement.',
    'The business is run by {{fact:people.headcount}} people. Its largest customer accounts for '
    + '{{fact:commercial.concentration.top1}} of revenue, up from '
    + '{{fact:commercial.concentration.top1.prior}} two years ago — a concentration the company is '
    + 'addressing and has chosen to disclose rather than wait to be asked about.',
  ],
  market: [
    'Adoption of dedicated logistics software among mid-market operators remains partial, with '
    + 'penetration concentrated among the largest fleets. The source for this is listed below; no '
    + 'market figure appears in this document that is not drawn from a cited, dated publication.',
  ],
  assumptions: [
    'Three assumptions carry the plan: that enterprise win rate holds as deal size rises, that net '
    + 'revenue retention stays above its current level, and that two senior engineering hires land in '
    + 'the first half. Each is stated so that it could be shown to be wrong.',
  ],
};

/**
 * Storage for a seed run with none configured.
 *
 * The example's source documents are register rows with no bytes behind them —
 * there is no real set of accounts to put there, and inventing a PDF of invented
 * accounts would be a forgery rather than an illustration. The rows carry the
 * filename and the page numbers the figures cite, which is what the provenance
 * display needs.
 */
function nullStorage() {
  return {
    presignUpload: (key) => ({ url: `about:blank#${key}`, method: 'PUT' }),
    presignDownload: (key) => ({ url: `about:blank#${key}` }),
    put: () => {}, get: () => null, has: () => false, remove: () => {},
  };
}
