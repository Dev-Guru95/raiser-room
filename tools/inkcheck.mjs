/**
 * Render a chart and check that ink actually landed on the page.
 *
 *   node tools/inkcheck.mjs
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Before any of the chart library was written, the two candidate PDF renderers
 * were given the same SVG. One of them produced a clean PDF, no error, exit
 * zero — with two of the three bars missing. It silently dropped every
 * gradient-filled shape.
 *
 * A unit test on the SVG string would have passed. The SVG was correct. The
 * failure was downstream of everything a normal test can see, and the only way
 * to catch it is to rasterise the output and look at the pixels.
 *
 * So this samples known regions of a rendered chart and asserts that the
 * expected colour is present. It is slow and it needs a browser, which is why
 * it is a tool rather than part of `npm test` — but it is the only check that
 * would have caught the bug that chose the renderer.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { barChart, waterfallChart, cohortHeatmap, donutChart } from '../src/render/charts.js';
import { htmlDocument } from '../src/render/document.js';
import { renderPdf } from './render.mjs';

const WORK = 'out/inkcheck';

/** Decode a PPM (what pdftoppm emits with -ppm) without an image library. */
function readPpm(path) {
  const buf = readFileSync(path);
  // P6\n<width> <height>\n<maxval>\n<binary>
  let pos = 0;
  const token = () => {
    while (buf[pos] === 0x20 || buf[pos] === 0x0a || buf[pos] === 0x0d || buf[pos] === 0x09) pos++;
    if (buf[pos] === 0x23) { while (buf[pos] !== 0x0a) pos++; return token(); }
    let out = '';
    while (pos < buf.length && buf[pos] > 0x20) out += String.fromCharCode(buf[pos++]);
    return out;
  };
  const magic = token();
  if (magic !== 'P6') throw new Error(`expected a P6 PPM, got ${magic}`);
  const width = Number(token());
  const height = Number(token());
  token();                       // maxval
  pos++;                         // single whitespace before the pixel data
  return { width, height, data: buf.subarray(pos) };
}

const pixel = (img, x, y) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** Share of pixels in a region that are not white. */
function inkDensity(img, { x0, y0, x1, y1 }) {
  let ink = 0;
  let total = 0;
  for (let y = Math.round(y0); y < Math.round(y1); y += 2) {
    for (let x = Math.round(x0); x < Math.round(x1); x += 2) {
      const [r, g, b] = pixel(img, x, y);
      total++;
      if (r < 245 || g < 245 || b < 245) ink++;
    }
  }
  return total ? ink / total : 0;
}

/** Does a region contain a pixel close to this colour? */
function hasColour(img, region, [tr, tg, tb], tolerance = 40) {
  for (let y = Math.round(region.y0); y < Math.round(region.y1); y += 2) {
    for (let x = Math.round(region.x0); x < Math.round(region.x1); x += 2) {
      const [r, g, b] = pixel(img, x, y);
      if (Math.abs(r - tr) < tolerance && Math.abs(g - tg) < tolerance && Math.abs(b - tb) < tolerance) {
        return true;
      }
    }
  }
  return false;
}

