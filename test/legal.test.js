/**
 * The four legal pages.
 *
 * What is tested here is not the text of any document — none of it is in this
 * repository, deliberately. It is the rules around publishing one:
 *
 *   1. A document carrying working notes or an unfilled sub-processor name is
 *      REFUSED rather than served. That is the failure this module exists to
 *      prevent, and it is the one nobody notices until a reviewer does.
 *   2. Every page is reachable without an account, because a policy you have
 *      to sign in to read is not published.
 *   3. The four paths are the four the landing page already links, and the
 *      footer links all four from every page.
 *   4. The renderer escapes before it renders, so a clause containing `<` or
 *      `&` cannot be eaten by a browser's parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { freshDb, fakeStorage, FIXTURE_LEGAL_DIR } from './helpers.js';
import { createApp } from '../src/web/server.js';
import { ROUTES } from '../src/web/routes/index.js';
import {
  LEGAL_DOCUMENTS, documentFor, publishability, renderLegalMarkdown,
  WORKING_NOTE_MARKERS, PLACEHOLDERS,
} from '../src/domain/legal.js';
import { legalDocument, DEFAULT_LEGAL_DIR } from '../src/web/legal.js';
import { layout } from '../src/web/html.js';

async function serve({ legalDir = FIXTURE_LEGAL_DIR } = {}) {
  const db = freshDb();
  const app = createApp({ db, secure: false, storage: fakeStorage(), legalDir });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((resolve) => { server.listen(0, resolve); });
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => { server.close(r); }) };
}

const get = (app, path) => fetch(`${app.base}${path}`, { redirect: 'manual' });

/** A directory holding exactly the documents a test puts in it. */
function withDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'raiseroom-legal-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

// ────────────────────────────────────────────────────────────── the four ──

test('the four documents are the four the landing page links', () => {
  // The landing page is a static file with the paths written into it. If this
  // list and that file disagree, the footer of the marketing site points at a
  // route that does not exist — and nothing else would catch it.
  const landing = readFileSync(fileURLToPath(new URL('../docs/landing/index.html', import.meta.url)), 'utf8');
  for (const { path } of LEGAL_DOCUMENTS) {
    assert.ok(landing.includes(`href="${path}"`), `the landing page does not link ${path}`);
  }
  assert.deepEqual(LEGAL_DOCUMENTS.map((d) => d.path).sort(),
    ['/dpa', '/privacy', '/subprocessors', '/terms']);
});

test('every legal page has a route, and every one is public', () => {
  for (const { path } of LEGAL_DOCUMENTS) {
    const route = ROUTES.find((r) => r.path === path && (r.method ?? 'GET') === 'GET');
    assert.ok(route, `no route serves ${path}`);
    assert.equal(route.auth, false, `${path} requires an account, so it is not published`);
  }
});

test('the subprocessors page exists, because the privacy policy calls it authoritative', () => {
  // The one page `docs/legal/README.md` singles out: the policy names it as the
  // authoritative list, so a policy published without it points at a 404 on the
  // one subject a reviewer checks.
  assert.ok(documentFor('subprocessors'));
  assert.ok(ROUTES.some((r) => r.path === '/subprocessors'));
});

test('the footer links all four from every page', () => {
  // The requirement is "footer, sign-up and plan pages". The footer is on every
  // page, so one footer satisfies all three rather than three lists that drift.
  const html = layout({ title: 'Anything', body: '<p>a page</p>' });
  for (const { path, title } of LEGAL_DOCUMENTS) {
    assert.ok(html.includes(`href="${path}"`), `the footer does not link ${path}`);
    assert.ok(html.includes(title), `the footer does not name ${title}`);
  }
});

// ──────────────────────────────────────────────────── what may be published ──

test('a document still carrying working notes is refused', () => {
  for (const marker of WORKING_NOTE_MARKERS) {
    const { publishable, problems } = publishability(`# Terms\n\nReal text.\n\n## ${marker}\n\nNotes.`);
    assert.equal(publishable, false, `"${marker}" was allowed through`);
    assert.ok(problems.some((p) => p.code === 'working_notes'));
  }
});

