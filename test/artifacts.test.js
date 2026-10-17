/**
 * Phase 5 — artifact generation.
 *
 * The claim being tested: a generated document contains no figure that was
 * typed, no external statement that cannot be checked, and no image that will
 * print badly — and where any of those cannot be guaranteed, the document is
 * refused rather than produced with a caveat.
 *
 * What is NOT tested here is whether the PDF looks good. That needs a browser
 * and eyes; `tools/proof-charts.mjs` and `tools/inkcheck.mjs` cover it, and
 * `tools/worked-example.mjs` generates a full set to look at.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as api from '../src/api/artifacts.js';
import * as assessments from '../src/api/assessments.js';
import { ALL_REFS } from '../src/domain/criteria.js';
import { ARTIFACTS, artifactSpec, generationBlockers, coverage } from '../src/domain/artifacts.js';
import { citationProblems, citationAge, claimBlockers, SOURCE_KINDS, CLAIM_CLASSES } from '../src/domain/evidence.js';
import { placementProblems, effectiveDpi, requiredPixels, MIN_DPI } from '../src/domain/assets.js';
import { FactBinder, renderBlock, AVAILABLE_CHARTS, AVAILABLE_TABLES, parseBlock } from '../src/render/blocks.js';
import { cohortHeatmap, barChart, lineChart, waterfallChart, donutChart, insufficientData, contrastOn, axisDecimals, setDecimals } from '../src/render/charts.js';
import { dataTable } from '../src/render/tables.js';
import { SERIES, formatNumber, toNumber, compactDecimalsFor, compactDecimalsAt, decimalsForScale, scaleOf, percentDecimals, niceScale } from '../src/render/theme.js';

function world({ path = 'RAISE' } = {}) {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path }).body.organisation;
  return { db, ctx, org, storage };
}

function docFor(ctx, org, storage, filename, kind = 'ACCOUNTS') {
  const d = svc.createUploadTicket(ctx, org.id, {
    filename, size_bytes: 1_000, mime_type: 'application/pdf', kind,
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, d.id);
  return d.id;
}

const confirmFact = (ctx, orgId, docId, key, label, value, extra = {}) =>
  svc.createFact(ctx, orgId, {
    fact_key: key, label, value_numeric: value, unit: extra.unit ?? 'USD',
    period_start: extra.start ?? null, period_end: extra.end ?? null,
    source: 'USER_CONFIRMED', source_doc_id: docId, source_page: extra.page ?? 3,
  }).body.fact;

/** The minimum a FINANCIAL_SUMMARY needs. */
function withFinancials(ctx, org, storage) {
  const doc = docFor(ctx, org, storage, 'accounts.pdf');
  confirmFact(ctx, org.id, doc, 'financials.revenue.ttm', 'Revenue', 3_600_000,
    { start: '2025-01-01', end: '2025-12-31' });
  confirmFact(ctx, org.id, doc, 'financials.gross_margin', 'Gross margin', 63.9, { unit: 'percent' });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });
  return doc;
}


/**
 * Just the financial summary table.
 *
 * Asserting against the whole page is not enough: the provenance appendix prints
 * every figure too, with its own formatting, so a table printing "3,600,000" with
 * no currency still leaves "$3,600,000" elsewhere in the HTML. A mutation
 * removing the table's formatting survived behind exactly that.
 */
function financialTable(html) {
  const m = html.match(/<caption>Financial summary<\/caption>[\s\S]*?<\/tbody>/);
  assert.ok(m, 'no financial summary table in the document');
  return m[0];
}

// ────────────────────────────────────────────── no figure is ever typed ──

test('every figure on a page is a reference, and the binder records each one', () => {
  const { ctx, org, storage } = world();
  const doc = withFinancials(ctx, org, storage);

  const res = api.generate(ctx, org.id, 'FINANCIAL_SUMMARY');
  assert.equal(res.status, 201);

  const refs = res.body.fact_refs;
  assert.ok(refs.length >= 2);

  // The appendix lists every fact the document rests on, and it is built from
  // the binder rather than from a list someone maintains — so it cannot drift.
  for (const id of refs) {
    assert.ok(res.body.html.includes('Where every figure came from'));
  }
  assert.match(res.body.html, /accounts\.pdf, p\.3/);
});

