/**
 * Capture the running application as a clickable static site.
 *
 *   node --experimental-sqlite tools/snapshot.mjs out/snapshot
 *
 * WHY THIS EXISTS
 *
 * The application is a server: sessions, POSTs, SQLite. It cannot be handed to
 * somebody as a link unless it is hosted somewhere. For a design review that is
 * a lot of infrastructure to stand up in order to answer "does this read well".
 *
 * So this captures the real pages — the real markup, the real stylesheet, the
 * real fonts, the real content from the worked example — and rewrites the links
 * between them to flat filenames. What comes out is the actual interface, not a
 * mockup of it, with everything that needs a server removed.
 *
 * WHAT IS HONEST ABOUT IT AND WHAT IS NOT
 *
 * Every pixel is real. Nothing is redrawn and no content is invented for the
 * snapshot: it is the worked example, which carries the illustrative notice on
 * every page exactly as the running product does.
 *
 * What it cannot do is anything that writes. Forms are left in place because
 * they are most of what there is to look at, but their actions are neutered —
 * a reviewer clicking Save should see nothing happen rather than a broken page,
 * and the strip at the top of every page says so once.
 */

import { mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { boot } from '../src/web/boot.js';

const outDir = resolve(process.argv[2] ?? 'out/snapshot');
mkdirSync(join(outDir, 'assets', 'fonts'), { recursive: true });

const PORT = 8191;
const base = `http://127.0.0.1:${PORT}`;

const app = boot({
  env: {
    PORT: String(PORT),
    DEMO_SEED: '1',
    STORAGE_SECRET: 'snapshot-secret-long-enough-to-be-accepted-here',
    STORAGE_DIR: join(outDir, '.objects'),
    DATABASE_FILE: ':memory:',
  },
  log: { log() {}, warn() {}, error: console.error },
});

const { demonstration } = app;
const orgId = demonstration.organisation.id;

// ── sign in ─────────────────────────────────────────────────────────────────
const signIn = await fetch(`${base}/sign-in`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: demonstration.email, password: demonstration.password }),
});
const cookie = signIn.headers.get('set-cookie').split(';')[0];
const get = (path, c = cookie) => fetch(base + path, { headers: c ? { cookie: c } : {} });