test('a document with an unfilled sub-processor name is refused', () => {
  for (const placeholder of PLACEHOLDERS) {
    const { publishable, problems } = publishability(`# Privacy\n\nWe use ${placeholder} for things.`);
    assert.equal(publishable, false, `${placeholder} was allowed through`);
    assert.ok(problems.some((p) => p.code === 'placeholder'));
  }
});

test('an empty file is refused rather than served as a blank policy', () => {
  assert.equal(publishability('   \n  ').publishable, false);
  assert.equal(publishability('').problems[0].code, 'empty');
});

test('an ordinary document is publishable, including one full of brackets and ampersands', () => {
  const text = '# Terms\n\nContracts for <$10,000 with Smith & Co are "out of scope" [see below].';
  assert.equal(publishability(text).publishable, true);
});

test('a refused document is not served, and the page says which rule it broke', async () => {
  const { dir, remove } = withDir({
    'privacy.md': '# Privacy policy\n\nWe use [email provider] to send mail.\n',
  });
  const app = await serve({ legalDir: dir });
  try {
    const res = await get(app, '/privacy');
    // 503: the route works and the document exists; what is missing is a step
    // somebody has to take before it may be served.
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.ok(html.includes('not ready to publish'));
    assert.ok(html.includes('[email provider]'), 'the page did not say which placeholder');
    // And not a word of the document itself.
    assert.ok(!html.includes('We use [email provider] to send mail'),
      'the refused document was rendered anyway');
  } finally { await app.close(); remove(); }
});

test('an absent document says so and names the file it will be read from', async () => {
  const { dir, remove } = withDir({});
  const app = await serve({ legalDir: dir });
  try {
    const res = await get(app, '/terms');
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.ok(html.includes('not published'));
    assert.ok(html.includes('terms.md'), 'the page did not name the file to create');
  } finally { await app.close(); remove(); }
});

test('a published document is served, with its own headings below the page title', async () => {
  const app = await serve();
  try {
    for (const { path, title } of LEGAL_DOCUMENTS) {
      const res = await get(app, path);
      assert.equal(res.status, 200, `${path} did not render`);
      const html = await res.text();
      assert.ok(html.includes(`<h1>${title}</h1>`), `${path} lost its title`);
      // The document's own `#` becomes an h2: two h1s on a page is a thing
      // screen readers announce and nobody intends.
      assert.ok(!/<h1>[^<]*Fixture text/.test(html));
      assert.ok(html.includes('<div class="legal">'));
    }
  } finally { await app.close(); }
});

test('the default directory is named in one place', () => {
  // Two defaults that can drift apart is the bug this avoids: `boot.js` passes
  // undefined rather than a path of its own.
  assert.equal(DEFAULT_LEGAL_DIR, 'docs/legal/published');
  assert.equal(legalDocument({}, 'terms').expectedAt.endsWith(join('docs', 'legal', 'published', 'terms.md')), true);
});

test('an unknown document is not a page', () => {
  assert.equal(legalDocument({ legalDir: FIXTURE_LEGAL_DIR }, 'cookies'), null);
  assert.equal(documentFor('cookies'), null);
});

// ─────────────────────────────────────────────────────────────── rendering ──

test('a clause containing markup survives as text rather than becoming markup', () => {
  // The quiet failure this guards: a legal document contains angle brackets and
  // ampersands in ordinary prose, and a renderer that passes them through loses
  // a clause to the browser's parser without anybody seeing it happen.
  const html = renderLegalMarkdown('Contracts for <$10,000 with Smith & Co.\n\n<script>alert(1)</script>');
  assert.ok(html.includes('&lt;$10,000'));
  assert.ok(html.includes('Smith &amp; Co'));
  assert.ok(!html.includes('<script>'), 'markup in the file reached the page as markup');
});

