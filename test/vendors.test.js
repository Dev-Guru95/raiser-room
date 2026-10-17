/**
 * The three vendor adapters.
 *
 * None of these is tested against a vendor. They are tested against the
 * contracts in `src/billing/interface.js`, `src/advisor/interface.js` and
 * `src/translate/interface.js`, with the HTTP call injected — which is the only
 * honest thing a test suite can do about a third party, and is also the part
 * that actually goes wrong: the shape of the request, the signature scheme, the
 * mapping, and what is NOT sent.
 *
 * What still has to be done against the real vendor, and cannot be done here,
 * is listed in `CHECKLIST.md` Part 4: create the plans, send one real webhook,
 * ask one real question.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { freshDb, ctxFor, fakeStorage } from './helpers.js';
import { createApp } from '../src/web/server.js';
import { ROUTES } from '../src/web/routes/index.js';
import { assertProvider } from '../src/billing/interface.js';
import { assertAdvisor } from '../src/advisor/interface.js';
import { whopProvider, KEY_DERIVATIONS, TIMESTAMP_TOLERANCE_SECONDS } from '../src/billing/whop.js';
import { anthropicAdvisor, anthropicTranslator, buildPrompt } from '../src/advisor/anthropic.js';

const SECRET = 'ws_FAKEsecretFORtestsONLY';
const KEY = 'test-api-key';

/** A fetch that records what it was asked and answers what a test chose. */
function recordingFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? responses.slice() : [responses];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next();
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    };
  };
  impl.calls = calls;
  return impl;
}

/** A webhook signed the way the provider signs one. */
function signed(payload, { secret = SECRET, id = 'msg_1', at = null, keyFrom = 'literal' } = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(at ?? Math.floor(Date.now() / 1000));
  const key = KEY_DERIVATIONS[keyFrom](secret);
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  return {
    rawBody,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
  };
}

const provider = (over = {}) => whopProvider({
  apiKey: KEY, webhookSecret: SECRET, plans: { RAISEROOM: 'plan_rr', FIRM: 'plan_firm' }, ...over,
});

// ────────────────────────────────────────────────────────── the billing seam ──

test('the adapter satisfies the contract the service layer asserts', () => {
  // The same check `api/billing.js` runs before it believes anything.
  assert.ok(assertProvider(provider()));
});

test('half a configuration is refused rather than half working', () => {
  assert.throws(() => whopProvider({ webhookSecret: SECRET }), (e) => e.code === 'no_api_key');
  assert.throws(() => whopProvider({ apiKey: KEY }), (e) => e.code === 'no_webhook_secret');
  assert.throws(() => whopProvider({ apiKey: KEY, webhookSecret: SECRET, keyFrom: 'guess' }),
    (e) => e.code === 'unknown_key_derivation');
});

test('a correctly signed webhook verifies', () => {
  const p = provider();
  const { rawBody, headers } = signed({ action: 'membership.activated' });
  const result = p.verify({ rawBody, headers });
  assert.equal(result.ok, true, result.why);
  // The id the caller deduplicates on is the one a retry reuses.
  assert.equal(result.event.id, 'msg_1');
});

test('the signature covers the id and the timestamp, not just the body', () => {
  // The mistake this catches: signing the raw body alone, which is the common
  // scheme and not this provider's. It verifies nothing and fails closed.
  const p = provider();
  const { rawBody, headers } = signed({ action: 'membership.activated' });
  const bodyOnly = createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('base64');
  assert.equal(p.verify({ rawBody, headers: { ...headers, 'webhook-signature': `v1,${bodyOnly}` } }).ok, false);

  // And a replayed signature does not transfer to another id or time.
  assert.equal(p.verify({ rawBody, headers: { ...headers, 'webhook-id': 'msg_2' } }).ok, false);
});

test('a tampered body fails, which is the whole point', () => {
  const p = provider();
  const { headers } = signed({ action: 'membership.activated', plan: 'plan_rr' });
  assert.equal(p.verify({ rawBody: JSON.stringify({ action: 'membership.activated', plan: 'plan_firm' }), headers }).ok, false);
});

test('a webhook older than the window is refused before any cryptography', () => {
  // A signature that is valid for ever is a request anybody who ever saw it can
  // send again.
  const p = provider();
  const stale = Math.floor(Date.now() / 1000) - (TIMESTAMP_TOLERANCE_SECONDS + 60);
  const { rawBody, headers } = signed({ action: 'membership.activated' }, { at: stale });
  const result = p.verify({ rawBody, headers });
  assert.equal(result.ok, false);
  assert.match(result.why, /window/);
});