test('a fact reference in prose resolves; an unbound key renders as absent, never as a number', () => {
  const { ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  const res = api.generate(ctx, org.id, 'ONE_PAGER', {
    prose: {
      default: ['Revenue reached {{fact:financials.revenue.ttm}} and ARR is {{fact:financials.arr}}.'],
    },
  });

  // ARR was never recorded. It must not come back as 0, or as a guess.
  assert.match(res.body.html, /\$3,600,000|\$3\.6m/);
  assert.match(res.body.html, /class="absent"&gt;—|class="absent">—/);
  assert.doesNotMatch(res.body.html, /ARR is \$0/);
});

test('a missing required fact blocks generation rather than producing a placeholder', () => {
  const { ctx, org } = world();
  // NORMALISATION_BRIDGE requires both reported profit and normalised earnings.
  const res = api.generate(ctx, org.id, 'NORMALISATION_BRIDGE');

  assert.equal(res.body.blocked, true);
  const blocker = res.body.blockers.find((b) => b.code === 'missing_required_facts');
  assert.ok(blocker);
  assert.match(blocker.problem, /a placeholder in a document that leaves the building/);
  assert.deepEqual(blocker.detail.sort(),
    ['financials.normalised_earnings', 'financials.reported_profit']);
});

test('a blocked artifact is recorded with its reasons, not thrown away', () => {
  const { db, ctx, org } = world();
  api.generate(ctx, org.id, 'NORMALISATION_BRIDGE');

  const row = db.find('artifact', { org_id: org.id })[0];
  assert.equal(row.state, 'BLOCKED');
  assert.ok(JSON.parse(row.blocked_reason).length);
  assert.equal(row.generated_at, null);
});

test('an unresolved contradiction blocks every artifact', () => {
  const { db, ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  db.insert('conflict', {
    org_id: org.id, rule_ref: 'SK-1', kind: 'VALUE_MISMATCH', severity: 'HIGH',
    left_ref: 'fact:a', left_summary: 'ARR: USD 4,200,000', right_ref: 'fact:b',
    right_summary: 'ARR: USD 3,800,000', detail: 'ARR does not agree across sources',
    resolved_at: null, resolved_by: null, resolution: null, resolution_note: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });

  const res = api.generate(ctx, org.id, 'FINANCIAL_SUMMARY');
  assert.equal(res.body.blocked, true);
  assert.ok(res.body.blockers.some((b) => b.code === 'unresolved_conflicts'));
});

// ──────────────────────────────── external claims must be checkable ──

test('a market claim with no citation is not rendered', () => {
  const { ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  // An external document with no registered source behind it.
  const marketDoc = docFor(ctx, org, storage, 'market-report.pdf', 'OTHER');
  ctx.db.update('document', marketDoc, { provenance_class: 'EXTERNAL' });
  svc.createFact(ctx, org.id, {
    fact_key: 'market.size', label: 'Market size',
    value_text: 'The market is large and growing quickly.',
    source: 'USER_CONFIRMED', source_doc_id: marketDoc, source_page: 4,
  });

  const res = api.generate(ctx, org.id, 'MARKET_SECTION');
  assert.equal(res.body.blocked, true);
  const blocker = res.body.blockers.find((b) => b.code === 'uncitable_external_claims');
  assert.ok(blocker, 'a market statement a reader cannot check is the first thing they will question');
});

test('a complete citation lets the claim through, with its quote', () => {
  const { ctx, org, storage } = world();
  const marketDoc = docFor(ctx, org, storage, 'industry-review.pdf', 'OTHER');

  api.addExternalSource(ctx, org.id, {
    document_id: marketDoc, source_kind: 'INDUSTRY_BODY',
    publisher: 'Illustrative Industry Council', title: 'Annual review',
    published_at: '2026-03-01', url: 'https://example.org/review',
    accessed_at: '2026-10-01', claim_class: 'MARKET_SIZE',
  });

  svc.createFact(ctx, org.id, {
    fact_key: 'market.adoption', label: 'Adoption among mid-market operators',
    value_text: 'Fewer than half of mid-market operators run dedicated software.',
    source: 'USER_CONFIRMED', source_doc_id: marketDoc, source_page: 12,
  });

  const res = api.generate(ctx, org.id, 'MARKET_SECTION');
  assert.equal(res.status, 201);
  assert.equal(res.body.citations.length, 1);
  assert.match(res.body.html, /Illustrative Industry Council/);
  assert.match(res.body.html, /Fewer than half of mid-market operators/);
  assert.match(res.body.html, /p\. 12/);
});

test('registering a source with an incomplete citation is refused outright', () => {
  const { ctx, org } = world();
  // No draft state for a half-cited source: a half-cited source is exactly what
  // ends up in a deck when somebody means to come back to it.
  expectRefusal(() => api.addExternalSource(ctx, org.id, {
    source_kind: 'ANALYST_REPORT', publisher: 'Someone', title: 'A report',
  }), 'incomplete_citation', 400);
});

test('every part a reader needs to check a figure is required', () => {
  const problems = citationProblems({});
  const fields = problems.map((p) => p.field);
  for (const required of ['publisher', 'title', 'published_at', 'locator', 'quote', 'url']) {
    assert.ok(fields.includes(required), `${required} must be required`);
  }
  assert.match(problems.find((p) => p.field === 'publisher').problem,
    /cannot be checked by anybody/);
});

test('a URL with no access date is refused — pages change and disappear', () => {
  const problems = citationProblems({
    publisher: 'P', title: 'T', published_at: '2026-01-01', locator: 'p.4',
    source_kind: 'NEWS', quote: 'x'.repeat(30), url: 'https://example.org/a',
  });
  assert.deepEqual(problems.map((p) => p.field), ['accessed_at']);
});

test('a market figure ages out, and a historical fact does not', () => {
  const asOf = '2026-10-13T00:00:00.000Z';
  const old = { published_at: '2021-01-01', claim_class: 'MARKET_SIZE' };
  assert.equal(citationAge(old, asOf).state, 'STALE');

  const historical = { published_at: '1998-01-01', claim_class: 'HISTORICAL' };
  assert.equal(citationAge(historical, asOf).state, 'TIMELESS',
    'the year a regulation took effect is still the year it took effect');

  const recent = { published_at: '2026-03-01', claim_class: 'MARKET_SIZE' };
  assert.equal(citationAge(recent, asOf).state, 'CURRENT');
});

test('a stale citation blocks the claim', () => {
  const claim = {
    fact: { source: 'USER_CONFIRMED' }, provenance_class: 'EXTERNAL',
    citation: {
      publisher: 'P', title: 'T', published_at: '2019-01-01', locator: 'p.1',
      source_kind: 'ANALYST_REPORT', quote: 'x'.repeat(30),
      url: 'https://example.org', accessed_at: '2026-10-01', claim_class: 'MARKET_SIZE',
    },
  };
  const blockers = claimBlockers(claim, '2026-10-13T00:00:00.000Z');
  assert.ok(blockers.some((b) => b.code === 'stale_citation'));
});

test('a market figure sourced to an internal document is refused', () => {
  const claim = {
    fact: { source: 'USER_CONFIRMED' }, provenance_class: 'INTERNAL',
    citation: {
      publisher: 'P', title: 'T', published_at: '2026-01-01', locator: 'p.1',
      source_kind: 'NEWS', quote: 'x'.repeat(30), url: 'https://e.org',
      accessed_at: '2026-10-01', claim_class: 'MARKET_SIZE',
    },
  };
  const blockers = claimBlockers(claim, '2026-10-13T00:00:00.000Z');
  const b = blockers.find((x) => x.code === 'not_external');
  assert.match(b.problem, /sourced to your own board pack is not a market figure/);
});

test('an unconfirmed external claim is blocked like any other unconfirmed figure', () => {
  const claim = {
    fact: { source: 'DOCUMENT_EXTRACTED' }, provenance_class: 'EXTERNAL',
    citation: {
      publisher: 'P', title: 'T', published_at: '2026-01-01', locator: 'p.1',
      source_kind: 'NEWS', quote: 'x'.repeat(30), url: 'https://e.org',
      accessed_at: '2026-10-01', claim_class: 'MARKET_SIZE',
    },
  };
  assert.ok(claimBlockers(claim, '2026-10-13T00:00:00.000Z').some((b) => b.code === 'not_confirmed'));
});

// ──────────────────────────────────────────────── image quality ──

test('a logo below the print floor blocks generation', () => {
  const { db, ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  db.insert('brand_asset', {
    org_id: org.id, asset_role: 'LOGO', filename: 'logo.png', mime_type: 'image/png',
    storage_key: 'k', pixel_width: 200, pixel_height: 60, is_vector: 0,
    uploaded_by: 'u-owner', created_at: '2026-01-01',
  });

  const res = api.generate(ctx, org.id, 'ONE_PAGER');
  assert.equal(res.body.blocked, true);
  const blocker = res.body.blockers.find((b) => b.code === 'asset_quality');
  assert.ok(blocker, 'a blurry logo is the first thing a reader sees');
});

test('resolution is judged at placement size, not at upload', () => {
  const asset = { asset_role: 'LOGO', mime_type: 'image/png', pixel_width: 600, pixel_height: 200 };
  // Fine small, unusable large — and only the placement knows which it is.
  assert.deepEqual(placementProblems(asset, { widthMm: 40 }), []);
  assert.ok(placementProblems(asset, { widthMm: 120 }).some((p) => p.code === 'below_minimum_resolution'));

  assert.equal(Math.round(effectiveDpi(600, 50.8)), 300);
  assert.equal(requiredPixels('LOGO', 25.4), MIN_DPI.LOGO);
});

test('a vector asset has no resolution to be wrong', () => {
  const svg = { asset_role: 'LOGO', mime_type: 'image/svg+xml', is_vector: 1 };
  assert.deepEqual(placementProblems(svg, { widthMm: 400 }), []);
});

test('an asset whose dimensions were never recorded is refused, not assumed fine', () => {
  const unknown = { asset_role: 'LOGO', mime_type: 'image/png', filename: 'logo.png' };
  const problems = placementProblems(unknown, { widthMm: 50 });
  assert.equal(problems[0].code, 'unknown_dimensions');
});

test('a stretched placement is reported', () => {
  const asset = { asset_role: 'PRODUCT_SHOT', mime_type: 'image/jpeg', pixel_width: 2000, pixel_height: 1000 };
  const problems = placementProblems(asset, { widthMm: 100, heightMm: 80 });
  assert.ok(problems.some((p) => p.code === 'aspect_mismatch'));
});

// ─────────────────────────────────────────────── charts and numbers ──

test('REGRESSION: an absent cohort cell is blank, not zero', () => {
  // This shipped to a rendered PDF: `Number(null)` is 0, so every
  // not-yet-reached period printed as 0% in a shaded box — a retention cliff
  // that never happened, in the chart built to answer "does revenue stay?".
  const chart = cohortHeatmap({
    cohorts: ['C1'], periods: ['M0', 'M3'], values: [[100, null]], unit: 'percent',
  });
  assert.equal(chart.ok, true);
  const cells = chart.svg.match(/>0%</g) ?? [];
  assert.equal(cells.length, 0, 'an absent cell must never render as 0%');
  assert.match(chart.svg, /100%/);
});

test('toNumber never turns absence into zero', () => {
  for (const absent of [null, undefined, '', 'n/a', NaN]) {
    assert.equal(toNumber(absent), null, `${JSON.stringify(absent)} must not become 0`);
  }
  assert.equal(toNumber(0), 0, 'but a real zero is still a zero');
});

test('a chart with nothing to show refuses to draw an empty frame', () => {
  const empty = barChart({ categories: [], series: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.svg, '');
  assert.match(empty.placeholder, /No data to chart yet/);

  const oneDot = lineChart({ categories: ['Q1'], series: [{ name: 'x', values: [1] }] });
  assert.equal(oneDot.ok, false, 'a trend needs at least two periods');
});

test('one precision per chart, decided from the largest figure', () => {
  // A single waterfall once read "$420k … +$68.0k … $610k": three figures at
  // zero decimals and two at one, in the same row of labels.
  assert.equal(compactDecimalsFor([420_000, 68_000, 610_000]), 0);
  assert.equal(compactDecimalsFor([4_200, 6_800]), 1);

  const w = waterfallChart({
    steps: [
      { label: 'Start', value: 420_000, kind: 'start' },
      { label: 'Up', value: 68_000, kind: 'delta' },
      { label: 'End', value: 0, kind: 'end' },
    ],
    unit: 'USD',
  });
  assert.match(w.svg, /\$420k/);
  assert.match(w.svg, /\+\$68k/);
  assert.doesNotMatch(w.svg, /68\.0k/);
});

test('deltas are signed and totals are not', () => {
  const w = waterfallChart({
    steps: [
      { label: 'Start', value: 400_000, kind: 'start' },
      { label: 'Down', value: -60_000, kind: 'delta' },
      { label: 'End', value: 0, kind: 'end' },
    ],
    unit: 'USD',
  });
  assert.doesNotMatch(w.svg, /\+\$400k/, '"+$400k" on a starting figure reads as an increase');
  assert.match(w.svg, /\(\$60k\)/, 'negatives in brackets, which survives photocopying');
});

test('negatives are bracketed and absence is an em dash', () => {
  assert.equal(formatNumber(-4_000, { unit: 'USD' }), '($4,000)');
  assert.equal(formatNumber(null), '—');
  assert.equal(formatNumber(0, { unit: 'USD' }), '$0', 'a real zero still prints');
});

test('axis ticks land on values a human would have chosen', () => {
  const s = niceScale(0, 3_600_000);
  assert.deepEqual(s.ticks, [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000]);
  // Accumulated by index, not by repeated addition: 0.1+0.1+0.1 is not 0.3, and
  // an axis labelled 0.30000000000000004 makes a reader doubt the rest.
  const fine = niceScale(0, 0.5);
  assert.ok(fine.ticks.every((t) => String(t).length < 8));
});

test('the series palette alternates luminance so it survives a mono printer', () => {
  // Data rooms get printed, and they get printed in black and white more often
  // than anyone designing them expects.
  const greys = SERIES.map((s) => s.grey);
  const adjacent = greys.slice(1).map((g, i) => Math.abs(g - greys[i]));
  assert.ok(Math.min(...adjacent) > 0.15,
    `adjacent series are too close in greyscale: ${adjacent.map((d) => d.toFixed(2)).join(', ')}`);
});

test('label colour is chosen by luminance, not by guesswork', () => {
  assert.equal(contrastOn('#17202A'), '#FFFFFF');
  assert.equal(contrastOn('#D9A441'), '#111111', 'white on this amber is unreadable at 8.5pt');
});

// ───────────────────────────────────────────────────── tables ──

test('a table shows absence as a dash and never as zero', () => {
  const html = dataTable({
    columns: [{ key: 'name', label: 'Item' }, { key: 'value', label: 'Value', unit: 'USD' }],
    rows: [{ name: 'Known', value: 1_000 }, { name: 'Unknown', value: null }],
  });
  assert.match(html, /\$1,000/);
  assert.match(html, /class="absent">—/);
  assert.doesNotMatch(html, /\$0/);
});

test('one precision per column, not per cell', () => {
  // The values have to straddle a scale boundary or the two rules agree and the
  // test proves nothing — mutation testing caught exactly that. Per cell these
  // come out "$420k" and "$68.0k"; per column, both at zero decimals.
  const html = dataTable({
    columns: [{ key: 'v', label: 'Value', unit: 'USD', compact: true }],
    rows: [{ v: 420_000 }, { v: 68_000 }],
  });
  assert.match(html, /\$420k/);
  assert.match(html, /\$68k/);
  assert.doesNotMatch(html, /68\.0k/,
    'a column reading 420k then 68.0k looks like two different measurements');
});

test('a value that cannot be read as a number is shown as-is, never as zero', () => {
  // The early return covers a null cell. This covers the other case: a column
  // declared numeric that contains "n/a", which is what an import produces.
  // Rendering it as 0 would hide a data problem behind a plausible figure.
  const html = dataTable({
    columns: [{ key: 'v', label: 'Value', unit: 'USD' }],
    rows: [{ v: 'n/a' }, { v: 1_000 }],
  });
  assert.match(html, /class="absent">n\/a</);
  assert.doesNotMatch(html, /\$0\b/);
  assert.match(html, /\$1,000/);
});

// ───────────────────────────────────────────────── the catalogue ──

test('the catalogue covers what a raise or sale room is expected to hold', () => {
  assert.ok(ARTIFACTS.length >= 28, `only ${ARTIFACTS.length} artifact kinds declared`);

  const kinds = new Set(ARTIFACTS.map((a) => a.kind));
  for (const expected of [
    'PITCH_DECK', 'INFORMATION_MEMORANDUM', 'TEASER', 'ONE_PAGER', 'FINANCIAL_SUMMARY',
    'NORMALISATION_BRIDGE', 'CAP_TABLE', 'DILUTION_WATERFALL', 'CUSTOMER_CONCENTRATION',
    'COHORT_ANALYSIS', 'UNIT_ECONOMICS', 'ORG_CHART', 'CONTRACT_REGISTER', 'DATA_ROOM_INDEX',
    'DILIGENCE_TRACKER', 'QA_LOG', 'READINESS_REPORT', 'GAP_PLAN', 'USE_OF_FUNDS',
    'MARKET_SECTION', 'PROVENANCE_APPENDIX',
  ]) {
    assert.ok(kinds.has(expected), `the catalogue is missing ${expected}`);
  }
});

test('every block a catalogue entry references actually exists', () => {
  // The failure this prevents is a catalogue entry naming a chart nobody built,
  // which would render as a note saying so in a document sent to an investor.
  for (const spec of ARTIFACTS) {
    for (const descriptor of spec.blocks) {
      const block = parseBlock(descriptor);
      if (block.type === 'CHART') {
        assert.ok(AVAILABLE_CHARTS.includes(block.chart),
          `${spec.kind} references chart "${block.chart}", which does not exist`);
      }
      if (block.type === 'TABLE') {
        assert.ok(AVAILABLE_TABLES.includes(block.table),
          `${spec.kind} references table "${block.table}", which does not exist`);
      }
    }
  }
});

test('coverage reports what a document would be missing before it is asked for', () => {
  const { ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  const listed = api.listArtifacts(ctx, org.id).body;
  const summary = listed.artifacts.find((a) => a.kind === 'FINANCIAL_SUMMARY');
  assert.equal(summary.coverage.required_present, 1);
  assert.ok(summary.coverage.missing_optional.includes('financials.reported_profit'));
});

test('a sale document is flagged on a raise path, but not blocked', () => {
  const spec = artifactSpec('INFORMATION_MEMORANDUM');
  const { blockers, warnings } = generationBlockers(spec, { facts: [{ fact_key: 'company.name' }], path: 'RAISE' });
  assert.equal(blockers.length, 0, 'a company that has not decided should still be able to produce either');
  assert.equal(warnings[0].code, 'path_mismatch');
});

// ─────────────────────────────────────────────────── determinism ──

test('the same facts produce byte-identical output', () => {
  // An artifact that differs between runs cannot be diffed, cached, or trusted
  // to be a rendering of its inputs.
  const build = () => {
    const { ctx, org, storage } = world();
    withFinancials(ctx, org, storage);
    return api.generate(ctx, org.id, 'FINANCIAL_SUMMARY').body.html;
  };
  assert.equal(build(), build());
});

test('generation is audited with what it rested on', () => {
  const { db, ctx, org, storage } = world();
  withFinancials(ctx, org, storage);
  api.generate(ctx, org.id, 'FINANCIAL_SUMMARY');

  const entry = db.find('audit_log', { org_id: org.id }).find((a) => a.action === 'artifact.generated');
  assert.ok(entry);
  assert.ok(JSON.parse(entry.metadata).facts >= 2);
});

// ──────────────────────────────────────────────────── access ──

test('a viewer cannot generate, and another organisation gets 404', () => {
  const { db, ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: '2026-01-01',
  });
  expectRefusal(() => api.generate(ctxFor(db, 'u-viewer'), org.id, 'FINANCIAL_SUMMARY'), 'forbidden', 403);
  expectRefusal(() => api.listArtifacts(ctxFor(db, 'u-stranger'), org.id), 'not_found', 404);
});

test('an unknown artifact kind is a 404', () => {
  const { ctx, org } = world();
  expectRefusal(() => api.generate(ctx, org.id, 'NOT_A_THING'), 'unknown_artifact', 404);
});

test('the readiness report renders from a completed assessment', () => {
  const { ctx, org } = world();
  const a = assessments.createAssessment(ctx, org.id, {}).body.assessment;
  assessments.scoreAssessment(ctx, org.id, a.id, Object.fromEntries(ALL_REFS.map((r) => [r, 3])));
  assessments.completeAssessment(ctx, org.id, a.id);

  const res = api.generate(ctx, org.id, 'READINESS_REPORT');
  assert.equal(res.status, 201);
  assert.match(res.body.html, /Score by domain/);
  assert.match(res.body.html, /radar chart|Readiness by domain/);
});


// ──────────────────────────────────────────────── number formatting in tables ──

test('REGRESSION: a table column cannot print a raw, unformatted number', () => {
  // This shipped. The financial summary of the investor deck — the first table
  // an investor reads — printed "3600000" and "71" because its value column
  // declared no unit. Every structural check passed: the figure was correct,
  // present, and traced to its source. It was just written the way a database
  // writes it.
  assert.throws(
    () => dataTable({
      columns: [{ key: 'metric', label: 'Figure' }, { key: 'value', label: 'Value' }],
      rows: [{ metric: 'Revenue', value: 3_600_000 }],
    }),
    (err) => err.code === 'unformatted_number' && /declares no unit/.test(err.message),
  );
});

test('a column that declares its formatting is unaffected', () => {
  const html = dataTable({
    columns: [{ key: 'metric', label: 'Figure' }, { key: 'value', label: 'Value', unit: 'USD' }],
    rows: [{ metric: 'Revenue', value: 3_600_000 }],
  });
  assert.ok(html.includes('$3,600,000'));
});

test('a preformatted column keeps tabular numerals', () => {
  // Mixed columns — currency beside a percentage — are formatted by the caller,
  // but must not lose the tabular figures that keep a financial column aligned.
  const html = dataTable({
    columns: [{ key: 'value', label: 'Value', align: 'right', preformatted: true }],
    rows: [{ value: '$3,600,000' }, { value: '71%' }],
  });
  assert.ok(html.includes('class="tnum"'), 'a preformatted figure lost its tabular numerals');
  assert.ok(html.includes('$3,600,000') && html.includes('71%'));
});

test('the financial summary writes currency and percentages each in their own unit', () => {
  // The column is genuinely mixed, which is why it was left unformatted in the
  // first place: no single unit fits both rows.
  const { ctx, org, storage } = world();
  withFinancials(ctx, org, storage);

  const table = financialTable(api.generate(ctx, org.id, 'FINANCIAL_SUMMARY').body.html);
  assert.ok(table.includes('$3,600,000'), 'revenue printed without currency formatting');
  // 63.9 keeps its decimal. A tenth of a point of gross margin is a number
  // people argue about, and rounding it to "64%" in an investor deck is a
  // different figure, not a formatting preference.
  assert.ok(table.includes('63.9%'), 'a percentage lost its decimal place');
  assert.ok(!table.includes('>64%<'), 'the margin was rounded to a whole number');
  assert.ok(!/>\s*3600000\s*</.test(table), 'a raw figure reached the page');
});


// ────────────────────────────────────────────────────── one axis, one precision ──

test('REGRESSION: an axis does not mix precisions', () => {
  // This reached a rendered deck: a percentage axis labelled
  // "100% / 75% / 50% / 25% / 0.0%", because the percent rule gives values under
  // ten an extra decimal place and zero is under ten. Four whole numbers and one
  // with a decimal, for no reason a reader could work out.
  const chart = barChart({
    categories: ['Top customer', 'Top 3', 'Top 5'],
    series: [{ name: 'Share of revenue', values: [44.3, 72.4, 84.9] }],
    unit: 'percent',
  });
  assert.ok(chart.ok);
  assert.ok(!chart.svg.includes('0.0%'), 'the zero tick carried a decimal the other ticks did not');
  assert.ok(chart.svg.includes('>0%<'), 'the zero tick is missing entirely');
});

test('an axis that genuinely needs decimals keeps them on every tick', () => {
  // The fix is one precision, not no precision: an axis stepping in halves must
  // not lose the halves to its whole-numbered neighbours.
  assert.equal(axisDecimals([0, 0.5, 1, 1.5, 2], 'percent'), 1);
  assert.equal(axisDecimals([0, 25, 50, 75, 100], 'percent'), 0);
  assert.equal(axisDecimals([], 'percent'), undefined);
});

test('a currency axis takes one precision from its largest tick', () => {
  const chart = lineChart({
    categories: ['FY2022', 'FY2023', 'FY2024'],
    series: [{ name: 'Revenue', values: [1_850_000, 2_410_000, 3_600_000] }],
    unit: 'USD',
  });
  assert.ok(chart.ok);
  // Every compact tick on the axis is written to the same number of places.
  const ticks = [...chart.svg.matchAll(/>\$([0-9.]+)m</g)].map((m) => m[1]);
  assert.ok(ticks.length >= 3, 'no compact currency ticks were drawn');
  const places = new Set(ticks.map((t) => (t.split('.')[1] ?? '').length));
  assert.equal(places.size, 1, `axis ticks mix precisions: ${ticks.join(', ')}`);
});


// ─────────────────────────────────────── percentages, to one decimal or none ──

test('a fractional percentage keeps its decimal place', () => {
  // 63.9% gross margin printed as "64%". A tenth of a point of margin is a
  // number people argue about; rounding it away is a different figure, not a
  // formatting preference.
  assert.equal(formatNumber(63.9, { unit: 'percent' }), '63.9%');
  assert.equal(formatNumber(44.3, { unit: 'percent' }), '44.3%');
});

test('a whole percentage does not gain a decimal place it does not need', () => {
  assert.equal(formatNumber(71, { unit: 'percent' }), '71%');
  assert.equal(formatNumber(0, { unit: 'percent' }), '0%');
  assert.equal(formatNumber(100, { unit: 'percent' }), '100%');
});

test('precision is decided across the set, not per value', () => {
  // The old rule's real failure was not its threshold but that it chose per
  // figure, which is how an axis came out "100% / 75% / 50% / 25% / 0.0%".
  assert.equal(percentDecimals([0, 25, 50, 75, 100]), 0);
  assert.equal(percentDecimals([44.3, 72, 84.9]), 1);
  assert.equal(percentDecimals([71]), 0);
  assert.equal(percentDecimals([]), 0);
  // Values that print identically must not disagree about needing a decimal.
  assert.equal(percentDecimals([63.94]), 1);
  assert.equal(percentDecimals([63.04]), 0);
});

test('one fractional member gives the whole set its decimal', () => {
  const chart = barChart({
    categories: ['A', 'B', 'C'],
    series: [{ name: 'Share', values: [44.3, 72, 85] }],
    unit: 'percent',
  });
  assert.ok(chart.ok);
  assert.ok(chart.svg.includes('44.3%'));
  assert.ok(chart.svg.includes('72.0%'), 'a whole value did not match its set');
  assert.ok(!/>72%</.test(chart.svg), 'the set mixed precisions');
});

test('a cohort heatmap no longer rounds retention to whole points', () => {
  // It hardcoded zero decimals — in the chart whose entire purpose is showing
  // small movements between cohorts.
  const chart = cohortHeatmap({
    cohorts: ['2025-01', '2025-02'],
    periods: ['M0', 'M1', 'M2'],
    values: [[100, 91.2, 87.5], [100, 89.4, 84.1]],
  });
  assert.ok(chart.ok);
  assert.ok(chart.svg.includes('87.5%'), 'retention was rounded away');
});

test('setDecimals picks the rule from the unit, and one precision regardless', () => {
  assert.equal(setDecimals([44.3, 72], 'percent'), 1);
  assert.equal(setDecimals([25, 50], 'percent'), 0);
  assert.equal(setDecimals([1_850_000, 3_600_000], 'USD'), 1);
  assert.equal(setDecimals([], 'percent'), undefined);
});


// ───────────────────────────────────── compact precision, per scale bucket ──

test('REGRESSION: a zero-based currency axis does not write $0.0', () => {
  // A set-wide precision rule, applied to an axis that crosses three scales,
  // produced "$0.0 / $500.0k / $1.0m". Within a scale, mixed precision is the
  // defect; ACROSS scales it is how a person writes an axis.
  const chart = barChart({
    categories: ['A', 'B', 'C'],
    series: [{ name: 'Revenue', values: [500_000, 1_200_000, 2_000_000] }],
    unit: 'USD',
  });
  assert.ok(chart.ok);
  assert.ok(chart.svg.includes('>$0<'), 'the zero tick carried a decimal');
  assert.ok(chart.svg.includes('$500k'), 'a thousands tick took the millions precision');
  assert.ok(chart.svg.includes('$1.0m'));
  assert.ok(!chart.svg.includes('$0.0'));
  assert.ok(!chart.svg.includes('$500.0k'));
});

test('within one scale, the largest figure still decides for all of them', () => {
  // The Phase 5 rule, unchanged: "$420k … $68.0k" in one row is two figures at
  // the same magnitude written two ways.
  assert.equal(compactDecimalsFor([420_000, 68_000, 610_000]), 0);
  assert.equal(compactDecimalsFor([4_200, 6_800]), 1);
  assert.equal(decimalsForScale(1e3, [420_000, 68_000, 610_000]), 0);
});

test('each scale decides for itself', () => {
  const values = [0, 500_000, 1_200_000];
  assert.equal(compactDecimalsAt(0, values), 0);
  assert.equal(compactDecimalsAt(500_000, values), 0);
  assert.equal(compactDecimalsAt(1_200_000, values), 1);
  assert.equal(scaleOf(0), 1);
  assert.equal(scaleOf(500_000), 1e3);
  assert.equal(scaleOf(2_000_000_000), 1e9);
});

test('a small figure keeps its decimal when a much larger one shares the chart', () => {
  // The case that distinguishes "within a scale" from "across all values":
  // $5k needs its decimal to say it is five thousand and not five hundred, and
  // deciding from the $2m alongside it would take that away.
  const values = [5_000, 2_000_000];
  assert.equal(compactDecimalsAt(5_000, values), 1, '$5k lost its decimal to the millions');
  assert.equal(compactDecimalsAt(2_000_000, values), 1);
  assert.equal(decimalsForScale(1e3, values), 1);

  // Asserted on the helper rather than on a rendered chart: a $5k bar beside a
  // $2m one is a few pixels tall, so the chart correctly suppresses its label
  // for want of room, and the rendered SVG cannot show this either way.
  assert.equal(formatNumber(5_000, { unit: 'USD', compact: true, decimals: compactDecimalsAt(5_000, values) }),
    '$5.0k');
});

test('a percent column in a table shares one precision', () => {
  const html = dataTable({
    columns: [{ key: 'name', label: 'Customer' }, { key: 'share', label: 'Share', unit: 'percent' }],
    rows: [{ name: 'A', share: 44.3 }, { name: 'B', share: 72 }, { name: 'C', share: 85 }],
  });
  assert.ok(html.includes('44.3%'));
  assert.ok(html.includes('72.0%'), 'a whole value did not match its column');
  assert.ok(!/>72%</.test(html), 'the column mixed precisions');
});

test('a percent column of whole numbers gains no decimals', () => {
  const html = dataTable({
    columns: [{ key: 'share', label: 'Share', unit: 'percent' }],
    rows: [{ share: 25 }, { share: 50 }, { share: 25 }],
  });
  assert.ok(html.includes('25%'));
  assert.ok(!html.includes('25.0%'));
});

test('the financial summary shares one precision across its percentages', () => {
  // The column is mixed-unit, so the column-level rule does not reach it and the
  // builder decides across the percentages itself. Two of them are needed to
  // show it: one fractional, one whole, which per-value formatting would write
  // as "63.9%" and "40%" in the same column.
  const { ctx, org, storage } = world();
  const doc = docFor(ctx, org, storage, 'accounts.pdf');
  confirmFact(ctx, org.id, doc, 'financials.revenue.ttm', 'Revenue', 3_600_000);
  confirmFact(ctx, org.id, doc, 'financials.gross_margin', 'Gross margin', 63.9, { unit: 'percent' });
  // Cost of sales recorded as a share of revenue, which is an ordinary way to
  // keep it.
  confirmFact(ctx, org.id, doc, 'financials.cogs.ttm', 'Cost of sales', 40, { unit: 'percent' });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });

  const table = financialTable(api.generate(ctx, org.id, 'FINANCIAL_SUMMARY').body.html);
  assert.ok(table.includes('63.9%'));
  assert.ok(table.includes('40.0%'), 'a whole percentage did not match its column');
  assert.ok(!/>40%</.test(table), 'the column mixed precisions');
  assert.ok(table.includes('$3,600,000'), 'currency lost its formatting');
});


test('REGRESSION: a chart heading cannot be separated from its chart by a page break', () => {
  // A chart's heading is the argument and the chart is the support. Split across
  // a page break, the reader gets an assertion with nothing under it — which is
  // what the valuation pack did on its first render.
  const { ctx, org, storage } = world();
  withFinancials(ctx, org, storage);
  const html = api.generate(ctx, org.id, 'PITCH_DECK').body.html;

  assert.ok(html.includes('class="chart-group"'), 'charts are no longer grouped with their headings');
  // The heading must sit INSIDE the group, not before it.
  assert.ok(!/<h3 class="chart-heading">[^<]*<\/h3>\s*<div class="chart-group">/.test(html));
  assert.match(html, /\.chart-group\{[^}]*break-inside:avoid/);
});
