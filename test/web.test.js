/**
 * The web layer.
 *
 * Two things are tested here and nothing else, because nothing else belongs in
 * this layer:
 *
 *   1. **Security properties.** Authentication, session handling, CSRF, the
 *      headers, and that nothing reaches a page unescaped. These are the
 *      guarantees that have no home below the HTTP layer.
 *
 *   2. **That every page renders and every form posts.** Not what the pages say
 *      — that is the service layer's job and is tested there — but that the
 *      wiring between them holds, which is exactly what a thin layer can still
 *      get wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, ctxFor, fakeStorage, FIXTURE_LEGAL_DIR } from './helpers.js';
import { createApp, parseForm } from '../src/web/server.js';
import { ROUTES } from '../src/web/routes/index.js';
import * as auth from '../src/web/auth.js';
import * as svc from '../src/api/service.js';
import * as dataroom from '../src/api/dataroom.js';
import {
  hashPassword, verifyPassword, passwordProblems, csrfValid, securityHeaders,
  readCookie, sessionCookie, originAllowed, lockState, MAX_FAILED_LOGINS,
  MIN_PASSWORD_LENGTH,
} from '../src/web/security.js';
import { h, layout, figure } from '../src/web/html.js';
import { memoryStorageDriver } from '../src/storage/local.js';
import { REFUSAL_SENTENCES, sentenceFor } from '../src/web/wording.js';
import { safeNext } from '../src/web/routes/auth.js';
import { createThrottle, addressFor, LIMITS } from '../src/web/throttle.js';

/** A live server on an ephemeral port, torn down by the caller. */
async function serve() {
  const db = freshDb();
  const app = createApp({ db, secure: false, storage: fakeStorage(), legalDir: FIXTURE_LEGAL_DIR });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((resolve) => { server.listen(0, resolve); });
  // Unreferenced: a leaked server here would hang `npm test`, and under the
  // mutation harness that stalls the whole run silently.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, close: () => new Promise((r) => { server.close(r); }) };
}

/** Sign up through the real forms, so the test exercises the same path a user does. */
async function signedIn(app, { email = 'founder@example.com', password = 'a long enough passphrase' } = {}) {
  const res = await fetch(`${app.base}/sign-up`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password, name: 'A Founder' }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { cookie, status: res.status };
}

const get = (app, path, cookie) =>
  fetch(`${app.base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

const post = (app, path, cookie, fields) =>
  fetch(`${app.base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

/** The CSRF token a page is currently carrying. */
const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';

/**
 * Source with comments removed, for the structural checks below.
 *
 * Crude on purpose — it does not understand a `//` inside a string literal, and
 * it does not need to: it is used only to stop a prose explanation of a rule
 * from tripping the check for breaking that rule.
 */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ──────────────────────────────────────────────────────────── passwords ──

test('a password is stored as a scrypt derivation, never in a readable form', () => {
  const stored = hashPassword('a long enough passphrase');
  assert.ok(!stored.includes('a long enough passphrase'));
  const [N, r, p, salt, derived] = stored.split('$');
  assert.ok(Number(N) >= 32_768, 'the work factor is too low');
  assert.ok(Number(r) >= 8);
  assert.ok(Number(p) >= 1);
  assert.equal(salt.length, 32, 'the salt is not 16 bytes');
  assert.ok(derived.length >= 64);
});

test('the same password hashes differently every time', () => {
  // Per-user salt. Without it, two people with the same password have the same
  // row, and one rainbow table does the lot.
  assert.notEqual(hashPassword('a long enough passphrase'), hashPassword('a long enough passphrase'));
});

test('verification succeeds only for the right password', () => {
  const stored = hashPassword('a long enough passphrase');
  assert.equal(verifyPassword('a long enough passphrase', stored).ok, true);
  assert.equal(verifyPassword('a long enough passphras', stored).ok, false);
  assert.equal(verifyPassword('', stored).ok, false);
  assert.equal(verifyPassword('x', 'not-a-hash').ok, false);
});

test('a hash derived under weaker parameters is flagged for upgrade', () => {
  const weak = hashPassword('a long enough passphrase', { N: 16_384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });
  const result = verifyPassword('a long enough passphrase', weak);
  assert.equal(result.ok, true);
  assert.equal(result.needs_rehash, true);
});

test('password rules are about length, not composition', () => {
  // Composition rules push people towards Password1! and towards reuse.
  assert.ok(passwordProblems('short').length > 0);
  assert.deepEqual(passwordProblems('correct horse battery staple'), []);
  assert.ok(passwordProblems('founder is my password', { email: 'founder@example.com' }).length > 0);
  assert.ok(MIN_PASSWORD_LENGTH >= 12);
});

// ─────────────────────────────────────────────────── sessions and sign-in ──

test('signing up signs you in and sets a hardened cookie', async () => {
  const app = await serve();
  try {
    const res = await fetch(`${app.base}/sign-up`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@example.com', password: 'a long enough passphrase' }),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.equal(res.status, 303);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
  } finally { await app.close(); }
});

test('the session token is stored hashed, so a database dump is not a set of logins', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const token = cookie.split('=')[1];
    const rows = app.db.find('web_session', {});
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].token_hash.includes(token), 'the raw token is in the database');
    assert.equal(rows[0].token_hash.length, 64);
  } finally { await app.close(); }
});

test('every failure to sign in says the same thing', async () => {
  // "No account with that address" and "wrong password" are different facts, and
  // telling them apart turns a login form into a way to enumerate accounts.
  const app = await serve();
  try {
    await signedIn(app, { email: 'real@example.com' });
    const wrongUser = await post(app, '/sign-in', '', { email: 'nobody@example.com', password: 'a long enough passphrase' });
    const wrongPass = await post(app, '/sign-in', '', { email: 'real@example.com', password: 'a different passphrase' });

    const a = await wrongUser.text();
    const b = await wrongPass.text();
    assert.equal(wrongUser.status, wrongPass.status);
    assert.match(a, /do not match an account/);
    assert.match(b, /do not match an account/);
  } finally { await app.close(); }
});

