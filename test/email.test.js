/**
 * Email, password reset, and invite delivery.
 *
 * Three things are tested here, and the first is the one that would be a
 * disclosure rather than a bug:
 *
 *   1. **The reset form reveals nothing.** The page, the status and the body are
 *      identical for an address with an account and an address without one. A
 *      test that only checks the happy path cannot see this, because the leak is
 *      in the difference between two paths rather than in either one of them.
 *
 *   2. **A reset link is single-use, short-lived and never stored.** The same
 *      three properties a share token has, proved the same way.
 *
 *   3. **The catalogue is the only place a message is composed.** A figure from
 *      a customer's accounts cannot reach a provider, because no builder
 *      accepts one — and no call site writes its own subject line.
 *
 * `fakeEmailer` is the reference a real adapter is held to: point an
 * implementation at this file and it has to behave the same way at the seam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { freshDb, ctxFor, fakeStorage, now } from './helpers.js';
import { createApp } from '../src/web/server.js';
import * as auth from '../src/web/auth.js';
import * as svc from '../src/api/service.js';
import { fakeEmailer } from '../src/email/fake.js';
import { assertEmailer, assertMessage, EmailProviderError } from '../src/email/interface.js';
import { MESSAGES, passwordReset, invitation } from '../src/email/messages.js';
import { resetDecision, resetExpiry, mintResetToken, hashToken, RESET_MINUTES } from '../src/web/security.js';
import { LIMITS } from '../src/web/throttle.js';

const BASE = 'https://raiseroom.app';

/** A live server, optionally with a provider wired in. */
async function serve({ emailer = null, baseUrl = BASE } = {}) {
  const db = freshDb();
  const app = createApp({ db, secure: false, storage: fakeStorage(), emailer, baseUrl });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((resolve) => { server.listen(0, resolve); });
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => { server.close(r); }) };
}