test('a missing header is a refusal with a reason, not a crash', () => {
  const p = provider();
  const { rawBody, headers } = signed({ action: 'x' });
  for (const drop of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const partial = { ...headers };
    delete partial[drop];
    const result = p.verify({ rawBody, headers: partial });
    assert.equal(result.ok, false);
    assert.match(result.why, new RegExp(drop));
  }
  assert.equal(p.verify({ rawBody, headers, secret: '' }).ok, false);
});

test('headers are read whatever their case', () => {
  // Node lower-cases them; another transport may not, and a verifier that
  // assumes it rejects everything.
  const p = provider();
  const { rawBody, headers } = signed({ action: 'x' });
  const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
  assert.equal(p.verify({ rawBody, headers: upper }).ok, true);
});

test('either key derivation can be selected, and only the right one verifies', () => {
  // The one unconfirmed detail in the adapter, made a named choice rather than
  // a buried assumption. Send one real webhook; if it fails, switch.
  const literal = provider({ keyFrom: 'literal' });
  const standard = provider({ keyFrom: 'standard' });
  const asLiteral = signed({ a: 1 }, { keyFrom: 'literal' });
  const asStandard = signed({ a: 1 }, { keyFrom: 'standard' });

  assert.equal(literal.verify(asLiteral).ok, true);
  assert.equal(standard.verify(asStandard).ok, true);
  assert.equal(literal.verify(asStandard).ok, false);
  assert.equal(standard.verify(asLiteral).ok, false);
});

test('checkout maps the product plan key to the provider plan, and sends no name', () => {
  const p = provider();
  const url = p.checkoutUrl({ planKey: 'RAISEROOM', term: 'ANNUAL', orgId: 'org-123' });
  assert.ok(url.includes('plan_rr'));
  assert.ok(url.includes('org-123'));
  // No price, no company name, nothing about the organisation but an opaque id.
  assert.ok(!/northwind|revenue|\$|usd/i.test(url));
});

test('an unmapped plan is refused rather than sending somebody to a broken checkout', () => {
  const p = provider();
  assert.throws(() => p.checkoutUrl({ planKey: 'FREE' }), (e) => e.code === 'unmapped_plan');
  assert.equal(p.planRefFor('FIRM'), 'plan_firm');
  assert.equal(p.planRefFor('FREE'), null);
});

test('with nothing to link to, the portal is null rather than a dead link', () => {
  assert.equal(provider().portalUrl({}), null);
  assert.ok(provider().portalUrl({ providerRef: 'mem_1' }).includes('mem_1'));
});

test('a subscription is reshaped into the contract fields', async () => {
  const fetchImpl = recordingFetch({
    body: { data: { id: 'mem_1', plan_id: 'plan_rr', status: 'active', billing_period: 'ANNUAL', renewal_period_end: '2027-01-01', quantity: 10 } },
  });
  const sub = await provider({ fetchImpl }).fetchSubscription('mem_1');
  assert.deepEqual(sub, {
    provider_ref: 'mem_1', plan_ref: 'plan_rr', state: 'active',
    term: 'ANNUAL', current_period_end: '2027-01-01', seats: 10,
  });
  // The key goes in a header, never in a query string where it would be logged.
  assert.match(fetchImpl.calls[0].options.headers.Authorization, /^Bearer /);
  assert.ok(!fetchImpl.calls[0].url.includes(KEY));
});

test('a credit carries an idempotency key, and is refused without one', async () => {
  const fetchImpl = recordingFetch({ body: { data: { id: 'credit_1' } } });
  const p = provider({ fetchImpl });

  await assert.rejects(() => p.applyCredit({ providerRef: 'mem_1', amountMinor: 14700, currency: 'USD' }),
    (e) => e.code === 'no_idempotency_key');
  await assert.rejects(() => p.applyCredit({ providerRef: 'mem_1', amountMinor: 0, idempotencyKey: 'k' }),
    (e) => e.code === 'invalid_credit_amount');

  await p.applyCredit({ providerRef: 'mem_1', amountMinor: 14700, currency: 'usd', reason: 'workbook', idempotencyKey: 'k1' });
  const call = fetchImpl.calls.at(-1);
  assert.equal(call.options.headers['Idempotency-Key'], 'k1');
  assert.equal(JSON.parse(call.options.body).currency, 'USD');
});