test('registering an address that already exists is indistinguishable from success', async () => {
  // Otherwise a public signup form answers "does this person have an account".
  const app = await serve();
  try {
    await signedIn(app, { email: 'taken@example.com' });
    const again = await fetch(`${app.base}/sign-up`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'taken@example.com', password: 'a different long passphrase' }),
    });
    assert.equal(again.status, 303, 'the duplicate was announced');
    const html = await (await get(app, '/sign-in')).text();
    assert.ok(!/already|taken|in use/i.test(html));
  } finally { await app.close(); }
});

test('an account locks briefly after repeated failures, and the lock expires', () => {
  const db = freshDb();
  const ctx = ctxFor(db, 'system');
  auth.register(ctx, { email: 'lock@example.com', password: 'a long enough passphrase' });

  for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
    assert.throws(() => auth.signIn(ctx, { email: 'lock@example.com', password: 'wrong wrong wrong' }));
  }
  const err = (() => {
    try { auth.signIn(ctx, { email: 'lock@example.com', password: 'a long enough passphrase' }); return null; } catch (e) { return e; }
  })();
  assert.equal(err.code, 'account_locked');

  // Short and self-clearing: a long lock hands anybody a way to lock a user out
  // by guessing their password wrongly on purpose.
  const user = db.findOne('user_account', { email_lower: 'lock@example.com' });
  assert.equal(lockState(user, '2099-01-01T00:00:00.000Z').locked, false);
});

test('signing out ends the session server-side, not just in the browser', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const page = await (await get(app, '/', cookie)).text();
    const res = await post(app, '/sign-out', cookie, { csrf: csrfFrom(page) });
    assert.equal(res.status, 303);
    assert.equal(app.db.find('web_session', {}).length, 0);

    // And the cookie no longer works, which a client-side-only sign-out misses.
    //
    // Checked on a page that REQUIRES a session rather than on `/`, which is
    // now the public landing page and answers 200 to everybody. Two assertions
    // rather than one status code: the dead cookie opens nothing, and `/` does
    // not render as signed in.
    assert.equal((await get(app, '/account', cookie)).status, 303);

    const home = await get(app, '/', cookie);
    const html = await home.text();
    assert.ok(!html.includes('/sign-out'), 'a dead cookie still rendered a signed-in page');
  } finally { await app.close(); }
});

test('changing a password signs out every other browser', () => {
  const db = freshDb();
  const ctx = ctxFor(db, 'system');
  const user = auth.register(ctx, { email: 'c@example.com', password: 'a long enough passphrase' }).body.user;
  auth.openSession(ctx, user.id);
  auth.openSession(ctx, user.id);
  assert.equal(db.find('web_session', { user_id: user.id }).length, 2);

  auth.changePassword(ctx, user.id, { current: 'a long enough passphrase', next: 'another long passphrase' });
  assert.equal(db.find('web_session', { user_id: user.id }).length, 0);
});

test('an expired session is cleaned up rather than honoured', () => {
  const db = freshDb();
  const ctx = ctxFor(db, 'system');
  const user = auth.register(ctx, { email: 'e@example.com', password: 'a long enough passphrase' }).body.user;
  const session = auth.openSession(ctx, user.id);
  db.update('web_session', session.id, { expires_at: '2020-01-01T00:00:00.000Z' });

  assert.equal(auth.resolveSession(ctx, session.token), null);
  assert.equal(db.find('web_session', {}).length, 0);
});

// ─────────────────────────────────────────────────────────────────── CSRF ──

test('a form without a valid CSRF token is refused', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const res = await post(app, '/orgs', cookie, { name: 'Forged', path: 'RAISE', csrf: 'wrong' });
    assert.equal(res.status, 403);
    assert.equal(app.db.find('organisation', {}).length, 0, 'the forged request changed something');
  } finally { await app.close(); }
});

test('a form with no CSRF token at all is refused', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const res = await post(app, '/orgs', cookie, { name: 'Forged', path: 'RAISE' });
    assert.equal(res.status, 403);
  } finally { await app.close(); }
});

test('CSRF comparison is constant time and rejects empty tokens', () => {
  assert.equal(csrfValid('abc', 'abc'), true);
  assert.equal(csrfValid('abc', 'abd'), false);
  assert.equal(csrfValid('', ''), false, 'an empty token matched an empty expectation');
  assert.equal(csrfValid(null, 'abc'), false);
  assert.equal(csrfValid('abc', null), false);
});

test('a post from another origin is refused even when the CSRF token is correct', async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // THE TOKEN HAS TO BE VALID FOR THIS TEST TO MEAN ANYTHING
  //
  // The first version of this test sent a cross-origin post with no CSRF token
  // and asserted a 403. It passed with the origin check deleted, because the
  // CSRF check refuses the same request with the same status — so the test was
  // proving the CSRF check twice and proving nothing about the origin check.
  // A mutation that removed the origin check survived, which is how it was
  // found.
  //
  // Two checks for one attack is right: a token can leak through a copied URL,
  // a logged referrer, or a page that reflects it. The origin check is what
  // still holds when it has. So the test has to send a request only the origin
  // check can refuse, and that means a real token.
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const page = await (await get(app, '/', cookie)).text();
    const csrf = csrfFrom(page);
    assert.ok(csrf, 'no CSRF token to borrow, so this test cannot do its job');

    const res = await fetch(`${app.base}/orgs`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Forged', path: 'RAISE', csrf }),
    });

    assert.equal(res.status, 403);
    assert.match(await res.text(), /submitted from somewhere else/,
      'the refusal came from the CSRF check, so the origin check is untested');
    assert.equal(app.db.find('organisation', {}).length, 0, 'the forged request created an organisation');
  } finally { await app.close(); }
});

