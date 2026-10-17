/**
 * A worked example, generated end to end through the real pipeline.
 *
 *   node tools/worked-example.mjs
 *
 * Builds a company with confirmed facts, a scored assessment, a gap register, a
 * built room and one properly cited external source, then generates artifacts
 * and renders them. Every figure that appears is a reference resolved at render
 * time; none is typed into this file as prose.
 *
 * ILLUSTRATIVE ONLY. Not a real company, client, engagement, or performance
 * result. All names, figures, workflows, and outcomes are invented for teaching
 * purposes.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { freshDb, ctxFor, fakeStorage } from '../test/helpers.js';
import * as svc from '../src/api/service.js';
import * as assessments from '../src/api/assessments.js';
import * as dataroom from '../src/api/dataroom.js';
import * as artifacts from '../src/api/artifacts.js';
import { ALL_REFS } from '../src/domain/criteria.js';
import { renderPdf } from './render.mjs';

const db = freshDb();
const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
const storage = fakeStorage();

const org = svc.createOrganisation(ctx, {
  name: 'Northwind Systems', path: 'RAISE', currency: 'USD', target_amount: 6_000_000,
}).body.organisation;

// ── a confirmed source document, then facts read from it ────────────────────
function internalDoc(filename) {
  const d = svc.createUploadTicket(ctx, org.id, {
    filename, size_bytes: 400_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, d.id);
  return d.id;
}

const accounts = internalDoc('Northwind-management-accounts-FY2025.pdf');
const deck = internalDoc('Northwind-board-pack-Q2-2026.pdf');

const confirmed = (factKey, label, value, opts = {}) => svc.createFact(ctx, org.id, {
  fact_key: factKey, label, value_numeric: value, unit: opts.unit ?? 'USD',
  period_start: opts.start ?? null, period_end: opts.end ?? null,
  source: 'USER_CONFIRMED', source_doc_id: opts.doc ?? accounts, source_page: opts.page ?? 3,
}).body.fact;

svc.createFact(ctx, org.id, {
  fact_key: 'company.name', label: 'Registered name',
  value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
});

// Revenue across four years, which is what makes a trend possible.
const years = [
  ['2022-01-01', '2022-12-31', 1_850_000],
  ['2023-01-01', '2023-12-31', 2_410_000],
  ['2024-01-01', '2024-12-31', 3_120_000],
  ['2025-01-01', '2025-12-31', 3_600_000],
];
for (const [start, end, value] of years) {
  confirmed('financials.revenue.ttm', 'Revenue', value, { start, end, page: 4 });
}

confirmed('financials.cogs.ttm', 'Cost of sales', 1_300_000, { start: '2025-01-01', end: '2025-12-31', page: 4 });
confirmed('financials.gross_margin', 'Gross margin', 63.9, { unit: 'percent', start: '2025-01-01', end: '2025-12-31', page: 4 });
confirmed('financials.arr', 'Annual recurring revenue', 3_800_000, { end: '2026-06-30', page: 6, doc: deck });
confirmed('financials.reported_profit', 'Reported profit', 420_000, { start: '2025-01-01', end: '2025-12-31', page: 9 });
confirmed('financials.normalised_earnings', 'Normalised earnings', 610_000, { start: '2025-01-01', end: '2025-12-31', page: 11 });

for (const [i, [label, value]] of [
  ['Owner remuneration above market', 145_000],
  ['One-off legal costs', 68_000],
  ['Discontinued product line', -42_000],
  ['Lease normalisation', 19_000],
].entries()) {
  confirmed(`financials.adjustment.${i + 1}`, label, value, { page: 11 });
}

confirmed('people.headcount', 'Headcount', 38, { unit: 'count', end: '2026-06-30', page: 2, doc: deck });
confirmed('commercial.concentration.top1', 'Top customer share of revenue', 44.3, { unit: 'percent', page: 14 });
confirmed('commercial.concentration.top3', 'Top 3 customers share of revenue', 72.4, { unit: 'percent', page: 14 });
confirmed('commercial.concentration.top5', 'Top 5 customers share of revenue', 84.9, { unit: 'percent', page: 14 });
confirmed('commercial.concentration.top1.prior', 'Top customer share, two years ago', 31.0, { unit: 'percent', page: 14 });

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
  confirmed(`cap_table.holder.${i + 1}`, name, pct, { unit: 'percent', page: 2 });
}

svc.createFact(ctx, org.id, {
  fact_key: 'people.key_person.1', label: 'Key-person dependency: A. Founder',
  value_text: 'A. Founder uniquely holds: every top-10 customer relationship. No deputy named.',
  source: 'USER_ENTERED',
});
svc.createFact(ctx, org.id, {
  fact_key: 'people.key_person.2', label: 'Key-person dependency: B. Shaw',
  value_text: 'B. Shaw uniquely holds: sole write access to production infrastructure. Deputy: C. Patel',
  source: 'USER_ENTERED',
});

// ── a properly cited external source ────────────────────────────────────────
const marketDoc = svc.createUploadTicket(ctx, org.id, {
  filename: 'Industry-body-logistics-software-review-2026.pdf',
  size_bytes: 900_000, mime_type: 'application/pdf', kind: 'OTHER',
}, storage).body.document;
svc.confirmUpload(ctx, org.id, marketDoc.id);

artifacts.addExternalSource(ctx, org.id, {
  document_id: marketDoc.id,
  source_kind: 'INDUSTRY_BODY',
  publisher: 'Illustrative Logistics Technology Council',
  title: 'Annual review of logistics software adoption',
  published_at: '2026-03-01',
  url: 'https://example.org/illustrative-review-2026',
  accessed_at: '2026-10-01',
  claim_class: 'MARKET_SIZE',
});

svc.createFact(ctx, org.id, {
  fact_key: 'market.segment_adoption',
  label: 'Share of mid-market operators running dedicated logistics software',
  value_text: 'Fewer than half of mid-market operators run dedicated logistics software, '
            + 'with adoption concentrated among the largest fleets.',
  source: 'USER_CONFIRMED', source_doc_id: marketDoc.id, source_page: 12,
});

// ── assessment, gaps, room ──────────────────────────────────────────────────
const scores = Object.fromEntries(ALL_REFS.map((ref) => {
  const weak = { '1.1': 2, '2.3': 2, '5.1': 1, '3.1': 2, '6.2': 2, '8.1': 3 };
  return [ref, weak[ref] ?? 4];
}));
const a = assessments.createAssessment(ctx, org.id, { label: 'Baseline' }).body.assessment;
assessments.scoreAssessment(ctx, org.id, a.id, scores);
assessments.completeAssessment(ctx, org.id, a.id);

// Dates on a few gaps, so the plan can be drawn as a timeline.
const gaps = assessments.listGaps(ctx, org.id).body.gaps;
const dues = ['2026-12-15', '2027-03-31', '2027-01-31', '2026-11-30', '2026-12-20'];
gaps.slice(0, 5).forEach((g, i) => {
  assessments.updateGap(ctx, org.id, g.id, { owner_user_id: 'u-founder', due_date: dues[i] });
});

dataroom.buildRoom(ctx, org.id);

// ── generate ────────────────────────────────────────────────────────────────
const PROSE = {
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

mkdirSync('out/example', { recursive: true });

const TARGETS = ['PITCH_DECK', 'READINESS_REPORT', 'NORMALISATION_BRIDGE',
  'CUSTOMER_CONCENTRATION', 'CAP_TABLE', 'DATA_ROOM_INDEX'];

const results = [];
for (const kind of TARGETS) {
  const res = artifacts.generate(ctx, org.id, kind, { prose: PROSE });
  if (res.body.blocked) {
    results.push({ kind, blocked: true, blockers: res.body.blockers });
    continue;
  }
  const file = `out/example/${kind}.html`;
  writeFileSync(file, res.body.html);
  results.push({
    kind, file,
    facts: res.body.fact_refs.length,
    citations: res.body.citations.length,
    missing: res.body.missing_optional,
    size: artifacts.listArtifacts(ctx, org.id).body.artifacts.find((x) => x.kind === kind),
  });
}

console.log('\nGenerated:\n');
for (const r of results) {
  if (r.blocked) {
    console.log(`  ✗ ${r.kind} — blocked: ${r.blockers.map((b) => b.code).join(', ')}`);
    continue;
  }
  console.log(`  ✓ ${r.kind.padEnd(24)} ${String(r.facts).padStart(3)} facts, `
    + `${r.citations} citation(s)${r.missing.length ? `, missing ${r.missing.length} optional` : ''}`);
}

// Render each to PDF.
const { artifactSpec } = await import('../src/domain/artifacts.js');
for (const r of results.filter((x) => !x.blocked)) {
  const spec = artifactSpec(r.kind);
  await renderPdf(r.file, r.file.replace('.html', '.pdf'), { size: spec.size });
}
console.log('\nPDFs written to out/example/\n');

// ── Phase 6: a cadence with history ─────────────────────────────────────────
const cadence = await import('../src/api/cadence.js');

const MONTHS = [
  ['2026-01-01', '2026-01-31', 290_000, 301_000, 'On plan.'],
  ['2026-02-01', '2026-02-28', 305_000, 214_000,
    'Two enterprise renewals slipped into March after a procurement freeze at both accounts. '
    + 'Both were signed by 14 March; neither was lost.'],
  ['2026-03-01', '2026-03-31', 320_000, 415_000,
    'The two February renewals landed in the month, plus an unplanned seat expansion at the largest '
    + 'account. Roughly 90,000 of this is February revenue arriving late.'],
];

for (const [start, end, forecastValue, actualValue, why] of MONTHS) {
  const f = cadence.createForecast(ctx, org.id, {
    label: `Monthly plan ${end.slice(0, 7)}`,
    basis: 'Built bottom-up from weighted pipeline and the prior month run rate.',
  }).body.forecast;

  cadence.addForecastLine(ctx, org.id, f.id, {
    fact_key: 'financials.revenue.mrr', label: 'Monthly revenue',
    value_numeric: forecastValue, period_start: start, period_end: end, unit: 'USD',
  });
  cadence.lockForecast(ctx, org.id, f.id);

  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.mrr', label: 'Monthly revenue',
    value_numeric: actualValue, unit: 'USD',
    period_start: start, period_end: end, source: 'USER_ENTERED',
  });

  const closed = cadence.closePeriod(ctx, org.id, { period_start: start, period_end: end });
  for (const v of closed.body.variances) {
    if (v.needs_explanation) cadence.explainVariance(ctx, org.id, v.id, { explanation: why });
  }
}

cadence.recomputeTrajectory(ctx, org.id, 'financials.revenue.mrr');

const report = cadence.credibilityReport(ctx, org.id).body;
console.log(`\nCadence: ${report.credibility.cycles_complete}/${report.credibility.cycles_needed} cycles, `
  + `criterion 2.4 ${report.credibility.meets_criterion ? 'satisfied' : 'not yet satisfied'}`);
console.log(`  ${report.credibility.statement}\n`);

for (const kind of ['FORECAST_CREDIBILITY', 'BOARD_PACK']) {
  const res = artifacts.generate(ctx, org.id, kind, { prose: PROSE });
  if (res.body.blocked) { console.log(`  ✗ ${kind} blocked`); continue; }
  const file = `out/example/${kind}.html`;
  writeFileSync(file, res.body.html);
  await renderPdf(file, file.replace('.html', '.pdf'), { size: artifactSpec(kind).size });
  console.log(`  ✓ ${kind.padEnd(24)} ${String(res.body.fact_refs.length).padStart(3)} facts`);
}