const post = (app, path, fields) =>
  fetch(`${app.base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

const get = (app, path) => fetch(`${app.base}${path}`, { redirect: 'manual' });

async function register(app, { email, password = 'a long enough passphrase' }) {
  await post(app, '/sign-up', { email, password, name: 'A Founder' });
}

/** The reset link the provider was handed, as a path. */
const linkFrom = (message) => message.text.match(/https?:\/\/\S+\/reset\/(\S+)/)?.[1] ?? null;

/**
 * Let the fire-and-forget send land.
 *
 * `requestPasswordReset` does not await the provider — see the long note in
 * `src/web/auth.js` — so a test that asserts on what was sent has to yield
 * once. That is the honest shape of what is being tested rather than a
 * workaround: the product really does answer before the provider has replied.
 */
const settled = () => new Promise((resolve) => { setImmediate(resolve); });

// ───────────────────────────────────────────────────────────── the contract ──

test('a provider must identify itself, because a stored answer names who sent it', () => {
  assert.throws(() => assertEmailer(null), /required/);
  assert.throws(() => assertEmailer({ version: '1', send() {} }), /must carry id/);
  assert.throws(() => assertEmailer({ id: 'x', send() {} }), /must carry version/);
  assert.throws(() => assertEmailer({ id: 'x', version: '1' }), /must implement send/);
  assert.ok(assertEmailer(fakeEmailer()));
});

test('a message with no plain-text body is refused, because some readers get only that', () => {
  assert.throws(() => assertMessage({ to: 'a@b.co', subject: 'Hi', html: '<p>Hi</p>' }),
    (err) => err.code === 'invalid_body');
});

test('a newline in a recipient or a subject is refused', () => {
  // Header injection: a newline turns the rest of a subject into a second
  // header, and `Bcc:` is the one that matters.
  assert.throws(() => assertMessage({ to: 'a@b.co', subject: 'Hi\nBcc: someone@else.co', text: 'x' }),
    (err) => err.code === 'header_injection');
  assert.throws(() => assertMessage({ to: 'a@b.co\nBcc: someone@else.co', subject: 'Hi', text: 'x' }),
    (err) => err.code === 'header_injection' || err.code === 'invalid_recipient');
});

test('an undeliverable address is refused before a provider is called', () => {
  assert.throws(() => assertMessage({ to: 'not-an-address', subject: 'Hi', text: 'x' }),
    (err) => err.code === 'invalid_recipient');
});

// ────────────────────────────────────────────────────────────── the catalogue ──

test('the catalogue names exactly the builders that exist', () => {
  // A message added without being listed, or listed without existing, fails
  // here rather than at the moment somebody needs it.
  assert.deepEqual(Object.keys(MESSAGES).sort(), ['invite', 'password-reset']);
  for (const [name, builder] of Object.entries(MESSAGES)) {
    assert.equal(typeof builder, 'function', `${name} is not a builder`);
  }
});

test('every link in a message is absolute, because a relative one is dead in an inbox', () => {
  const reset = passwordReset({ to: 'a@b.co', baseUrl: BASE, token: 'TOK', minutes: 60 });
  assert.ok(reset.text.includes(`${BASE}/reset/TOK`));
  assert.ok(!/href="\//.test(reset.html), 'the HTML carried a root-relative link');

  // And a builder refuses to run without BASE_URL rather than emitting `/reset/…`
  // and letting somebody discover it from a support message.
  assert.throws(() => passwordReset({ to: 'a@b.co', baseUrl: '', token: 'TOK', minutes: 60 }),
    (err) => err.code === 'no_base_url');
  assert.throws(() => invitation({ to: 'a@b.co', baseUrl: '', organisation: 'Northwind' }),
    (err) => err.code === 'no_base_url');
});

test('a reset message says nothing about which organisations the address belongs to', () => {
  const message = passwordReset({ to: 'a@b.co', baseUrl: BASE, token: 'TOK', minutes: 60 });
  const body = `${message.subject}\n${message.text}\n${message.html}`;
  // The request form reveals nothing either way; an email that named the
  // company would undo that for anybody reading a screen over a shoulder.
  assert.ok(!/Northwind|organisation:|belongs to/i.test(body));
  assert.equal(message.tag, 'password-reset');
});

test('an invitation with no organisation name is refused, because it reads as phishing', () => {
  assert.throws(() => invitation({ to: 'a@b.co', baseUrl: BASE, organisation: '  ' }),
    (err) => err.code === 'invalid_invitation');
});

test('no message carries a figure, and no builder will accept one', () => {
  // The rule is kept by construction: a builder takes named inputs and there is
  // no `data` argument, no spread and no template lookup by string. So the test
  // that matters is that an attempt to smuggle one through is simply ignored.
  const message = invitation({
    to: 'a@b.co', baseUrl: BASE, organisation: 'Northwind Systems', invitedBy: 'A Founder',
    // Not a parameter of anything.
    facts: [{ key: 'revenue', value: 4_200_000 }],
  });
  const body = `${message.subject}\n${message.text}\n${message.html}`;
  assert.ok(!body.includes('4200000') && !body.includes('4,200,000'));

  // And the only digits in a reset message are the ones the product put there:
  // the expiry, in minutes.
  const reset = passwordReset({ to: 'a@b.co', baseUrl: BASE, token: 'TOK', minutes: 60 });
  const digits = [...reset.text.matchAll(/\d+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(digits)], ['60']);
});

test('no message is composed at a call site — every send is handed a catalogue message', () => {
  // The whole reason the catalogue exists. A handler that composes its own
  // message is a handler that can put a customer's revenue in a subject line,
  // and nothing else in the suite would notice.
  //
  // The rule is checked at the call rather than by looking for the word
  // `subject`, which means something else entirely in `sharing.js` — a share's
  // subject is the thing being shared, a room or a document. What matters is
  // that nothing hands `send()` an object it built itself.
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.js')) continue;
      // The catalogue and the contract are where a message is allowed to be a
      // literal: one builds them, the other documents the shape.
      if (full.includes(join('src', 'email'))) continue;
      const source = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\.send\(\s*\{/.test(source)) offenders.push(entry);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [],
    `these build a message at the call site instead of using src/email/messages.js: ${offenders.join(', ')}`);
});

// ──────────────────────────────────────────────────────────── the token rule ──

test('a reset token is stored hashed, exactly as a share token is', () => {
  const { token, token_hash } = mintResetToken();
  assert.notEqual(token, token_hash);
  assert.equal(token_hash, hashToken(token));
  assert.ok(token.length >= 32, 'the token is short enough to be worth guessing');
});

test('a reset link is unknown, used or expired — and used is not disguised as unknown', () => {
  const at = '2026-10-15T12:00:00.000Z';
  assert.equal(resetDecision(null, at).code, 'reset_unknown');
  assert.equal(resetDecision({ used_at: at, expires_at: '2099-01-01T00:00:00.000Z' }, at).code, 'reset_used');
  assert.equal(resetDecision({ used_at: null, expires_at: '2020-01-01T00:00:00.000Z' }, at).code, 'reset_expired');
  assert.equal(resetDecision({ used_at: null, expires_at: '2099-01-01T00:00:00.000Z' }, at).usable, true);

  // Used is checked before expired: a link that was used and has since expired
  // was used, and that is the more useful true thing to say.
  assert.equal(resetDecision({ used_at: at, expires_at: '2020-01-01T00:00:00.000Z' }, at).code, 'reset_used');
});

test('a reset link expires, and the window is the one the email promises', () => {
  const at = '2026-10-15T12:00:00.000Z';
  const expires = resetExpiry(at);
  const minutes = (new Date(expires).getTime() - new Date(at).getTime()) / 60_000;
  assert.equal(minutes, RESET_MINUTES);
  // The message states the same number. A link that outlives its sentence, or
  // dies before it, is a support ticket either way.
  assert.ok(passwordReset({ to: 'a@b.co', baseUrl: BASE, token: 'T', minutes: RESET_MINUTES })
    .text.includes(`${RESET_MINUTES} minutes`));
});

// ────────────────────────────────────────────── the form that reveals nothing ──

test('the reset form answers identically for an address with an account and one without', async () => {
  const emailer = fakeEmailer();
  const app = await serve({ emailer });
  try {
    await register(app, { email: 'real@example.com' });

    const real = await post(app, '/forgot', { email: 'real@example.com' });
    const realBody = await real.text();
    const absent = await post(app, '/forgot', { email: 'nobody@example.com' });
    const absentBody = await absent.text();

    assert.equal(real.status, absent.status, 'the status differed by whether the address exists');
    assert.equal(realBody, absentBody, 'the page differed by whether the address exists');

    // And underneath, exactly one message was sent — to the address that exists.
    assert.equal(emailer.sent().length, 1);
    assert.equal(emailer.last().to, 'real@example.com');
  } finally { await app.close(); }
});

test('a provider outage does not change what the reset form says', async () => {
  // The sharp edge. A 502 here would fire only for addresses that have an
  // account, because only those cause a send — so the error page itself becomes
  // the account enumerator the wording was protecting against.
  const app = await serve({ emailer: fakeEmailer({ fails: true }) });
  try {
    await register(app, { email: 'real@example.com' });
    const res = await post(app, '/forgot', { email: 'real@example.com' });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes('on its way'));
    assert.ok(!/error|failed|unavailable/i.test(body.replace(/<[^>]*>/g, '')));
  } finally { await app.close(); }
});

test('with no provider configured the reset page says so instead of accepting a request', async () => {
  // Rule 12. Somebody told "a link is on its way" by a deployment that cannot
  // send mail waits for ever, and concludes the product is broken.
  const app = await serve({ emailer: null });
  try {
    const page = await (await get(app, '/forgot')).text();
    assert.ok(page.includes('cannot send email'));
    assert.ok(!page.includes('name="email"'), 'a form was offered that cannot do anything');

    const res = await post(app, '/forgot', { email: 'real@example.com' });
    assert.equal(res.status, 503);
  } finally { await app.close(); }
});

test('no reset row is written when there is no way to deliver the link', async () => {
  const db = freshDb();
  const ctx = { ...ctxFor(db, 'u1'), emailer: null, baseUrl: BASE };
  auth.register(ctx, { email: 'real@example.com', password: 'a long enough passphrase' });
  auth.requestPasswordReset(ctx, { email: 'real@example.com' });
  assert.equal(db.count('password_reset'), 0, 'a token was minted that nobody can ever receive');
});

test('the request route is rate limited, and the limit is declared', async () => {
  // `createThrottle` throws on an undeclared bucket — a bucket nobody declared
  // is a programming error, not a free pass — so the limit existing is itself
  // part of the route working.
  assert.ok(LIMITS['password-reset'], 'no limit is declared for password resets');

  const app = await serve({ emailer: fakeEmailer() });
  try {
    const limit = LIMITS['password-reset'].attempts;
    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await post(app, '/forgot', { email: `person${i}@example.com` });
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'), 'no Retry-After on a 429');
    const body = await last.text();
    // The 429 is another easy place to undo the whole design by accident. The
    // shared wording does say "Nothing is wrong with the account" — which is
    // about no particular account and is the point. What would leak is saying
    // something about THE address that was typed.
    const text = body.replace(/<[^>]*>/g, '');
    assert.ok(!/that address|has an account|no account|not registered|unknown address/i.test(text),
      'the rate-limit page said something about the address that was typed');
  } finally { await app.close(); }
});

// ──────────────────────────────────────────────────────── the flow end to end ──

test('a reset link sets a new password, once', async () => {
  const emailer = fakeEmailer();
  const app = await serve({ emailer });
  try {
    await register(app, { email: 'real@example.com', password: 'the original passphrase' });
    await post(app, '/forgot', { email: 'real@example.com' });

    const link = linkFrom(emailer.last());
    assert.ok(link, 'no reset link reached the provider');

    // The GET does not spend it — a mail client that prefetches links would
    // otherwise burn every link before its owner clicked one.
    assert.equal((await get(app, `/reset/${link}`)).status, 200);
    assert.equal((await get(app, `/reset/${link}`)).status, 200);

    const done = await post(app, `/reset/${link}`, { password: 'a brand new passphrase' });
    assert.equal(done.status, 303);
    assert.match(done.headers.get('location'), /^\/sign-in/);

    // Signing in with the new password works, and with the old one does not.
    const fresh = await post(app, '/sign-in', { email: 'real@example.com', password: 'a brand new passphrase' });
    assert.equal(fresh.status, 303);
    const stale = await post(app, '/sign-in', { email: 'real@example.com', password: 'the original passphrase' });
    assert.equal(stale.status, 401);

    // And the link is spent.
    const again = await post(app, `/reset/${link}`, { password: 'yet another passphrase' });
    assert.equal(again.status, 400);
    assert.ok((await again.text()).includes('already been used'));
  } finally { await app.close(); }
});

test('a reset is not signed in automatically, because every session was just ended', async () => {
  const emailer = fakeEmailer();
  const app = await serve({ emailer });
  try {
    await register(app, { email: 'real@example.com' });
    await post(app, '/forgot', { email: 'real@example.com' });
    const done = await post(app, `/reset/${linkFrom(emailer.last())}`, { password: 'a brand new passphrase' });
    // Signing somebody in off the back of a link in an inbox is the thing the
    // sessions were ended to prevent.
    assert.match(done.headers.get('set-cookie') ?? '', /rr_session=;|Max-Age=0/);
  } finally { await app.close(); }
});

test('a reset ends every other session', async () => {
  const db = freshDb();
  const emailer = fakeEmailer();
  const ctx = { ...ctxFor(db, 'u1'), emailer, baseUrl: BASE };
  auth.register(ctx, { email: 'real@example.com', password: 'the original passphrase' });
  const user = db.findOne('user_account', { email_lower: 'real@example.com' });

  auth.openSession(ctx, user.id);
  auth.openSession(ctx, user.id);
  assert.equal(db.find('web_session', { user_id: user.id }).length, 2);

  auth.requestPasswordReset(ctx, { email: 'real@example.com' });
  await settled();
  const token = linkFrom(emailer.last());
  const result = auth.completePasswordReset(ctx, { token, password: 'a brand new passphrase' });

  assert.equal(result.body.sessions_ended, 2);
  assert.equal(db.find('web_session', { user_id: user.id }).length, 0);
});

test('a password the rules refuse leaves the link alive', async () => {
  // The commonest thing that happens on this form. Burning the link for it
  // sends somebody back to their inbox for a second link to fail with.
  const emailer = fakeEmailer();
  const app = await serve({ emailer });
  try {
    await register(app, { email: 'real@example.com' });
    await post(app, '/forgot', { email: 'real@example.com' });
    const link = linkFrom(emailer.last());

    const refused = await post(app, `/reset/${link}`, { password: 'short' });
    assert.equal(refused.status, 400);
    assert.ok((await refused.text()).includes('name="password"'), 'the form was not offered again');

    const done = await post(app, `/reset/${link}`, { password: 'a brand new passphrase' });
    assert.equal(done.status, 303);
  } finally { await app.close(); }
});

test('asking twice leaves one working link, and the older one reads as unknown', async () => {
  const emailer = fakeEmailer();
  const app = await serve({ emailer });
  try {
    await register(app, { email: 'real@example.com' });
    await post(app, '/forgot', { email: 'real@example.com' });
    const first = linkFrom(emailer.last());
    await post(app, '/forgot', { email: 'real@example.com' });
    const second = linkFrom(emailer.last());
    assert.notEqual(first, second);

    // The superseded row is deleted rather than marked used: it never was used,
    // and saying it had been would be false. Deleted, it says nothing.
    const stale = await get(app, `/reset/${first}`);
    assert.equal(stale.status, 400);
    assert.ok((await stale.text()).includes('not valid'));
    assert.equal((await get(app, `/reset/${second}`)).status, 200);
  } finally { await app.close(); }
});

test('an expired link is refused', async () => {
  const db = freshDb();
  const emailer = fakeEmailer();
  const ctx = { ...ctxFor(db, 'u1'), emailer, baseUrl: BASE };
  auth.register(ctx, { email: 'real@example.com', password: 'the original passphrase' });
  auth.requestPasswordReset(ctx, { email: 'real@example.com' });
  await settled();
  const token = linkFrom(emailer.last());

  // Age the row rather than the clock, so the test says what it means.
  const row = db.find('password_reset', {})[0];
  db.update('password_reset', row.id, { expires_at: '2020-01-01T00:00:00.000Z' });

  assert.throws(() => auth.completePasswordReset(ctx, { token, password: 'a brand new passphrase' }),
    (err) => err.code === 'reset_expired');
});

test('a reset clears a lockout, because the holder of the address proved more than a password would', async () => {
  const db = freshDb();
  const emailer = fakeEmailer();
  const ctx = { ...ctxFor(db, 'u1'), emailer, baseUrl: BASE };
  auth.register(ctx, { email: 'real@example.com', password: 'the original passphrase' });
  const user = db.findOne('user_account', { email_lower: 'real@example.com' });
  db.update('user_account', user.id, { failed_logins: 8, locked_until: '2099-01-01T00:00:00.000Z' });

  auth.requestPasswordReset(ctx, { email: 'real@example.com' });
  await settled();
  auth.completePasswordReset(ctx, { token: linkFrom(emailer.last()), password: 'a brand new passphrase' });

  const after = db.get('user_account', user.id);
  assert.equal(after.failed_logins, 0);
  assert.equal(after.locked_until, null);
  // And signing in actually works, rather than meeting a wait nobody can explain.
  assert.ok(auth.signIn(ctx, { email: 'real@example.com', password: 'a brand new passphrase' }).body.session);
});

test('the reset table holds no address and no user agent', () => {
  // The product records neither anywhere else, and a security-shaped table is
  // exactly where that rule gets quietly broken.
  const db = freshDb();
  const columns = db.raw.prepare("SELECT name FROM pragma_table_info('password_reset')").all()
    .map((r) => r.name);
  assert.deepEqual(columns.sort(), ['created_at', 'expires_at', 'id', 'token_hash', 'used_at', 'user_id']);
});

// ─────────────────────────────────────────────────────────── invite delivery ──

test('an invitation is delivered, and names the organisation so it does not read as phishing', async () => {
  const db = freshDb();
  const emailer = fakeEmailer();
  const ctx = { ...ctxFor(db, 'u1'), emailer, baseUrl: BASE };
  db.insert('user_account', {
    id: 'u1', email: 'founder@example.com', email_lower: 'founder@example.com', name: 'A Founder',
    password_hash: 'x', failed_logins: 0, locked_until: null, last_login_at: null, created_at: now(),
  });
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;

  svc.createInvite(ctx, org.id, { email: 'colleague@example.com', role: 'EDITOR' });
  await settled();

  const message = emailer.last();
  assert.equal(message.to, 'colleague@example.com');
  assert.equal(message.tag, 'invite');
  assert.ok(message.subject.includes('Northwind Systems'));
  assert.ok(message.text.includes('A Founder'));
  // It carries the organisation's name and nothing else of the company's. Tested
  // by looking for VALUES rather than for words: the body explains what the
  // product is for, and that sentence contains "figures" quite legitimately.
  // What must never appear is a number out of somebody's accounts.
  assert.ok(!/\d/.test(message.text.replace(/https?:\/\/\S+/g, '')),
    'a digit reached an invitation outside its link');
});

test('an invite still works when there is no provider, and when the provider refuses', () => {
  // The invite is the row, not the email: it is claimable by whoever next signs
  // up with that address, which is how it worked before this product could send
  // mail at all. A provider outage must not discard a perfectly good row.
  for (const emailer of [null, fakeEmailer({ fails: true })]) {
    const db = freshDb();
    const ctx = { ...ctxFor(db, 'u1'), emailer, baseUrl: BASE };
    db.insert('user_account', {
      id: 'u1', email: 'founder@example.com', email_lower: 'founder@example.com', name: 'A Founder',
      password_hash: 'x', failed_logins: 0, locked_until: null, last_login_at: null, created_at: now(),
    });
    const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;

    const result = svc.createInvite(ctx, org.id, { email: 'colleague@example.com', role: 'EDITOR' });
    assert.equal(result.status, 201);
    assert.equal(db.count('invite', { org_id: org.id }), 1);
  }
});

test('an invitation is composable without BASE_URL failing the invite', () => {
  // A deployment fault is not a reason to refuse somebody's invitation.
  const db = freshDb();
  const ctx = { ...ctxFor(db, 'u1'), emailer: fakeEmailer(), baseUrl: '' };
  db.insert('user_account', {
    id: 'u1', email: 'founder@example.com', email_lower: 'founder@example.com', name: 'A Founder',
    password_hash: 'x', failed_logins: 0, locked_until: null, last_login_at: null, created_at: now(),
  });
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  assert.equal(svc.createInvite(ctx, org.id, { email: 'c@example.com', role: 'VIEWER' }).status, 201);
});

// ───────────────────────────────────────────────────────────────── the fake ──

test('the fake records what it was asked to send, and can be made to fail', async () => {
  const emailer = fakeEmailer();
  await emailer.send({ to: 'a@b.co', subject: 'One', text: 'x', tag: 'invite' });
  await emailer.send({ to: 'c@d.co', subject: 'Two', text: 'y', tag: 'password-reset' });
  assert.equal(emailer.sent().length, 2);
  assert.equal(emailer.tagged('invite').length, 1);
  assert.equal(emailer.last().subject, 'Two');

  await assert.rejects(() => fakeEmailer({ fails: true }).send({ to: 'a@b.co', subject: 'x', text: 'y' }),
    (err) => err instanceof EmailProviderError && err.code === 'provider_unavailable');

  await assert.rejects(() => fakeEmailer({ rejects: 'blocked' }).send({ to: 'blocked@b.co', subject: 'x', text: 'y' }),
    (err) => err.code === 'undeliverable');
});