test('a post with no origin header at all is accepted, because that is normal', async () => {
  // A same-origin form post from some browsers, and every non-browser client,
  // carries no Origin. Refusing those would break the product to protect
  // against something the CSRF token already covers.
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const page = await (await get(app, '/', cookie)).text();
    const res = await post(app, '/orgs', cookie, {
      name: 'Northwind', path: 'RAISE', csrf: csrfFrom(page),
    });
    assert.equal(res.status, 303);
  } finally { await app.close(); }
});

test('originAllowed accepts a same-origin post and nothing else', () => {
  assert.equal(originAllowed({ origin: 'https://app.test', host: 'app.test' }), true);
  assert.equal(originAllowed({ origin: 'https://evil.test', host: 'app.test' }), false);
  assert.equal(originAllowed({ origin: 'http://app.test', host: 'app.test', secure: true }), false);
  assert.equal(originAllowed({ origin: null, host: 'app.test' }), true, 'a missing origin is normal');
  assert.equal(originAllowed({ origin: 'not a url', host: 'app.test' }), false);
});

// ───────────────────────────────────────────────────────── authorisation ──

test('every page redirects a signed-out visitor unless it declares itself public', async () => {
  // Driven off `auth: false` on the route rather than a list kept here. A list
  // here is a list that goes stale, and the failure mode of a stale list is a
  // page that quietly stopped requiring a session.
  const app = await serve();
  try {
    for (const route of ROUTES.filter((r) => (r.method ?? 'GET') === 'GET' && r.auth !== false)) {
      const path = route.path.replace(/:(\w+)/g, 'x');
      const res = await get(app, path);
      assert.equal(res.status, 303, `${path} did not redirect a signed-out visitor`);
      assert.match(res.headers.get('location') ?? '', /^\/sign-in/);
    }
  } finally { await app.close(); }
});

test('exactly these routes are public, and they are the share link and signing in', async () => {
  // The counterweight to the test above: that one trusts `auth: false`, so this
  // one checks the set of routes carrying it. Adding a public route is a
  // deliberate act and should fail a test until somebody says so here.
  const paths = [...new Set(ROUTES.filter((r) => r.auth === false).map((r) => r.path))].sort();
  assert.deepEqual(paths, [
    // `/` is the landing page for a visitor with no account. It was a redirect
    // to `/sign-in`, which made the landing page unreachable: the first page
    // anybody arrived on was a form asking them to sign in to a product nobody
    // had described to them. Signed in, the same route is the organisation
    // list, and that half still resolves a session before it reads a row.
    '/',
    // Somebody locked out of their account cannot be signed in to ask for a way
    // back in, so the two reset routes are public by necessity rather than by
    // convenience. What keeps them safe is not authentication: `/forgot` answers
    // identically whether or not the address has an account, and `/reset/:link`
    // is reachable only by holding an unguessable single-use token that is
    // stored hashed and never logged.
    // The four legal documents. A policy somebody has to create an account to
    // read is not a published policy, and `docs/landing/index.html` links all
    // four by these exact paths. They are served from files a deployment
    // supplies and carry nothing of any customer's.
    '/dpa',
    '/forgot',
    '/privacy',
    '/reset/:link',
    '/s/:token',
    '/s/:token/ask',
    '/s/:token/document',
    '/sign-in',
    '/sign-up',
    '/subprocessors',
    '/terms',
    // The billing webhook. Public because the caller is a payment provider's
    // server, which has no account here and cannot be given one. It is
    // authorised by a signature over the raw body, checked before the body is
    // parsed — see `api/billing.js: handleWebhook`.
    '/webhooks/billing',
  ]);
});

test('an unknown share token is refused without saying whether it ever existed', async () => {
  const app = await serve();
  try {
    const res = await get(app, '/s/not-a-real-token-at-all-but-long-enough-to-look-like-one');
    const html = await res.text();
    assert.ok(res.status >= 400, 'an invented token was accepted');
    // No sign-in prompt: a counterparty has no account, and offering one would
    // suggest the link belongs to somebody who should sign up.
    assert.ok(!html.includes('/sign-in'), 'the refusal offered to sign the reader in');
    assert.ok(!/revoked|expired|never existed/i.test(html),
      'the refusal said which kind of closed link this was');
  } finally { await app.close(); }
});

test('a member of one organisation cannot open another', async () => {
  const app = await serve();
  try {
    const mine = await signedIn(app, { email: 'mine@example.com' });
    const theirs = await signedIn(app, { email: 'theirs@example.com' });

    const page = await (await get(app, '/', theirs.cookie)).text();
    await post(app, '/orgs', theirs.cookie, { name: 'Theirs', path: 'RAISE', csrf: csrfFrom(page) });
    const org = app.db.find('organisation', {})[0];

    const res = await get(app, `/org/${org.id}`, mine.cookie);
    // 404, never 403 — a 403 would confirm the organisation exists.
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.ok(!html.includes('Theirs'), 'the other organisation was named');
  } finally { await app.close(); }
});

test('the next parameter cannot be used to redirect off-site', () => {
  // A link to /sign-in?next=https://elsewhere that lands a freshly authenticated
  // user on somebody else's page is the commonest phishing primitive there is.
  assert.equal(safeNext('/org/123'), '/org/123');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext(null), '/');
});

// ──────────────────────────────────────────────────────────────── headers ──

test('every response carries the security headers', async () => {
  const app = await serve();
  try {
    const res = await get(app, '/sign-in');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    // No unsafe-inline for script: an injected script does not run even if
    // escaping somewhere else failed.
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline script is permitted');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { await app.close(); }
});

test('HSTS is set only where the connection is secure', () => {
  assert.ok(securityHeaders({ secure: true })['Strict-Transport-Security']);
  assert.ok(!securityHeaders({ secure: false })['Strict-Transport-Security']);
});

// ──────────────────────────────────────────────────────────── escaping ──

test('user content is escaped everywhere it is rendered', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const page = await (await get(app, '/', cookie)).text();
    const nasty = '<script>alert(1)</script>';

    await post(app, '/orgs', cookie, { name: nasty, path: 'RAISE', csrf: csrfFrom(page) });
    const after = await (await get(app, '/', cookie)).text();

    assert.ok(after.includes('&lt;script&gt;'), 'the name was not escaped');
    assert.ok(!after.includes('<script>alert(1)</script>'), 'a script tag reached the page');
  } finally { await app.close(); }
});

