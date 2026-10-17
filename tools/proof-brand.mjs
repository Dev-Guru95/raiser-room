/**
 * Visual proof for Phase 9 — the brand, on paper.
 *
 *   node tools/proof-brand.mjs
 *
 * Generates one deck three times — the standard, a corporate blue, and the pale
 * mint that broke the first derivation — and renders each to PDF.
 *
 * WHY THIS EXISTS RATHER THAN JUST THE TEST SUITE
 *
 * The tests assert that the right hex strings reach the HTML. They cannot see
 * whether the page is legible, and a palette can satisfy every numeric floor and
 * still look wrong. The one failure this is really for is the mint: it passed
 * every structural check under the first implementation and printed as four
 * indistinguishable greys. Nothing short of looking would have caught it.
 *
 * It also writes a greyscale copy of each, because black and white is how data
 * rooms actually get printed and it is the harder test of the two.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { freshDb, ctxFor, fakeStorage } from '../test/helpers.js';
import * as svc from '../src/api/service.js';
import * as artifacts from '../src/api/artifacts.js';
import * as brand from '../src/api/brand.js';
import { greyscaleSeparation, contrastRatio, CONTRAST_FLOOR } from '../src/domain/brand.js';
import { renderPdf } from './render.mjs';

const KIND = 'PITCH_DECK';

const BRANDS = [
  { label: 'standard', accent: null, note: 'the RaiseRoom standard, unbranded' },
  { label: 'blue', accent: '#0B5FA5', note: 'a corporate blue — needs no adjustment' },
  { label: 'mint', accent: '#A8E6CF', note: 'the pale mint that broke the first derivation' },
  { label: 'yellow', accent: '#F2C94C', note: 'a yellow, where lightness and luminance diverge most' },
];

/**
 * A company with enough confirmed facts that the deck has charts in it.
 *
 * ILLUSTRATIVE ONLY. Not a real company, client, engagement, or performance
 * result. All names, figures, workflows, and outcomes are invented for teaching
 * purposes.
 */
function company() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-founder', 'founder@example.com');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, {
    name: 'Northwind Systems', path: 'RAISE', currency: 'USD', target_amount: 6_000_000,
  }).body.organisation;

  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 400_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);

  const confirmed = (fact_key, label, value_numeric, opts = {}) =>
    svc.createFact(ctx, org.id, {
      // `'unit' in opts`, not `??`: an explicit null means NO unit, and `??`
      // only falls through on null — which is how headcount came out as "$34".
      fact_key, label, value_numeric, unit: 'unit' in opts ? opts.unit : 'USD',
      period_start: opts.start ?? null, period_end: opts.end ?? null,
      source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: opts.page ?? 4,
    });

  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });

  // A series is the SAME key across periods — which is what makes the trend
  // chart draw. The first version of this file invented a key per month, so the
  // deck came out with no charts in it at all and the palette, the one thing
  // this tool exists to look at, was never rendered.
  for (const [start, end, value] of [
    ['2022-01-01', '2022-12-31', 1_850_000],
    ['2023-01-01', '2023-12-31', 2_410_000],
    ['2024-01-01', '2024-12-31', 3_120_000],
    ['2025-01-01', '2025-12-31', 3_600_000],
  ]) confirmed('financials.revenue.ttm', 'Revenue', value, { start, end });

  confirmed('financials.arr', 'Annual recurring revenue', 4_100_000, { end: '2026-06-30', page: 6 });
  confirmed('financials.gross_margin', 'Gross margin', 63.9,
    { unit: 'percent', start: '2025-01-01', end: '2025-12-31' });
  confirmed('people.headcount', 'Headcount', 34, { unit: null, page: 9 });

  confirmed('commercial.concentration.top1', 'Top customer share of revenue', 44.3,
    { unit: 'percent', page: 14 });
  confirmed('commercial.concentration.top3', 'Top 3 customers share of revenue', 72.4,
    { unit: 'percent', page: 14 });
  confirmed('commercial.concentration.top5', 'Top 5 customers share of revenue', 84.9,
    { unit: 'percent', page: 14 });

  return { ctx, org };
}

mkdirSync('out/brand', { recursive: true });

const summary = [];

