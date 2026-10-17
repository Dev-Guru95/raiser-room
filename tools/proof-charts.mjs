/**
 * Render every chart type onto one sheet, so they can be looked at.
 *
 *   node tools/proof-charts.mjs && node tools/render.mjs out/proof.html out/proof.pdf --size=a4
 *
 * This exists because charts cannot be reviewed by reading the code that
 * produces them. Every change to `src/render/charts.js` gets looked at here
 * before it is believed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import {
  barChart, lineChart, waterfallChart, donutChart, cohortHeatmap,
  radarChart, ganttChart, scatterChart, orgChart, sparkline, insufficientData,
} from '../src/render/charts.js';
import { documentHead } from '../src/render/document.js';

const panels = [];
const panel = (title, note, result) => {
  panels.push(`<section class="panel">
    <h2>${title}</h2>
    ${note ? `<p class="note">${note}</p>` : ''}
    <div class="chart">${result.ok ? result.svg : result.placeholder}</div>
  </section>`);
};

panel('Revenue by year', 'Single series, value labels, compact axis.', barChart({
  categories: ['FY2022', 'FY2023', 'FY2024', 'FY2025'],
  series: [{ name: 'Revenue', values: [1_850_000, 2_410_000, 3_120_000, 3_600_000] }],
  unit: 'USD', title: 'Revenue by year',
}));

panel('Revenue and gross profit', 'Two series, grouped, with a legend.', barChart({
  categories: ['FY2023', 'FY2024', 'FY2025'],
  series: [
    { name: 'Revenue', values: [2_410_000, 3_120_000, 3_600_000] },
    { name: 'Gross profit', values: [1_490_000, 2_000_000, 2_300_000] },
  ],
  unit: 'USD',
}));

panel('Revenue by segment', 'Stacked, labels inside the segments.', barChart({
  categories: ['FY2023', 'FY2024', 'FY2025'],
  series: [
    { name: 'Subscription', values: [1_700_000, 2_300_000, 2_800_000] },
    { name: 'Services', values: [500_000, 600_000, 620_000] },
    { name: 'Other', values: [210_000, 220_000, 180_000] },
  ],
  unit: 'USD', stacked: true,
}));

panel('ARR and headcount', 'Two lines, markers, independent of zero.', lineChart({
  categories: ['Q1 24', 'Q2 24', 'Q3 24', 'Q4 24', 'Q1 25', 'Q2 25'],
  series: [
    { name: 'ARR (USD)', values: [2_400_000, 2_700_000, 3_000_000, 3_300_000, 3_550_000, 3_800_000] },
  ],
  unit: 'USD', area: true,
}));

panel('Normalisation bridge', 'Reported profit to underlying earnings. Signed labels, connectors.',
  waterfallChart({
    steps: [
      { label: 'Reported profit', value: 420_000, kind: 'start' },
      { label: 'Owner remuneration above market', value: 145_000, kind: 'delta' },
      { label: 'One-off legal costs', value: 68_000, kind: 'delta' },
      { label: 'Discontinued product line', value: -42_000, kind: 'delta' },
      { label: 'Lease normalisation', value: 19_000, kind: 'delta' },
      { label: 'Underlying earnings', value: 0, kind: 'end' },
    ],
    unit: 'USD', width: 660,
  }));

panel('Customer concentration', 'Composition, with the headline in the hole.', donutChart({
  slices: [
    { name: 'Northwind Logistics', value: 44.3 },
    { name: 'Harbour Freight Co', value: 16.9 },
    { name: 'Meridian Group', value: 11.2 },
    { name: 'Calder Industrial', value: 7.4 },
    { name: 'Ashgrove Partners', value: 5.1 },
    { name: 'Tenby Systems', value: 3.8 },
    { name: 'Lowther Ltd', value: 2.9 },
    { name: 'Brayton & Co', value: 2.1 },
  ],
  unit: 'percent', centreValue: 44.3, centreLabel: 'top customer',
}));

panel('Net revenue retention by cohort', 'Values printed as well as shaded, so it prints.',
  cohortHeatmap({
    cohorts: ['2024 Q1', '2024 Q2', '2024 Q3', '2024 Q4', '2025 Q1'],
    periods: ['M0', 'M3', 'M6', 'M9', 'M12'],
    values: [
      [100, 104, 111, 118, 124],
      [100, 101, 106, 112, null],
      [100, 98, 103, null, null],
      [100, 105, null, null, null],
      [100, null, null, null, null],
    ],
    unit: 'percent', width: 520,
  }));

panel('Readiness by domain', 'Eight axes, scored out of twenty.', radarChart({
  axes: ['Corporate', 'Financial', 'Commercial', 'Legal', 'IP & tech', 'People', 'Story', 'The room'],
  values: [12, 9, 15, 11, 7, 13, 16, 18],
  max: 20,
}));

panel('Gap plan', 'Coloured by category — blockers and long-lead items first.', ganttChart({
  tasks: [
    { label: 'Reconcile cap table to register', start: '2026-10-01', end: '2026-11-15', category: 'BLOCKER' },
    { label: 'Chase IP assignments (3 leavers)', start: '2026-10-01', end: '2027-02-28', category: 'LONG_LEAD' },
    { label: 'Landlord consent to assign', start: '2026-11-01', end: '2027-01-31', category: 'THIRD_PARTY' },
    { label: 'Write revenue recognition policy', start: '2026-10-15', end: '2026-11-30', category: 'CHEAP' },
    { label: 'Rename and refile room documents', start: '2026-12-01', end: '2026-12-20', category: 'ROOM' },
  ],
  today: '2026-10-13', width: 640,
  categoryColours: {
    BLOCKER: '#A3243B', LONG_LEAD: '#8A6A00', THIRD_PARTY: '#3B1E8F',
    CHEAP: '#7E3FF2', ROOM: '#B0B0B0',
  },
}));

panel('Unit economics by segment', 'Scatter, with direct labels.', scatterChart({
  points: [
    { x: 1_200, y: 14_800, label: 'Enterprise' },
    { x: 640, y: 5_900, label: 'Mid-market' },
    { x: 180, y: 1_250, label: 'SMB' },
    { x: 420, y: 3_100, label: 'Public sector' },
  ],
  xLabel: 'Cost to acquire (USD)', yLabel: 'Lifetime value', xUnit: 'USD', yUnit: 'USD',
}));

panel('Organisation', 'Tidy-tree layout; key-person dependencies flagged in words.', orgChart({
  root: {
    name: 'A. Founder', role: 'Chief Executive', key_person: true,
    children: [
      { name: 'B. Shaw', role: 'Engineering', key_person: true, children: [
        { name: 'C. Patel', role: 'Platform' },
        { name: 'D. Okafor', role: 'Applications' },
      ] },
      { name: 'E. Lindqvist', role: 'Commercial', children: [
        { name: 'F. Moreau', role: 'Sales' },
      ] },
      { name: 'G. Rahman', role: 'Finance' },
    ],
  },
  width: 620,
}));

panel('A chart with nothing to show', 'Refuses to draw an empty frame, and says why.',
  insufficientData('No customer revenue has been confirmed yet, so concentration cannot be charted.'));

const sparklineRow = `<table class="mini"><tr><th>Metric</th><th>Trend</th><th class="num">Latest</th></tr>
<tr><td>ARR</td><td>${sparkline([2.4, 2.7, 3.0, 3.3, 3.55, 3.8])}</td><td class="num">$3.8m</td></tr>
<tr><td>Gross margin</td><td>${sparkline([61, 62, 64, 63, 66, 68])}</td><td class="num">68%</td></tr>
<tr><td>Headcount</td><td>${sparkline([22, 26, 29, 33, 36, 38])}</td><td class="num">38</td></tr></table>`;

panels.push(`<section class="panel"><h2>Sparklines in a table</h2>
  <p class="note">Inline trends, sized for a table cell.</p>${sparklineRow}</section>`);

const html = `<!doctype html><html lang="en"><head>
${documentHead({ title: 'RaiseRoom chart proof sheet', size: 'a4' })}
<style>
  body { padding: 14mm; }
  h1 { font-family: var(--display); font-size: 22pt; margin: 0 0 2mm; }
  .lede { font-family: var(--serif); color: var(--muted); font-size: 9.5pt; margin: 0 0 8mm; }
  .panel { break-inside: avoid; margin-bottom: 9mm; padding-bottom: 6mm; border-bottom: .4pt solid var(--rule); }
  .panel h2 { font-family: var(--sans); font-size: 11pt; margin: 0 0 1mm; }
  .note { font-family: var(--serif); font-size: 8.5pt; color: var(--muted); margin: 0 0 3mm; }
  .chart svg { max-width: 100%; height: auto; }
  table.mini { border-collapse: collapse; width: 70%; font-size: 9pt; font-variant-numeric: tabular-nums; }
  table.mini th, table.mini td { padding: 1.5mm 3mm; border-bottom: .3pt solid var(--rule); text-align: left; }
  table.mini .num { text-align: right; font-weight: 600; }
</style></head><body>
<h1>Chart proof sheet</h1>
<p class="lede">Every chart type, rendered through the real pipeline. Looked at before it is believed.</p>
${panels.join('\n')}
</body></html>`;

mkdirSync('out', { recursive: true });
writeFileSync('out/proof.html', html);
console.log('wrote out/proof.html');