test('h escapes every character that matters', () => {
  assert.equal(h('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(h(null), '');
  assert.equal(h(undefined), '');
});

test('a figure renders its provenance, and an unconfirmed one says so', () => {
  // The one component the whole interface is built around.
  const confirmed = figure({ value: '$3,600,000', source: 'USER_CONFIRMED' });
  assert.match(confirmed, /is-traced/);
  assert.match(confirmed, /Confirmed from a document/);

  const typed = figure({ value: '34', source: 'USER_ENTERED' });
  assert.match(typed, /no document behind it/);

  const unconfirmed = figure({ value: '4,100,000', source: 'DOCUMENT_EXTRACTED' });
  assert.match(unconfirmed, /is-unconfirmed/);
  assert.match(unconfirmed, /not yet confirmed/);
});

// ────────────────────────────────────────────────────── every page renders ──

test('every page in the app renders for a signed-in member', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const page = await (await get(app, '/', cookie)).text();
    await post(app, '/orgs', cookie, { name: 'Northwind', path: 'RAISE', csrf: csrfFrom(page) });
    const org = app.db.find('organisation', {})[0];

    const paths = ROUTES
      .filter((r) => (r.method ?? 'GET') === 'GET')
      .map((r) => r.path)
      .filter((p) => !p.includes(':') || p.includes(':org'))
      .filter((p) => !/:(?!org)/.test(p))
      .map((p) => p.replace(':org', org.id));

    let rendered = 0;
    let downloaded = 0;
    for (const path of paths) {
      const res = await get(app, path, cookie);
      assert.ok([200, 303].includes(res.status), `${path} returned ${res.status}`);
      if (res.status !== 200) continue;

      // A handful of routes are downloads rather than pages — the export is a
      // JSON file, by design, because an export a person cannot keep is not one.
      if (!(res.headers.get('content-type') ?? '').startsWith('text/html')) {
        assert.match(res.headers.get('content-disposition') ?? '', /attachment/,
          `${path} returned neither a page nor a download`);
        downloaded += 1;
        continue;
      }

      const html = await res.text();
      rendered += 1;
      assert.ok(html.includes('<!doctype html>'), `${path} did not render a page`);
      assert.ok(!html.includes('undefined'), `${path} rendered the word "undefined"`);
      assert.ok(!html.includes('[object Object]'), `${path} rendered an object`);
      assert.ok(!/NaN/.test(html), `${path} rendered NaN`);
      assert.ok(!/\bnull\b/.test(html), `${path} rendered the word "null"`);
    }
    // Without this the loop could pass by visiting nothing.
    assert.ok(rendered >= 12, `only ${rendered} pages rendered`);
    assert.ok(downloaded >= 1, 'the export did not come back as a download');
  } finally { await app.close(); }
});

test('the stylesheet and the brand faces are served from the app, not a third party', async () => {
  // A font request to a CDN tells that CDN who is reading a diligence file and
  // when. That is a privacy property, not a performance one.
  const app = await serve();
  try {
    const css = await get(app, '/assets/app.css');
    assert.equal(css.status, 200);
    const text = await css.text();
    assert.ok(!/https?:\/\//.test(text), 'the stylesheet reaches a third party');
    assert.match(text, /@font-face/);

    const font = await get(app, '/assets/fonts/Raleway-Regular.ttf');
    assert.equal(font.status, 200);
  } finally { await app.close(); }
});

test('a font path cannot escape the font directory', async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // SENT DOWN A SOCKET, NOT THROUGH FETCH
  //
  // The first version of this test used `fetch` with '/assets/fonts/../../..'
  // in the path and asserted a 404. It passed with the traversal guard deleted,
  // because `fetch` resolves `..` in the URL before the request leaves — so the
  // server received '/package.json', which is a 404 for an entirely different
  // reason. The test was asserting that an unrelated path is missing.
  //
  // An attacker does not use `fetch`. They write the bytes they want onto the
  // socket, and so does this test.
  const app = await serve();
  const { connect } = await import('node:net');

  const rawGet = (path) => new Promise((resolve, reject) => {
    const url = new URL(app.base);
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });

  try {
    for (const path of [
      '/assets/fonts/../../../package.json',
      '/assets/fonts/../../package.json',
      '/assets/fonts/../../db/schema.sql',
      '/assets/fonts/..%2f..%2fpackage.json',
      '/assets/fonts/app.css',
      '/assets/fonts/subdir/Raleway-Regular.ttf',
    ]) {
      const response = await rawGet(path);
      assert.match(response, /^HTTP\/1\.1 404/, `${path} was not refused`);
      // And nothing of the file came back in the body, whatever the status line
      // said.
      assert.ok(!response.includes('"name": "raiseroom"'), `${path} served package.json`);
      assert.ok(!response.includes('CREATE TABLE'), `${path} served the schema`);
    }

    // The one that should work, through the same raw path, so the test is not
    // passing because every font request fails.
    const good = await rawGet('/assets/fonts/Raleway-Regular.ttf');
    assert.match(good, /^HTTP\/1\.1 200/);
    assert.match(good, /content-type: font\/ttf/i);
  } finally { await app.close(); }
});

test('an unknown path is a 404 and a wrong method is a 405', async () => {
  const app = await serve();
  try {
    assert.equal((await get(app, '/nothing-here')).status, 404);
    const { cookie } = await signedIn(app);
    assert.equal((await get(app, '/sign-out', cookie)).status, 405);
  } finally { await app.close(); }
});

