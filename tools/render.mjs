/**
 * HTML → PDF, via headless Chromium.
 *
 * WHY CHROMIUM AND NOT A PYTHON RENDERER
 *
 * Both candidates were tried on the same chart SVG before anything was built on
 * either. WeasyPrint produced a PDF with no error and **two of the three bars
 * missing** — it silently dropped every gradient-filled shape. A renderer that
 * fails loudly is an inconvenience; one that fails silently ships a deck with
 * holes in it to an investor.
 *
 * `tools/inkcheck.mjs` exists because of that spike: it rasterises the output
 * and asserts that ink actually landed where the chart said it would, so a
 * renderer swap or a version bump cannot quietly reintroduce the same class of
 * failure.
 *
 *   node tools/render.mjs <input.html> <output.pdf> [--size slide|a4|a4landscape]
 */

import { argv, exit } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Chromium ships with the environment; Playwright is used only as a driver. */
const CANDIDATE_DRIVERS = [
  'playwright-core',
  '/opt/npm-tools/node_modules/playwright-core',
  '/opt/node-tools/node_modules/playwright-core',
];

const CANDIDATE_BROWSERS = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

export const SIZES = {
  slide: { width: '297mm', height: '167mm' },
  a4: { width: '210mm', height: '297mm' },
  a4landscape: { width: '297mm', height: '210mm' },
};

function loadChromium() {
  for (const id of CANDIDATE_DRIVERS) {
    try { return require(id).chromium; } catch { /* try the next */ }
  }
  throw new Error('playwright-core not found — the PDF renderer needs it to drive Chromium');
}

function findBrowser() {
  const hit = CANDIDATE_BROWSERS.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(`no Chromium binary found. Tried:\n  ${CANDIDATE_BROWSERS.join('\n  ')}`);
  }
  return hit;
}

export async function renderPdf(htmlPath, pdfPath, { size = 'slide' } = {}) {
  const chromium = loadChromium();
  const executablePath = findBrowser();
  const dims = SIZES[size] ?? SIZES.slide;

  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage();
    // 'load' rather than 'networkidle': everything is inline and local, so
    // waiting on the network would only wait for a timeout.
    await page.goto(`file://${resolve(htmlPath)}`, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: resolve(pdfPath),
      width: dims.width,
      height: dims.height,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }
  return pdfPath;
}

if (import.meta.url === `file://${argv[1]}`) {
  const [input, output] = argv.slice(2).filter((a) => !a.startsWith('--'));
  const sizeFlag = argv.find((a) => a.startsWith('--size='));
  if (!input || !output) {
    console.error('usage: node tools/render.mjs <input.html> <output.pdf> [--size=slide|a4|a4landscape]');
    exit(1);
  }
  renderPdf(input, output, { size: sizeFlag ? sizeFlag.split('=')[1] : 'slide' })
    .then((p) => console.log(`wrote ${p}`))
    .catch((err) => { console.error(err.message); exit(1); });
}