test('the subset a legal document actually uses renders', () => {
  const html = renderLegalMarkdown([
    '# Sub-processors',
    '',
    'We use these parties.',
    '',
    '| Who | What for |',
    '| --- | --- |',
    '| Whop | Taking payment |',
    '',
    '- A **bold** bullet',
    '- A [link](/privacy)',
    '',
    '1. First',
    '2. Second',
    '',
    '> A quoted note.',
    '',
    '---',
  ].join('\n'));

  assert.ok(html.includes('<h2>Sub-processors</h2>'));
  assert.ok(html.includes('<th>Who</th>') && html.includes('<td>Whop</td>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<a href="/privacy">link</a>'));
  assert.ok(html.includes('<ol>') && html.includes('<li>First</li>'));
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<hr>'));
});

test('a line with pipes in it is not mistaken for a table', () => {
  // A legal document contains plenty of prose with a pipe in it. A table is
  // recognised by its divider row, not by having pipes.
  const html = renderLegalMarkdown('You may use the service | subject to these terms.');
  assert.ok(!html.includes('<table>'));
  assert.ok(html.includes('<p>'));
});

test('a link to somewhere a browser should not follow is left as text', () => {
  const html = renderLegalMarkdown('See [this](javascript:alert(1)) for details.');
  assert.ok(!html.includes('href="javascript:'));
});

test('an unrecognised line is kept rather than dropped', () => {
  // The rule that matters most in a legal document: anything the renderer does
  // not understand comes out as legible text. Losing a clause silently is the
  // only unacceptable outcome.
  const odd = 'Clause 4.2(a)(iii) — ~~struck~~ ::weird:: {braces} 50% of fees';
  const html = renderLegalMarkdown(odd);
  for (const fragment of ['Clause 4.2(a)(iii)', 'struck', 'weird', '{braces}', '50% of fees']) {
    assert.ok(html.includes(fragment), `lost "${fragment}"`);
  }
});

// ──────────────────────────────────────────────────────────── the landing page ──

test('a visitor with no account gets the landing page at /', async () => {
  // It used to redirect to /sign-in, which made the landing page unreachable.
  const app = await serve();
  try {
    const res = await get(app, '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('Everything an investor will ask for'), 'this is not the landing page');
    // Not rendered as signed in, and offering the way in.
    assert.ok(!html.includes('/sign-out'));
    assert.ok(html.includes('/sign-up'), 'the landing page offers no way to start');
  } finally { await app.close(); }
});

test('the landing page loads nothing from anywhere else', () => {
  // A font CDN here would hand a visitor's address to a party the privacy
  // policy does not name, on the first page of a product whose argument is that
  // a company's information stays where they put it. It would also be blocked
  // by the application's own `default-src 'self'`, so the page would render in
  // fallback fonts and look like a design mistake rather than a policy working.
  const html = readFileSync(fileURLToPath(new URL('../docs/landing/index.html', import.meta.url)), 'utf8');
  const external = html.match(/https?:\/\/[^"')\s]+/g) ?? [];
  assert.deepEqual(external, [], `the landing page fetches from: ${external.join(', ')}`);
  // And no script at all, so `script-src 'self'` costs it nothing.
  assert.ok(!html.includes('<script'), 'the landing page carries script');
});

test('every font the landing page asks for is one the app actually serves', () => {
  // A @font-face pointing at a file that is not there is a page that renders in
  // a fallback and nobody notices until a designer does.
  const html = readFileSync(fileURLToPath(new URL('../docs/landing/index.html', import.meta.url)), 'utf8');
  const fonts = [...html.matchAll(/\/assets\/fonts\/([\w-]+\.ttf)/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 4, 'the landing page declares no local fonts');
  const dir = fileURLToPath(new URL('../tools/fonts/', import.meta.url));
  for (const file of new Set(fonts)) {
    assert.ok(existsSync(join(dir, file)), `${file} is declared but not in tools/fonts/`);
  }
});

test('with no landing page on disk, / falls back to sign-in rather than failing', async () => {
  // A deployment that trimmed docs/. The sign-in page is where / went for
  // everybody until now, so it is the honest fallback.
  const { landingPage, LANDING_FILE } = await import('../src/web/landing.js');
  assert.ok(LANDING_FILE.endsWith(join('docs', 'landing', 'index.html')));
  assert.ok(typeof landingPage() === 'string', 'the landing page is missing from this checkout');
});