test('an oversized body is refused rather than buffered', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const res = await fetch(`${app.base}/orgs`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `name=${'x'.repeat(600_000)}`,
    }).catch(() => ({ status: 413 }));
    assert.ok([413, 500].includes(res.status), `got ${res.status}`);
  } finally { await app.close(); }
});

test('repeated form fields arrive as an array rather than silently losing answers', () => {
  // The assessment posts thirty-two of these. Taking the last value would drop
  // every answer but one.
  assert.deepEqual(parseForm('a=1&a=2&b=3'), { a: ['1', '2'], b: '3' });
  assert.deepEqual(parseForm(''), {});
});

test('readCookie finds the session and ignores the rest', () => {
  assert.equal(readCookie('other=1; rr_session=abc; more=2'), 'abc');
  assert.equal(readCookie('other=1'), null);
  assert.equal(readCookie(undefined), null);
  assert.match(sessionCookie('abc', { secure: true }), /Secure/);
  assert.ok(!/Secure/.test(sessionCookie('abc', { secure: false })));
});

// ───────────────────────────────────────────── the service layer is the rules ──

test('no route handler takes an authorisation decision of its own', async () => {
  // Every authorisation bug in the previous implementation of this product was
  // in an HTTP handler, where no test below it could reach it. The handlers
  // here call the service layer and render what comes back.
  //
  // This was first written as a grep for `role ===`, which is the wrong test
  // twice over. It passed a handler that made a decision some other way, and it
  // failed a `<option selected>` comparison in a form — a word hunt that fires
  // on a legitimate line trains people to loosen the pattern until it fires on
  // nothing. So the check is structural: a handler may not call `authorise`,
  // and may not decide a 403 for itself. Both are things the service layer does
  // and only the service layer should.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../src/web/routes/', import.meta.url);

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    // Comments stripped first. These files explain at length why a route does
    // not do these things, and a check that fires on the explanation is a check
    // somebody will delete.
    const source = withoutComments(readFileSync(new URL(file, dir), 'utf8'));

    assert.ok(!/\bauthorise\s*\(/.test(source),
      `${file} calls authorise() — that decision belongs below the HTTP layer`);
    assert.ok(!/\bmembershipOf\s*\(/.test(source),
      `${file} resolves a membership itself rather than through the shell`);

    // A 403 in a route file would be a route deciding somebody may not do
    // something. The two legitimate 403s in this application are the CSRF
    // check and the cross-origin check, and both are in the server, not here.
    assert.ok(!/\b403\b/.test(source),
      `${file} decides a 403 — a refusal reaches a route already written`);
  }
});

test('a route that writes goes through a service function, never the database', async () => {
  // A handler that writes a row directly is a handler that skipped the rules:
  // no audit entry, no provenance, no supersession, no entitlement check.
  // Reading rows is allowed and is done in several places — a service layer
  // shaped for one screen is a service layer shaped wrong — so this checks for
  // writes only.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../src/web/routes/', import.meta.url);

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const source = withoutComments(readFileSync(new URL(file, dir), 'utf8'));
    for (const write of ['insert', 'update', 'remove']) {
      assert.ok(!new RegExp(`\\bdb\\.${write}\\s*\\(`).test(source),
        `${file} calls db.${write}() — writes go through a service function`);
    }
  }
});

test('a service refusal is shown as the service layer wrote it', async () => {
  const app = await serve();
  try {
    const { cookie } = await signedIn(app);
    const page = await (await get(app, '/', cookie)).text();
    await post(app, '/orgs', cookie, { name: 'Northwind', path: 'RAISE', csrf: csrfFrom(page) });
    const org = app.db.find('organisation', {})[0];

    const roomPage = await (await get(app, `/org/${org.id}/room`, cookie)).text();
    const item = app.db.find('data_room_item', { org_id: org.id })[0];

    const res = await post(app, `/org/${org.id}/room/${item.id}/na`, cookie,
      { reason: 'no', csrf: csrfFrom(roomPage) });
    const html = await res.text();

    // The service layer's own wording, not "Something went wrong." and not the
    // machine code either.
    assert.match(html, /missing with better manners/);
    // The code is still on the page, quietly, so somebody writing in for help
    // has a word to quote.
    assert.match(html, /<code>reason_required<\/code>/);
  } finally { await app.close(); }
});

test('every refusal the product can throw has a sentence a person can act on', async () => {
  // A page that says `invalid_prose_source` has told the reader nothing. The
  // service layer throws codes because an API client switches on them; this
  // layer is responsible for turning each one into a sentence, and a new code
  // added anywhere in the product fails here rather than reaching a page as an
  // identifier.
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const thrown = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.js')) continue;
      const source = readFileSync(full, 'utf8');
      for (const m of source.matchAll(/new AccessError\(\s*'([a-z_]+)'/g)) thrown.add(m[1]);
    }
  };
  walk(fileURLToPath(new URL('../src/', import.meta.url)));

  const missing = [...thrown].filter((code) => !REFUSAL_SENTENCES[code]).sort();
  assert.deepEqual(missing, [], `refusals with no wording: ${missing.join(', ')}`);

  // And the other direction, so the table does not accumulate wording for
  // refusals that no longer exist.
  const stale = Object.keys(REFUSAL_SENTENCES).filter((code) => !thrown.has(code)).sort();
  assert.deepEqual(stale, [], `wording for refusals nothing throws: ${stale.join(', ')}`);

  assert.ok(thrown.size > 30, `only found ${thrown.size} refusal codes, the scan is probably broken`);
});

test('a refusal sentence prefers what the rule author wrote', () => {
  assert.equal(sentenceFor({ code: 'reason_required', detail: 'Written at the throw site.' }),
    'Written at the throw site.');
  assert.equal(sentenceFor({ code: 'invalid_email' }), REFUSAL_SENTENCES.invalid_email);
  assert.match(sentenceFor({}), /was not recorded/);

  // A sign-in error carries its wording as the message, next to the security
  // reasoning that chose it.
  assert.equal(sentenceFor({ code: 'invalid_credentials', message: 'That does not match an account.' }),
    'That does not match an account.');
  // But a message that is really a code never reaches a page.
  assert.match(sentenceFor({ code: 'weird_new_code', message: 'weird_new_code' }), /was not recorded/);
  assert.match(sentenceFor({ message: 'some_identifier' }), /was not recorded/);
});