// ── what to capture, and what each page is called ───────────────────────────
const artifacts = [...new Set(
  [...(await (await get(`/org/${orgId}/artifacts`)).text())
    .matchAll(/\/artifacts\/([0-9a-f-]{36})\b/g)].map((m) => m[1]),
)];
const documents = [...new Set(
  [...(await (await get(`/org/${orgId}/documents`)).text())
    .matchAll(/\/documents\/([0-9a-f-]{36})\//g)].map((m) => m[1]),
)];
const tokens = demonstration.links.map((l) => l.token);

/** path → filename. The order is the order of the index rail. */
const pages = new Map([
  [`/org/${orgId}`, 'index.html'],
  [`/org/${orgId}/readiness`, '01-readiness.html'],
  [`/org/${orgId}/gaps`, '02-gaps.html'],
  [`/org/${orgId}/room`, '03-data-room.html'],
  [`/org/${orgId}/upkeep`, '03a-keeping-it-current.html'],
  [`/org/${orgId}/documents`, '04-documents.html'],
  [`/org/${orgId}/transfer-sheet`, '04a-transfer-sheet.html'],
  [`/org/${orgId}/facts`, '05-figures.html'],
  [`/org/${orgId}/conflicts`, '05a-contradictions.html'],
  [`/org/${orgId}/writing`, '06-writing.html'],
  [`/org/${orgId}/languages`, '06a-languages.html'],
  [`/org/${orgId}/artifacts`, '07-documents-out.html'],
  [`/org/${orgId}/cadence`, '08-forecasts.html'],
  [`/org/${orgId}/sharing`, '09-sharing.html'],
  [`/org/${orgId}/questions`, '09a-questions.html'],
  [`/org/${orgId}/access`, '09b-who-has-looked.html'],
  [`/org/${orgId}/sharing/updates`, '09c-updates-waiting.html'],
  [`/org/${orgId}/advisor`, '10-advisor.html'],
  [`/org/${orgId}/valuation`, '11-valuation.html'],
  [`/org/${orgId}/settings`, '12-settings.html'],
  [`/org/${orgId}/plan`, '12a-plan.html'],
  [`/org/${orgId}/people`, '12b-people.html'],
  [`/org/${orgId}/visibility`, '12c-visibility.html'],
  [`/org/${orgId}/audit`, '12d-what-has-happened.html'],
  [`/org/${orgId}/example`, '12e-worked-example.html'],
  ['/account', 'account.html'],
  ['/', 'your-organisations.html'],
  ['/sign-in', 'sign-in.html'],
  ['/sign-up', 'sign-up.html'],
]);

artifacts.forEach((id, i) => {
  pages.set(`/org/${orgId}/artifacts/${id}`, `document-${i + 1}.html`);
  pages.set(`/org/${orgId}/artifacts/${id}/view`, `document-${i + 1}-page.html`);
  pages.set(`/org/${orgId}/artifacts/${id}/regenerate`, `document-${i + 1}-regenerate.html`);
});
documents.forEach((id, i) => {
  pages.set(`/org/${orgId}/documents/${id}/review`, `source-document-${i + 1}.html`);
});
tokens.forEach((t, i) => {
  pages.set(`/s/${t}`, `counterparty-${i + 1}.html`);
  pages.set(`/s/${t}/document`, `counterparty-${i + 1}-page.html`);
});

// ── the strip ───────────────────────────────────────────────────────────────
//
// Said once, at the very top, outside the application's own frame so that it is
// plainly not part of what is being reviewed.
const STRIP = `<style>
  body{padding-bottom:3.25rem}
  .snapshot-strip{
    position:fixed; left:0; right:0; bottom:0; z-index:50;
    font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    background:#111; color:#fff; padding:.55rem .9rem;
    display:flex; gap:.6rem; flex-wrap:wrap; align-items:baseline;
    border-top:2px solid #7E3FF2;
  }
  .snapshot-strip span{color:#bbb}
  @media print{.snapshot-strip{display:none}}
</style>
<div class="snapshot-strip" role="note">
  <strong>Static snapshot for design review.</strong>
  <span>Real pages from the running app, with the worked example in them. Links work; anything that
  would save does nothing.</span>
</div>`;

/** Rewrite one page's links to the flat filenames, and neuter its forms. */
function rewrite(html, selfPath) {
  let out = html;

  // Longest paths first, so `/artifacts/:id/view` is replaced before
  // `/artifacts/:id` eats its prefix.
  const byLength = [...pages.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [path, file] of byLength) {
    out = out.split(`"${path}"`).join(`"${file}"`);
    out = out.split(`"${path}?`).join(`"${file}?`);
    out = out.split(`src="${path}"`).join(`src="${file}"`);
  }

  // Assets are published beside the pages, so their absolute paths become
  // relative. A published artifact has no server to resolve a leading slash
  // against.
  out = out.split('"/assets/').join('"assets/');

  // Anything still pointing at the server is a page this snapshot does not
  // carry. Marked rather than left to 404, so a reviewer can tell "not captured"
  // from "broken".
  out = out.replace(/href="\/(?!assets)[^"]*"/g,
    'href="#" data-not-captured="1" title="Not in this snapshot"');

  // Forms stay, because they are most of what there is to look at. Their action
  // becomes this same page and their method becomes GET, so a submit reloads
  // what you are already looking at instead of erroring.
  out = out.replace(/<form([^>]*?)method="post"([^>]*?)action="[^"]*"/g,
    `<form$1method="get"$2action="${pages.get(selfPath) ?? '#'}"`);
  out = out.replace(/<form([^>]*?)action="[^"]*"([^>]*?)method="post"/g,
    `<form$1action="${pages.get(selfPath) ?? '#'}"$2method="get"`);

  // The sign-out form in the header would otherwise look live.
  out = out.replace(/action="\/sign-out"/g, 'action="#"');

  // Appended rather than prepended. Injected after `<body>` it became the first
  // child of the page's own grid and pushed the header out of the layout — a
  // review aid that changes the thing being reviewed is worse than none.
  return out.replace('</body>', `${STRIP}</body>`);
}

// ── capture ─────────────────────────────────────────────────────────────────
let captured = 0;
const missing = [];

for (const [path, file] of pages) {
  const isPublic = path.startsWith('/s/') || path === '/sign-in' || path === '/sign-up';
  const res = await get(path, isPublic ? '' : cookie);
  if (res.status !== 200) { missing.push(`${path} → ${res.status}`); continue; }

  const html = await res.text();
  writeFileSync(join(outDir, file), rewrite(html, path));
  captured++;
}

// ── assets ──────────────────────────────────────────────────────────────────
// The stylesheet sits in `assets/`, so its own font URLs lose that prefix too.
const css = (await (await get('/assets/app.css')).text())
  .split("url('/assets/fonts/").join("url('fonts/");
writeFileSync(join(outDir, 'assets', 'app.css'), css);
writeFileSync(join(outDir, 'assets', 'icon.svg'), await (await get('/assets/icon.svg')).text());

const fontDir = resolve('tools/fonts');
for (const f of readdirSync(fontDir).filter((n) => n.endsWith('.ttf'))) {
  copyFileSync(join(fontDir, f), join(outDir, 'assets', 'fonts', f));
}

app.server.close();

// eslint-disable-next-line no-console
console.log(`${captured} pages captured into ${outDir}`);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.log(`not captured:\n  ${missing.join('\n  ')}`);
}