test('a provider that is down is a provider error, not a billing decision', async () => {
  const down = recordingFetch(() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
  await assert.rejects(() => provider({ fetchImpl: down }).fetchSubscription('mem_1'),
    (e) => e.code === 'provider_unreachable');

  const refused = recordingFetch({ ok: false, status: 500, body: 'nope' });
  await assert.rejects(() => provider({ fetchImpl: refused }).fetchSubscription('mem_1'),
    (e) => e.code === 'provider_refused');
});

// ───────────────────────────────────────────────────────── the webhook route ──

test('the webhook endpoint exists, is public, and is the only raw-body route', () => {
  // It did not exist before: `handleWebhook` was written and tested, and
  // nothing in src/web/ called it, so there was no URL to give a provider.
  const route = ROUTES.find((r) => r.path === '/webhooks/billing' && r.method === 'POST');
  assert.ok(route, 'no billing webhook endpoint');
  assert.equal(route.auth, false);
  assert.equal(route.raw, true);

  // `raw: true` skips the origin check, so it is not a general escape hatch.
  const raw = ROUTES.filter((r) => r.raw).map((r) => r.path);
  assert.deepEqual(raw, ['/webhooks/billing']);
});

async function serveApp({ payments = null } = {}) {
  const db = freshDb();
  const app = createApp({ db, secure: false, storage: fakeStorage(), payments });
  const server = httpServer((req, res) => { app(req, res); });
  await new Promise((resolve) => { server.listen(0, resolve); });
  server.unref();
  return {
    db,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(r); }),
  };
}