test('the sentence for a non-member says nothing about what exists', () => {
  // Everywhere else a specific sentence is the point. Here it would undo the
  // 404-not-403 rule by confirming the organisation is real.
  const says = REFUSAL_SENTENCES.not_found;
  assert.ok(!/organisation|permission|member|access|role/i.test(says), `not_found says too much: ${says}`);
});

// ───────────────────────────────────────────── the demonstration deployment ──

test('the demonstration refuses to run against a database with anything in it', async () => {
  // The one case this seeder exists to refuse. Invented figures and real ones in
  // the same data room cannot be told apart afterwards — including by the people
  // reading the documents it produces.
  const { seedDemonstration } = await import('../src/web/demo.js');
  const { memoryStorageDriver } = await import('../src/storage/local.js');

  const db = freshDb();
  const storage = memoryStorageDriver();
  const now = () => '2026-06-01T00:00:00.000Z';

  // An organisation already here, as a real deployment would have.
  const ctx = { db, now, auth: { userId: 'u1', email: 'u1@example.com' }, storage };
  svc.createOrganisation(ctx, { name: 'A Real Company', path: 'RAISE' });

  assert.throws(
    () => seedDemonstration({ db, storage, now }),
    (err) => err.code === 'demo_refused' && /already has an account or an organisation/.test(err.message),
  );
  assert.equal(db.find('user_account', {}).length, 0, 'an account was created anyway');
});

test('the demonstration refuses to run with no file storage', async () => {
  // The documents it generates are real files. Without somewhere to put them a
  // reviewer finds nine rows that will not open, which is a worse first
  // impression than a clear refusal at boot.
  const { seedDemonstration } = await import('../src/web/demo.js');
  assert.throws(
    () => seedDemonstration({ db: freshDb(), storage: null }),
    (err) => err.code === 'demo_refused' && /STORAGE_DIR/.test(err.message),
  );
});

test('the demonstration is refused outright in production', async () => {
  const { configure } = await import('../src/web/boot.js');
  const config = configure({
    NODE_ENV: 'production', DEMO_SEED: '1',
    DATABASE_FILE: '/tmp/x.db', STORAGE_DIR: '/tmp/objects',
    STORAGE_SECRET: '0123456789abcdef0123456789abcdef',
  });
  assert.ok(config.problems.some((p) => /DEMO_SEED/.test(p)),
    'a production deployment would have loaded the worked example');
});

test('the demonstration grants a subscription marked as a demonstration', async () => {
  // Not faked as a paying one. `billing.status` reports it, so no screen can
  // mistake the example for a customer.
  const { seedDemonstration } = await import('../src/web/demo.js');
  const { memoryStorageDriver } = await import('../src/storage/local.js');
  const billing = await import('../src/api/billing.js');

  const db = freshDb();
  const storage = memoryStorageDriver();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 5, 1, 0, 0, tick++)).toISOString();

  const summary = seedDemonstration({ db, storage, now });
  const ctx = {
    db, now, storage,
    auth: { userId: db.find('user_account', {})[0].id, email: summary.email },
  };

  const status = billing.status(ctx, summary.organisation.id).body;
  assert.equal(status.demonstration, true);
  assert.ok(status.plan.entitlements.length > 0, 'the example cannot show the whole product');

  // And it is a real walk-through: documents, prose, links, a question.
  assert.ok(summary.counts.generated >= 8, `only ${summary.counts.generated} documents`);
  assert.ok(summary.counts.prose >= 3, 'no written passages, so writing and languages are empty');
  assert.ok(summary.links.length >= 2, 'no counterparty link to follow');
  assert.ok(db.find('share_question', {}).length >= 2, 'no question in the log');
  assert.ok(db.find('artifact', {}).some((a) => a.released_at),
    'nothing marked as sent, so staleness has nothing to be serious about');
});

// ────────────────────────────────────────────────────────────────── /health ──

test('health reports what is working, and says nothing about the business', async () => {
  const app = await serve();
  try {
    const res = await get(app, '/health');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state, 'ok');
    assert.deepEqual(body.checks.map((c) => c.name), ['database', 'schema', 'storage']);
    assert.ok(body.checks.every((c) => c.ok));

    // Unauthenticated, so it must not be a business metrics endpoint with no
    // password on it. How many organisations a company has is not public.
    const text = JSON.stringify(body);
    assert.ok(!/\d{2,}/.test(text), `a number large enough to be a count leaked: ${text}`);
    for (const leak of ['version', 'host', 'path', 'database_file', 'secret']) {
      assert.ok(!text.toLowerCase().includes(leak), `health leaked "${leak}"`);
    }
  } finally { await app.close(); }
});

test('health answers without a session, because a balancer has no credentials', async () => {
  const app = await serve();
  try {
    // Not a redirect to /sign-in. The whole endpoint is useless if it needs
    // the thing it exists to tell you is broken.
    const res = await get(app, '/health');
    assert.equal(res.status, 200);
  } finally { await app.close(); }
});