for (const spec of BRANDS) {
  const { ctx, org } = company();
  if (spec.accent) brand.setBrand(ctx, org.id, { accent: spec.accent });

  const res = artifacts.generate(ctx, org.id, KIND);
  if (res.body.blocked) {
    summary.push({ ...spec, blocked: res.body.blockers.map((b) => b.code).join(', ') });
    continue;
  }

  const html = `out/brand/${spec.label}.html`;
  writeFileSync(html, res.body.html);
  await renderPdf(html, `out/brand/${spec.label}.pdf`, { size: 'slide' });

  const tokens = brand.brandTokens(ctx, org.id) ?? brand.getBrand(ctx, org.id).body.tokens;
  const palette = tokens.palette.map((hex) => ({ hex }));

  summary.push({
    ...spec,
    accent_used: tokens.accent,
    accent_text: tokens.accent_text,
    text_contrast: contrastRatio(tokens.accent_text, tokens.page ?? '#FFFFFF'),
    separation: greyscaleSeparation(palette),
    adjustments: brand.getBrand(ctx, org.id).body.adjustments?.length ?? 0,
  });
}

// ── the palette itself, eight series at once ────────────────────────────────
//
// The deck has no multi-series chart in it, so nothing above actually LOOKS at
// the thing the luminance ladder exists for. This page draws all eight series
// together, which is the only way to see whether they can be told apart — and,
// converted to greyscale, whether they survive the printer.
{
  const { withPalette } = await import('../src/render/theme.js');
  const { barChart } = await import('../src/render/charts.js');
  const { htmlDocument } = await import('../src/render/document.js');
  const { deriveBrand, standardBrand } = await import('../src/domain/brand.js');

  const sections = [];
  for (const spec of BRANDS) {
    const brand = spec.accent ? deriveBrand({ accent: spec.accent }).tokens : standardBrand().tokens;
    const chart = withPalette(brand, () => barChart({
      categories: ['FY2022', 'FY2023', 'FY2024', 'FY2025'],
      series: Array.from({ length: 8 }, (_, i) => ({
        name: `Series ${i + 1}`,
        values: [40 + i * 3, 52 + i * 2, 61 + i, 70 - i],
      })),
      unit: 'percent', width: 900, height: 300, widthMm: 250,
    }));
    sections.push(`<section class="page page-flow"><h3 class="chart-heading">${spec.label} — `
      + `${spec.note}</h3>${chart.ok ? chart.svg : chart.placeholder}</section>`);
  }

  const file = 'out/brand/palettes.html';
  writeFileSync(file, htmlDocument({
    title: 'Palette proof', size: 'a4landscape',
    extraCss: '.chart-heading{font-family:var(--sans);font-size:13pt;margin:0 0 4mm;}',
    body: sections.join(''),
  }));
  await renderPdf(file, 'out/brand/palettes.pdf', { size: 'a4landscape' });
}

// ── greyscale copies, because that is how these get printed ─────────────────
//
// Converted with Ghostscript rather than by desaturating the palette in code:
// the question is what a printer does to the finished PDF, and answering it
// with our own colour maths would be marking our own homework.
let greyscaleOk = true;
for (const s of summary.filter((x) => !x.blocked)) {
  try {
    execSync(
      'gs -sDEVICE=pdfwrite -sColorConversionStrategy=Gray -dProcessColorModel=/DeviceGray '
      + `-dNOPAUSE -dBATCH -dQUIET -sOutputFile=out/brand/${s.label}-grey.pdf `
      + `out/brand/${s.label}.pdf`,
      { stdio: 'pipe' },
    );
  } catch {
    greyscaleOk = false;
  }
}

const pad = Math.max(...summary.map((s) => s.label.length));
console.log('\nBrand proof — one deck, four brands\n');
for (const s of summary) {
  if (s.blocked) {
    console.log(`  ✗ ${s.label.padEnd(pad)}  blocked: ${s.blocked}`);
    continue;
  }
  const floor = s.text_contrast >= CONTRAST_FLOOR.bodyText ? '✓' : '✗';
  console.log(
    `  ${floor} ${s.label.padEnd(pad)}  accent ${s.accent_used}  text ${s.accent_text} `
    + `at ${String(s.text_contrast).padStart(5)}:1  greyscale gap ${s.separation}  `
    + `${s.adjustments} adjustment(s)`,
  );
  console.log(`    ${' '.repeat(pad)}  ${s.note}`);
}

console.log(`\nPDFs in out/brand/${greyscaleOk ? ' (with -grey.pdf greyscale copies)' : ''}`);
if (!greyscaleOk) {
  console.log('Greyscale copies were skipped — Ghostscript is not available here.');
}
console.log('\nNow LOOK at them. Every number above can be right while the page is still wrong;\n'
  + 'that is how the first version of the palette shipped four identical greys.\n');
