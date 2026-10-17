/**
 * Screenshot every page of the running app.
 *
 *   node --experimental-sqlite tools/proof-web.mjs [outDir]
 *
 * WHY THIS EXISTS
 *
 * HTML that contains the right strings can still look wrong. Twice in this
 * build a page passed every assertion and was broken on screen — once a palette
 * that had been replaced everywhere, once a chart heading orphaned from its
 * chart. Neither was findable by reading markup, and both were obvious in a
 * picture.
 *
 * So the pages get looked at. The app is booted against a seeded in-memory
 * database and every route is photographed at two widths, because the narrow one
 * is where a twelve-item index rail and a wide data table disagree.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { boot } from '../src/web/boot.js';
import { ROUTES } from '../src/web/routes/index.js';

const require = createRequire(import.meta.url);

const DRIVERS = ['playwright-core', '/opt/npm-tools/node_modules/playwright-core',
  '/opt/node-tools/node_modules/playwright-core'];
const BROWSERS = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

function loadPlaywright() {
  for (const id of DRIVERS) {
    try { return require(id); } catch { /* next */ }
  }
  throw new Error('playwright-core is not available.');
}

const WIDTHS = [
  ['wide', 1280, 900],
  // The rail collapses below 60rem. A narrow shot is where a twelve-item index
  // and a wide table disagree, and it is the shot nobody takes.
  ['narrow', 420, 900],
];

const outDir = resolve(process.argv[2] ?? 'out/web');
mkdirSync(outDir, { recursive: true });

const app = boot({
  env: {
    PORT: '8181',
    STORAGE_SECRET: 'proof-secret-long-enough-to-be-accepted',
    STORAGE_DIR: resolve(outDir, 'objects'),
    DATABASE_FILE: ':memory:',
  },
  log: { log() {}, warn() {}, error: console.error },
});

const base = 'http://127.0.0.1:8181';
let cookie = '';
const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
const text = async (path) => (await fetch(base + path, { headers: { cookie } })).text();

// ── set up a seeded organisation through the real forms ─────────────────────
let res = await fetch(`${base}/sign-up`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: 'founder@example.com', password: 'a long enough passphrase', name: 'A Founder' }),
});
cookie = res.headers.get('set-cookie').split(';')[0];

res = await fetch(`${base}/orgs`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ name: 'Northwind Systems', path: 'RAISE', csrf: csrfOf(await text('/')) }),
});
const orgId = res.headers.get('location').match(/\/org\/([^?]+)/)[1];

await fetch(`${base}/org/${orgId}/example`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf: csrfOf(await text(`/org/${orgId}/example`)) }),
});

const artifactId = (await text(`/org/${orgId}/artifacts`))
  .match(new RegExp(`/org/${orgId}/artifacts/([0-9a-f-]{36})`))?.[1];

// Two share links, issued through the real form. The counterparty's page has a
// layout of its own — no rail, its own header and footer — so it is the one
// page most likely to be broken without anybody noticing: nobody using the
// product ever sees it.
const issue = async (fields) => {
  const page = await text(`/org/${orgId}/sharing`);
  const made = await fetch(`${base}/org/${orgId}/sharing`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, csrf: csrfOf(page) }),
  });
  return (await made.text()).match(/\/s\/([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
};

const roomToken = await issue({
  recipient_name: 'Vantage Partners', recipient_org: 'Vantage',
  subject_kind: 'ROOM', stage: 'QUALIFIED', share_mode: 'FOLLOW_LATEST',
});
const docToken = await issue({
  recipient_name: 'Harbour Capital', recipient_org: 'Harbour',
  subject_kind: 'ARTIFACT', artifact_id: artifactId,
  stage: 'QUALIFIED', share_mode: 'PINNED',
});

const paths = [
  ...ROUTES.filter((r) => (r.method ?? 'GET') === 'GET' && !/:(?!org)/.test(r.path))
    .map((r) => r.path.replace(':org', orgId))
    .filter((p) => p !== '/sign-in' && p !== '/sign-up' && !p.endsWith('/export')),
  `/org/${orgId}/artifacts/${artifactId}`,
  ...[roomToken, docToken].filter(Boolean).map((t) => `/s/${t}`),
];

// ── photograph ──────────────────────────────────────────────────────────────
const { chromium } = loadPlaywright();
const executablePath = BROWSERS.find(Boolean);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

const problems = [];
for (const [label, width, height] of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.context().addCookies([{
    name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='),
    domain: '127.0.0.1', path: '/',
  }]);

  for (const path of paths) {
    // A token is 43 characters of base64url and makes a useless filename, so
    // the two share pages are named for what they show instead.
    const slug = path === '/' ? 'home'
      : path === `/s/${roomToken}` ? 'share-room'
        : path === `/s/${docToken}` ? 'share-document'
          : path.replace(orgId, 'org').replace(/^\//, '').replace(/\//g, '-');
    const name = `${slug}.${label}.png`;
    const messages = [];
    page.on('console', (m) => { if (m.type() === 'error') messages.push(m.text()); });

    const response = await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.screenshot({ path: resolve(outDir, name), fullPage: true });

    // A horizontal scrollbar on a page of text is a layout that broke, and it
    // is the commonest thing a wide-only screenshot misses.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);

    const status = response.status();
    if (status !== 200) problems.push(`${path} (${label}) returned ${status}`);
    if (overflow > 2) problems.push(`${path} (${label}) overflows horizontally by ${overflow}px`);
    for (const m of messages) problems.push(`${path} (${label}) console: ${m}`);

    // eslint-disable-next-line no-console
    console.log(`  ${String(status).padEnd(4)} ${label.padEnd(7)} ${name}${overflow > 2 ? `  ← overflow ${overflow}px` : ''}`);
  }
  await page.close();
}

await browser.close();
app.server.close();

writeFileSync(resolve(outDir, 'problems.txt'), problems.join('\n') || 'none\n');
// eslint-disable-next-line no-console
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nNo problems found.');
process.exit(problems.length ? 1 : 0);