test('no file storage is degraded, not unhealthy, because every export still works', async () => {
  const db = freshDb();
  const app = createApp({ db, secure: false, storage: null });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => { server.listen(0, r); });
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/health`);
    const body = await res.json();

    // Taking a mostly-working deployment out of service because uploads are off
    // is the wrong failure: the line is whether somebody can still get their own
    // data out, and they can.
    assert.equal(res.status, 200);
    assert.equal(body.state, 'degraded');
    assert.equal(body.checks.find((c) => c.name === 'storage').code, 'storage_unconfigured');
  } finally { await new Promise((r) => { server.close(r); }); }
});

test('a database that cannot be queried is unhealthy, and says where to look', async () => {
  const db = freshDb();
  // Not a missing connection object — a connection that exists and fails on use,
  // which is the state a pool hands out before it has tried anything.
  const broken = { ...db, ping: () => { throw new Error('connection refused to db-1.internal'); } };
  const app = createApp({ db: broken, secure: false, storage: fakeStorage() });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => { server.listen(0, r); });
  server.unref();

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.state, 'unhealthy');
    assert.equal(body.checks.find((c) => c.name === 'database').code, 'database_unreachable');

    // The thrown message named a host. A check with no password on it does not
    // repeat what it was told.
    assert.ok(!JSON.stringify(body).includes('db-1.internal'));
  } finally { await new Promise((r) => { server.close(r); }); }
});

// ───────────────────────────────────────────────────────── rate limiting ──

test('sign-in is limited per address, and the limit says nothing about any account', async () => {
  const app = await serve();
  try {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await post(app, '/sign-in', '', { email: `person${i}@example.com`, password: 'wrong wrong wrong' });
      if (last.status === 429) break;
    }

    assert.equal(last.status, 429, 'twenty-five attempts from one address were all served');
    assert.ok(Number(last.headers.get('retry-after')) > 0);

    const html = await last.text();
    assert.match(html, /Too many attempts from this network/);
    // The attack this stops is one or two attempts against each of ten thousand
    // addresses, which trips no single account's lock. So the message cannot be
    // about an account — "too many attempts for this account" would be a working
    // account enumerator.
    assert.ok(!/this account|that account|no account/i.test(html), html.slice(0, 400));
  } finally { await app.close(); }
});

test('a successful sign-in clears the count for that address', async () => {
  const app = await serve();
  try {
    await signedIn(app, { email: 'founder@example.com', password: 'a long enough passphrase' });

    // Spread across addresses, so no single account's own lock is involved.
    // These are two different guards against two different attacks, and a test
    // that trips both tells you nothing about either.
    for (let i = 0; i < 10; i++) {
      await post(app, '/sign-in', '', { email: `sprayed${i}@example.com`, password: 'not it' });
    }

    const ok = await post(app, '/sign-in', '', {
      email: 'founder@example.com', password: 'a long enough passphrase',
    });
    assert.equal(ok.status, 303, 'ten attempts from this network should not stop a real sign-in');

    // And the budget is back, so the next person on the same office connection
    // is not ten attempts from being shut out for the rest of the window.
    for (let i = 10; i < 20; i++) {
      const res = await post(app, '/sign-in', '', { email: `sprayed${i}@example.com`, password: 'not it' });
      assert.notEqual(res.status, 429, `shut out again after ${i - 9} attempts`);
    }
  } finally { await app.close(); }
});

test('sign-up is limited more tightly than sign-in', async () => {
  const app = await serve();
  try {
    let last;
    for (let i = 0; i < 15; i++) {
      last = await post(app, '/sign-up', '', {
        email: `new${i}@example.com`, password: 'a long enough passphrase', name: 'Someone',
      });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429, 'fifteen accounts were created from one address');
  } finally { await app.close(); }
});

test('a forwarded address is only believed behind a proxy, and only the last hop', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.4, 10.0.0.7' },
    socket: { remoteAddress: '10.0.0.1' },
  };

  // With nothing in front, the header came from the caller. Believing it would
  // let them choose their own bucket, which makes the limit decoration.
  assert.equal(addressFor(req), '10.0.0.1');
  assert.equal(addressFor(req, { trustProxy: false }), '10.0.0.1');

  // Behind a proxy, the only trustworthy entry is the LAST — the address the hop
  // you trust actually saw. The first entry is the one the client wrote, and
  // reading it is the classic version of this bug.
  assert.equal(addressFor(req, { trustProxy: true }), '10.0.0.7');

  assert.equal(addressFor({ headers: {}, socket: {} }), 'unknown');
});

test('the window slides, so a locked-out address recovers on its own', () => {
  let clock = 1_000_000;
  const throttle = createThrottle({ now: () => clock });

  for (let i = 0; i < LIMITS['sign-in'].attempts; i++) {
    assert.equal(throttle.check('sign-in', 'a').allowed, true);
  }
  const blocked = throttle.check('sign-in', 'a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);

  // Nothing sweeps and no timer runs: expired attempts are dropped when the key
  // is next read, so there is nothing to leak and nothing to stop.
  clock += LIMITS['sign-in'].windowMs + 1;
  assert.equal(throttle.check('sign-in', 'a').allowed, true);
});

test('one address being throttled does not throttle another', () => {
  const throttle = createThrottle();
  for (let i = 0; i < LIMITS['sign-in'].attempts; i++) throttle.check('sign-in', 'noisy');

  assert.equal(throttle.check('sign-in', 'noisy').allowed, false);
  assert.equal(throttle.check('sign-in', 'quiet').allowed, true);
  // And the buckets are per route: using up the sign-in budget does not use up
  // the sign-up one, which has a different limit for a different reason.
  assert.equal(throttle.check('sign-up', 'noisy').allowed, true);
});

test('a bucket nobody declared is a programming error, not a free pass', () => {
  const throttle = createThrottle();
  // The dangerous default would be to allow an unknown bucket, which means a
  // typo in a route silently removes its rate limit.
  assert.throws(() => throttle.check('sign-on', 'a'), /no rate limit defined/);
});

// ───────────────────────────────────────────────── uploading a document ──

/** A server with real signing storage, so a presigned PUT can actually be made. */
async function serveWithStorage() {
  const db = freshDb();
  const storage = memoryStorageDriver({ secret: 'a-signing-secret-long-enough' });
  const app = createApp({ db, secure: false, storage });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => { server.listen(0, r); });
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, storage, close: () => new Promise((r) => { server.close(r); }) };
}

test('a document is only recorded as uploaded once its bytes are actually stored', async () => {
  const app = await serveWithStorage();
  try {
    const { cookie } = await signedIn(app);
    const orgPage = await (await get(app, '/', cookie)).text();
    const csrf = csrfFrom(orgPage);
    await post(app, '/orgs', cookie, { name: 'Northwind', path: 'RAISE', csrf });
    const orgId = app.db.find('organisation', {})[0].id;

    const docsPage = await (await get(app, `/org/${orgId}/documents`, cookie)).text();
    const formCsrf = csrfFrom(docsPage);

    // ── step one: the ticket ────────────────────────────────────────────────
    const ticketRes = await fetch(`${app.base}/org/${orgId}/documents`, {
      method: 'POST', redirect: 'manual',
      headers: {
        cookie, Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: 'accounts-2026.pdf', size_bytes: '2048',
        mime_type: 'application/pdf', kind: 'ACCOUNTS', csrf: formCsrf,
      }),
    });
    assert.equal(ticketRes.status, 201);
    const ticket = await ticketRes.json();

    // A ticket is not an upload. This is the bug the three steps exist for: the
    // route used to confirm here, leaving a row that said a file had arrived
    // with nothing behind its key.
    let row = app.db.get('document', ticket.document.id);
    assert.equal(row.extract_state, 'AWAITING_UPLOAD');
    assert.equal(row.uploaded_at, null);

    // ── step two: the bytes, straight to storage ────────────────────────────
    const bytes = Buffer.alloc(2048, 7);
    // The presigned URL is relative when no BASE_URL is configured, which is
    // what a browser wants — it resolves against the page's own origin. `fetch`
    // in a test has no page to resolve against, so the origin is added here.
    const putUrl = ticket.upload.url.startsWith('http')
      ? ticket.upload.url : `${app.base}${ticket.upload.url}`;
    const put = await fetch(putUrl, {
      method: ticket.upload.method, headers: ticket.upload.headers, body: bytes,
    });
    assert.equal(put.status, 200);

    // ── step three: confirm ─────────────────────────────────────────────────
    const done = await fetch(`${app.base}${ticket.confirm_url}`, {
      method: 'POST', redirect: 'manual',
      headers: {
        cookie, Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: formCsrf }),
    });
    assert.equal(done.status, 200);

    row = app.db.get('document', ticket.document.id);
    assert.equal(row.extract_state, 'PENDING');
    assert.ok(row.uploaded_at);

    // And the bytes are where the row says they are, which is the thing that was
    // never true before.
    assert.equal(app.storage.get(row.storage_key).length, 2048);
  } finally { await app.close(); }
});

test('a document with no size is refused rather than registered at one byte', async () => {
  const app = await serveWithStorage();
  try {
    const { cookie } = await signedIn(app);
    const orgPage = await (await get(app, '/', cookie)).text();
    await post(app, '/orgs', cookie, { name: 'Northwind', path: 'RAISE', csrf: csrfFrom(orgPage) });
    const orgId = app.db.find('organisation', {})[0].id;
    const formCsrf = csrfFrom(await (await get(app, `/org/${orgId}/documents`, cookie)).text());

    // What a browser with JavaScript turned off sends: the file input's name and
    // no size. It used to default to one byte — a figure nobody supplied, stored
    // as fact, in a product whose whole argument is provenance.
    const res = await post(app, `/org/${orgId}/documents`, cookie, {
      filename: 'accounts-2026.pdf', kind: 'ACCOUNTS', csrf: formCsrf,
    });

    assert.equal(res.status, 400);
    assert.equal(app.db.find('document', { org_id: orgId }).length, 0);
  } finally { await app.close(); }
});

test('the upload form says what it needs, and the script is served as a file', async () => {
  const app = await serveWithStorage();
  try {
    const { cookie } = await signedIn(app);
    const orgPage = await (await get(app, '/', cookie)).text();
    await post(app, '/orgs', cookie, { name: 'Northwind', path: 'RAISE', csrf: csrfFrom(orgPage) });
    const orgId = app.db.find('organisation', {})[0].id;

    const html = await (await get(app, `/org/${orgId}/documents`, cookie)).text();
    assert.match(html, /data-upload/, 'the script finds its one form by a marker on the form');
    assert.match(html, /type="file"/);
    assert.match(html, /<noscript>/, 'a browser without script is told why this one thing needs it');
    assert.match(html, /<script src="\/assets\/upload\.js" defer><\/script>/);

    const script = await get(app, '/assets/upload.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    // Inline script is inert under this policy, which is the point of the
    // policy — so the behaviour has to come from a file.
    assert.match(script.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { await app.close(); }
});

test('connect-src is widened to exactly one storage origin, or not at all', () => {
  const policy = (opts) => securityHeaders(opts)['Content-Security-Policy'];

  // The local driver serves uploads from this application, so the narrow policy
  // is the correct one and is what every test here runs under.
  assert.match(policy({}), /connect-src 'self';/);

  assert.match(
    policy({ storageOrigin: 'https://bucket.example.com/some/path' }),
    /connect-src 'self' https:\/\/bucket\.example\.com;/,
    'only the origin, never the path it was configured with',
  );

  // A policy is one header built by concatenation, so a value with a space or a
  // semicolon in it does not widen a directive — it invents new ones. Dropping
  // it fails closed: the upload is blocked and the browser says which origin it
  // wanted.
  const hostile = policy({ storageOrigin: "https://bucket.example 'unsafe-inline'; script-src *" });
  const connectDirective = hostile.split('; ').find((d) => d.startsWith('connect-src'));
  assert.equal(connectDirective, "connect-src 'self'");
  // And it did not smuggle a second script-src past the one the policy sets.
  assert.equal(hostile.split('; ').filter((d) => d.startsWith('script-src')).length, 1, hostile);

  assert.match(policy({ storageOrigin: 'javascript:alert(1)' }), /connect-src 'self';/);
});