const CASES = [
  {
    name: 'every bar in a bar chart is actually drawn',
    // The exact failure that disqualified the other renderer.
    chart: () => barChart({
      categories: ['A', 'B', 'C'],
      series: [{ name: 'Revenue', values: [1_000_000, 2_000_000, 3_000_000] }],
      unit: 'USD', width: 600, height: 300, valueLabels: false,
    }),
    check(img) {
      // Three bands across the plot; each must carry blade purple.
      const problems = [];
      const plotTop = img.height * 0.12;
      const plotBottom = img.height * 0.82;
      for (const [i, label] of ['A', 'B', 'C'].entries()) {
        const x0 = img.width * (0.13 + i * 0.28);
        const region = { x0, y0: plotTop, x1: x0 + img.width * 0.2, y1: plotBottom };
        if (!hasColour(img, region, [126, 63, 242], 60)) {
          problems.push(`bar ${label} has no fill — the renderer dropped it`);
        }
      }
      return problems;
    },
  },
  {
    name: 'waterfall deltas are drawn in their semantic colours',
    chart: () => waterfallChart({
      steps: [
        { label: 'Start', value: 400_000, kind: 'start' },
        { label: 'Up', value: 150_000, kind: 'delta' },
        { label: 'Down', value: -60_000, kind: 'delta' },
        { label: 'End', value: 0, kind: 'end' },
      ],
      unit: 'USD', width: 600, height: 300,
    }),
    check(img) {
      const whole = { x0: 0, y0: 0, x1: img.width, y1: img.height };
      const problems = [];
      if (!hasColour(img, whole, [31, 122, 77], 50)) problems.push('no positive delta drawn');
      if (!hasColour(img, whole, [163, 36, 59], 50)) problems.push('no negative delta drawn');
      return problems;
    },
  },
  {
    name: 'an absent cohort cell stays blank rather than printing as zero',
    chart: () => cohortHeatmap({
      cohorts: ['C1', 'C2'],
      periods: ['M0', 'M3'],
      values: [[100, 104], [100, null]],
      unit: 'percent', width: 420,
    }),
    check(img) {
      // Bottom-right cell is the absent one. It must be nearly empty: a hairline
      // border and nothing else. Anything denser means a value was printed.
      const region = { x0: img.width * 0.68, y0: img.height * 0.62, x1: img.width * 0.95, y1: img.height * 0.92 };
      const density = inkDensity(img, region);
      return density > 0.12
        ? [`absent cell has ink density ${density.toFixed(3)} — something was printed where there is no data`]
        : [];
    },
  },
  {
    name: 'donut arcs render as filled rings',
    chart: () => donutChart({
      slices: [{ name: 'A', value: 60 }, { name: 'B', value: 40 }],
      unit: 'percent', width: 420, height: 280,
    }),
    check(img) {
      const ring = { x0: img.width * 0.05, y0: img.height * 0.1, x1: img.width * 0.55, y1: img.height * 0.9 };
      return hasColour(img, ring, [126, 63, 242], 60) ? [] : ['the donut has no filled arc'];
    },
  },
];

async function run() {
  mkdirSync(WORK, { recursive: true });
  let failed = 0;

  for (const [i, c] of CASES.entries()) {
    const result = c.chart();
    if (!result.ok) {
      console.log(`  ✗ ${c.name}\n      the chart refused to draw: ${result.reason}`);
      failed++;
      continue;
    }

    const html = htmlDocument({
      title: c.name,
      size: 'a4landscape',
      body: `<div style="padding:0;margin:0">${result.svg}</div>`,
      extraCss: 'body{margin:0}svg{width:297mm}',
      embedFonts: true,
    });

    const base = `${WORK}/case-${i}`;
    writeFileSync(`${base}.html`, html);
    await renderPdf(`${base}.html`, `${base}.pdf`, { size: 'a4landscape' });
    execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', `${base}.pdf`, base]);

    const ppm = [`${base}-1.ppm`, `${base}-01.ppm`].find((p) => existsSync(p));
    if (!ppm) { console.log(`  ✗ ${c.name}\n      no raster produced`); failed++; continue; }

    const problems = c.check(readPpm(ppm));
    if (problems.length) {
      failed++;
      console.log(`  ✗ ${c.name}`);
      problems.forEach((p) => console.log(`      ${p}`));
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }

  console.log(`\n${CASES.length - failed}/${CASES.length} ink checks passed.`);
  if (failed) {
    console.log('\nA failure here means the SVG is right and the RENDERER lost it. '
      + 'Check the renderer and its version before changing the chart.');
    process.exitCode = 1;
  }
}

console.log('\nInk checks — is the chart actually on the page?\n');
run().catch((err) => { console.error(err); process.exitCode = 1; });