const postRaw = (app, path, rawBody, headers = {}) => fetch(`${app.base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: rawBody,
});

test('an unverified webhook is refused with a 401 and recorded', async () => {
  const app = await serveApp({ payments: provider() });
  try {
    const { rawBody, headers } = signed({ action: 'membership.activated' });
    const res = await postRaw(app, '/webhooks/billing', rawBody, {
      ...headers, 'webhook-signature': 'v1,not-the-signature',
    });
    assert.equal(res.status, 401);
    // Recorded rather than dropped: a run of these is an attack or a rotated
    // secret, and both have to be visible.
    const events = app.db.find('billing_event', {});
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'VERIFICATION_FAILED');
  } finally { await app.close(); }
});

test('the endpoint receives the body as it was sent, byte for byte', async () => {
  // The reason `raw: true` had to be added: a form-parsed body re-serialises to
  // different bytes and the signature never matches.
  const app = await serveApp({ payments: provider() });
  try {
    const { rawBody, headers } = signed({ action: 'membership.activated', nested: { a: [1, 2] } });
    const res = await postRaw(app, '/webhooks/billing', rawBody, headers);
    // Verified — so the bytes survived the trip. What the product then does
    // with an event for an unknown subscription is its own business.
    assert.notEqual(res.status, 401);
    assert.equal(app.db.find('billing_event', {}).filter((e) => e.event_type === 'VERIFICATION_FAILED').length, 0);
  } finally { await app.close(); }
});

test('with no provider configured the endpoint says so rather than accepting anything', async () => {
  const app = await serveApp({ payments: null });
  try {
    const res = await postRaw(app, '/webhooks/billing', '{}');
    assert.equal(res.status, 503);
    assert.equal(app.db.count('billing_event'), 0, 'something was recorded with nothing to verify against');
  } finally { await app.close(); }
});

// ───────────────────────────────────────────────────────────── the model seam ──

test('the advisor satisfies the contract, and half a configuration is refused', () => {
  assert.ok(assertAdvisor(anthropicAdvisor({ apiKey: KEY })));
  assert.throws(() => anthropicAdvisor({}), (e) => e.code === 'no_api_key');
  assert.throws(() => anthropicTranslator({}), (e) => e.code === 'no_api_key');
});

test('the prompt carries the question and the passages, and nothing of the company', () => {
  // The published commitment: a model provider receives only the question text
  // and the corpus passages. This is the test that holds the adapter to it.
  const { system, user } = buildPrompt({
    question: 'What does a data room usually contain at this stage?',
    passages: [{ id: 'knowledge:dataroom-1', text: 'A data room is organised by section.' }],
  });
  const wire = `${system}\n${user}`;

  assert.ok(wire.includes('What does a data room usually contain'));
  assert.ok(wire.includes('knowledge:dataroom-1'));
  assert.ok(wire.includes('A data room is organised by section.'));

  // Nothing that would only come from an organisation's own records.
  for (const leak of ['Northwind', '420000', '$420,000', 'management-accounts', 'Vantage Partners']) {
    assert.ok(!wire.includes(leak), `the prompt carried ${leak}`);
  }
});

test('a model answer is shaped into what the validator reads', async () => {
  const fetchImpl = recordingFetch({
    body: { content: [{ type: 'text', text: JSON.stringify({ sections: [{ heading: 'Scope', claims: [{ text: 'A data room is organised by section.', cites: ['knowledge:dataroom-1'] }] }] }) }] },
  });
  const advisor = anthropicAdvisor({ apiKey: KEY, fetchImpl });
  const answer = await advisor.answer({ question: 'q', passages: [{ id: 'knowledge:dataroom-1', text: 'x' }] });

  assert.equal(answer.sections.length, 1);
  assert.deepEqual(answer.sections[0].claims[0].cites, ['knowledge:dataroom-1']);
  assert.ok(!fetchImpl.calls[0].url.includes(KEY), 'the key was put in the URL');
  assert.equal(fetchImpl.calls[0].options.headers['x-api-key'], KEY);
});

test('a model that answers unparseably withholds rather than throwing', async () => {
  // `cannot_answer` is a legitimate, carefully written outcome in this product.
  // An answer nobody can check is withheld, and the reader is told that.
  const fetchImpl = recordingFetch({ body: { content: [{ type: 'text', text: 'Sure! Here you go: some prose.' }] } });
  const answer = await anthropicAdvisor({ apiKey: KEY, fetchImpl }).answer({ question: 'q', passages: [] });
  assert.ok(answer.cannot_answer);
  assert.match(answer.cannot_answer.why, /checked/);
});

test('a fenced JSON answer is still an answer', async () => {
  const fenced = '```json\n{"sections":[{"heading":null,"claims":[{"text":"t","cites":["knowledge:1"]}]}]}\n```';
  const fetchImpl = recordingFetch({ body: { content: [{ type: 'text', text: fenced }] } });
  const answer = await anthropicAdvisor({ apiKey: KEY, fetchImpl }).answer({ question: 'q', passages: [] });
  assert.equal(answer.sections[0].claims[0].text, 't');
});

test('a model that says it cannot answer is passed through as that', async () => {
  const fetchImpl = recordingFetch({
    body: { content: [{ type: 'text', text: JSON.stringify({ cannot_answer: { why: 'the passages do not cover it' } }) }] },
  });
  const answer = await anthropicAdvisor({ apiKey: KEY, fetchImpl }).answer({ question: 'q', passages: [] });
  assert.equal(answer.cannot_answer.why, 'the passages do not cover it');
});

test('the advisor reads its passages whichever way the caller spells them', async () => {
  // The contract summary says `passages`; the call site hands it `context`.
  // Guessing wrong means sending an empty corpus and getting a confident answer
  // assembled from nothing.
  const fetchImpl = recordingFetch({ body: { content: [{ type: 'text', text: '{"sections":[]}' }] } });
  const advisor = anthropicAdvisor({ apiKey: KEY, fetchImpl });
  await advisor.answer({ question: 'q', context: { knowledge: [{ id: 'knowledge:9', text: 'from context' }] } });
  assert.ok(fetchImpl.calls[0].options.body.includes('from context'));
});

test('the translator is told to carry every marker and write no number', async () => {
  const fetchImpl = recordingFetch({ body: { content: [{ type: 'text', text: 'Le chiffre est ⟦0⟧.' }] } });
  const translator = anthropicTranslator({ apiKey: KEY, fetchImpl });
  const out = await translator.translate({ text: 'The figure is ⟦0⟧.', from: 'en', to: 'fr', kind: 'passage' });

  assert.equal(out.text, 'Le chiffre est ⟦0⟧.');
  const sent = JSON.parse(fetchImpl.calls[0].options.body);
  assert.match(sent.system, /exactly once/);
  assert.match(sent.system, /never write a number of your own/i);
  // The text it was given is masked already — no figure was ever in it.
  assert.ok(!/\d/.test('The figure is ⟦0⟧.'.replace(/⟦\d+⟧/g, '')));
});
