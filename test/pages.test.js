/**
 * The pages, against a real organisation with real content in it.
 *
 * `web.test.js` tests the HTTP layer's own guarantees — sessions, CSRF, headers,
 * escaping — on an empty database. This file tests the surfaces that only mean
 * anything once there is something to show: a document somebody is holding, a
 * figure two records disagree about, a passage waiting for a translator, a
 * counterparty following a link.
 *
 * Every test here drives the real server over HTTP. Calling the handlers
 * directly would skip the session, the CSRF check and the route table, which
 * between them are most of what a route can get wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, ctxFor, fakeStorage, FIXTURE_LEGAL_DIR } from './helpers.js';
import { createApp } from '../src/web/server.js';
import { ROUTES } from '../src/web/routes/index.js';
import * as auth from '../src/web/auth.js';
import * as svc from '../src/api/service.js';
import * as seed from '../src/api/seed.js';
import * as sharing from '../src/api/sharing.js';
import * as artifacts from '../src/api/artifacts.js';
import * as extraction from '../src/api/extraction.js';
import * as prose from '../src/api/prose.js';
import * as localisation from '../src/api/localisation.js';
import { fakeTranslator } from '../src/translate/fake.js';
import { fakeBillingProvider } from '../src/billing/fake.js';
import { fakeAdvisor } from '../src/advisor/fake.js';
import { SCORE_FIELD_OF } from '../src/domain/transfer-sheet.js';
import { ALL_REFS } from '../src/domain/criteria.js';

/**
 * A server, a signed-in founder, and the worked example loaded.
 *
 * `now` is the fixture clock, the same one the setup uses. Mixing the fixture
 * clock with the wall clock makes every share link this builds expire in April
 * 2026 and every test that follows one fail for a reason that has nothing to do
 * with what it was testing.
 *
 * `generate` is off by default and asked for where a test actually opens a
 * document. Rendering nine documents takes most of the time this fixture costs,
 * and it was originally on for every test — which made the whole suite slow
 * enough that a full mutation run, where the suite is run once per mutation,
 * went from two hours to five. A slow suite is a suite that stops being run.
 */
async function withExample({ translator = null, payments = null, generate = false } = {}) {
  const db = freshDb();
  const now = ctxFor(db, 'clock').now;
  const storage = {
    ...fakeStorage(),
    get: () => Buffer.from('<!doctype html><html><body><p>a generated document</p></body></html>'),
    has: () => true,
  };

  const app = createApp({
    db, now, secure: false, storage, advisor: fakeAdvisor(), translator, payments,
    legalDir: FIXTURE_LEGAL_DIR,
  });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => { server.listen(0, r); });
  // ───────────────────────────────────────────────────────────────────────
  // UNREFERENCED, AND THE REASON IS NOT TIDINESS
  //
  // A listening server keeps the event loop alive. If a test throws somewhere
  // that skips its close, the process never exits — and `npm test` then never
  // returns. Under the mutation harness, which runs the suite once per
  // mutation and waits for it, one leaked server stops the entire run dead
  // with no error and no output: a hung suite and a slow one look identical
  // from outside, and this one sat at zero CPU for twenty minutes before
  // anybody noticed.
  //
  // `unref` stops the socket counting towards keeping the process alive. The
  // server stays up for the whole test, because an in-flight fetch keeps the
  // loop busy; it simply cannot outlive the work.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;

  const sys = { ...ctxFor(db, 'system'), storage };
  const user = auth.register(sys, {
    email: 'founder@example.com', password: 'a long enough passphrase',
  }).body.user;
  const session = auth.openSession(sys, user.id);

  const ctx = { ...ctxFor(db, user.id), storage, now };
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  seed.seedWorkedExample(ctx, org.id, { entitle: true, generate });

  return {
    db, base, org, ctx, user, storage,
    cookie: `rr_session=${session.token}`,
    csrf: session.csrf_token,
    close: () => new Promise((r) => { server.close(r); }),
  };
}

const get = (app, path, cookie = app.cookie) =>
  fetch(`${app.base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

const post = (app, path, fields, { cookie = app.cookie, csrf = app.csrf } = {}) =>
  fetch(`${app.base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(csrf === null ? fields : { ...fields, csrf }),
  });

const liveArtifact = (app) => app.db.find('artifact', { org_id: app.org.id })
  .find((a) => a.generated_at && !a.superseded_by);

/**
 * A second, empty organisation on the same server.
 *
 * The transfer sheet is an on-ramp for a company that has nothing recorded yet,
 * so testing it inside the worked example tests the wrong thing: the example
 * already holds a figure under every key the sheet writes, and an assertion
 * about "the figure for this key" then finds the seeded one.
 */
function emptyOrg(app, name = 'A Blank Company') {
  return svc.createOrganisation(app.ctx, { name, path: 'RAISE' }).body.organisation;
}

/** An extraction run with one candidate waiting, as a real upload would leave. */
function pendingCandidate(app, orgId, overrides = {}) {
  const document = app.db.find('document', { org_id: orgId })[0]
    ?? svc.createUploadTicket(app.ctx, orgId, {
      filename: 'accounts-2026.pdf', size_bytes: 120_000,
      mime_type: 'application/pdf', kind: 'ACCOUNTS',
    }, app.storage).body.document;

  const run = app.db.insert('extraction', {
    org_id: orgId, document_id: document.id,
    extractor_id: 'test-extractor', extractor_version: '1',
    doc_kind: 'ACCOUNTS', state: 'NEEDS_REVIEW', unsupported_reason: null,
    pages: 12, text_characters: 4000, candidate_count: 1,
    started_at: app.ctx.now(), finished_at: app.ctx.now(),
    reviewed_at: null, reviewed_by: null, created_at: app.ctx.now(),
  });

  const candidate = app.db.insert('extraction_candidate', {
    org_id: orgId, extraction_id: run.id, document_id: document.id,
    fact_key: 'financials.headcount.test', label: 'Headcount',
    value_numeric: 41, value_text: null, value_date: null, unit: null,
    period_start: null, period_end: null,
    source_page: 7, locator: 'Note 12, staff costs',
    confidence: 0.8, state: 'AWAITING_REVIEW',
    viewed_at: null,
    decided_at: null, decided_by: null, reject_reason: null, fact_id: null,
    created_at: app.ctx.now(),
    ...overrides,
  });

  return { document, run, candidate };
}

// ────────────────────────────────────────────────────── every page renders ──

test('every page of a seeded organisation renders, with no leaked placeholders', async () => {
  const app = await withExample({ generate: true, translator: fakeTranslator(), payments: fakeBillingProvider() });
  try {
    const share = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'A Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
      share_mode: 'FOLLOW_LATEST',
    }).body.token;
    sharing.askThroughShare(app.ctx, share, { question: 'How concentrated is revenue?' });

    const ids = {
      org: app.org.id,
      artifact: liveArtifact(app).id,
      document: app.db.find('document', { org_id: app.org.id })[0].id,
      gap: app.db.find('gap', { org_id: app.org.id })[0].id,
      forecast: app.db.find('forecast', { org_id: app.org.id })[0]?.id ?? 'none',
      token: share,
    };

    const pages = ROUTES
      .filter((r) => (r.method ?? 'GET') === 'GET')
      .map((r) => r.path)
      // Only the paths every parameter of which this fixture can fill. The rest
      // are covered by the tests below, which build the specific state each one
      // needs.
      .filter((p) => (p.match(/:(\w+)/g) ?? []).every((m) => ids[m.slice(1)]))
      .map((p) => p.replace(/:(\w+)/g, (_, name) => ids[name]));

    assert.ok(pages.length >= 25, `only ${pages.length} pages were reachable from this fixture`);

    for (const path of pages) {
      const res = await get(app, path, path.startsWith('/s/') ? '' : app.cookie);
      const type = res.headers.get('content-type') ?? '';
      assert.ok([200, 303, 409].includes(res.status), `${path} returned ${res.status}`);
      if (res.status !== 200 || !type.includes('html')) continue;

      const html = await res.text();
      assert.ok(html.includes('<!doctype html>'), `${path} is not a whole page`);
      assert.ok(!html.includes('undefined'), `${path} rendered the word "undefined"`);
      assert.ok(!html.includes('[object Object]'), `${path} rendered an object`);
      assert.ok(!html.includes('NaN'), `${path} rendered NaN`);
    }
  } finally { await app.close(); }
});

test('every page of the worked example carries the illustrative notice', async () => {
  // One notice on a landing page relies on the reader having come through the
  // front door and remembering. A screenshot of a single page taken out of
  // context is exactly how invented figures get quoted as real ones.
  const app = await withExample({ generate: true });
  try {
    for (const path of ['', '/facts', '/artifacts', '/gaps', '/readiness', '/conflicts',
      '/upkeep', '/languages', '/plan', '/audit', '/valuation']) {
      const html = await (await get(app, `/org/${app.org.id}${path}`)).text();
      assert.match(html, /Illustrative example\./, `${path} has no notice`);
      assert.match(html,
        /All names, figures, workflows, and outcomes are invented for teaching purposes\./,
        `${path} has a truncated notice`);
    }
  } finally { await app.close(); }
});

// ─────────────────────────────────────────────── the counterparty's page ──

test('a share link opens for somebody with no account', async () => {
  const app = await withExample();
  try {
    const token = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'Vantage Partners', recipient_org: 'Vantage',
      subject_kind: 'ROOM', stage: 'QUALIFIED', share_mode: 'FOLLOW_LATEST',
    }).body.token;

    const res = await get(app, `/s/${token}`, '');
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Northwind Systems/, 'the company is not named');
    assert.match(html, /Vantage Partners/, 'the recipient is not named on the watermark');
    assert.match(html, /Provided in confidence/, 'the footer attribution is missing');
    assert.match(html, /noindex/, 'the page is indexable');

    // Not the app. A reader following a link is not a user of this product, and
    // offering them an account suggests the link is theirs to keep.
    assert.ok(!html.includes('/sign-in'), 'the counterparty was offered a sign-in');
    assert.ok(!html.includes('class="rail"'), 'the counterparty got the app navigation');
  } finally { await app.close(); }
});

test('opening a link is recorded, and shows up in the access record', async () => {
  const app = await withExample();
  try {
    const token = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'A Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
    }).body.token;

    assert.equal((await get(app, `/s/${token}`, '')).status, 200);
    assert.equal((await get(app, `/s/${token}`, '')).status, 200);

    const html = await (await get(app, `/org/${app.org.id}/access`)).text();
    assert.match(html, /A Reader/);
    // Two opens, counted. The number is the point of the page.
    assert.match(html, /<td class="right">2<\/td>/);
  } finally { await app.close(); }
});

test('a room link shows only the folders that recipient’s stage opens', async () => {
  const app = await withExample();
  try {
    const early = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'Early Reader', subject_kind: 'ROOM', stage: 'PRE_MEETING',
    }).body.token;
    const late = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'Late Reader', subject_kind: 'ROOM', stage: 'CONFIRMATORY',
    }).body.token;

    const earlyHtml = await (await get(app, `/s/${early}`, '')).text();
    const lateHtml = await (await get(app, `/s/${late}`, '')).text();

    const folders = (html) => (html.match(/class="block"/g) ?? []).length;
    assert.ok(folders(lateHtml) > folders(earlyHtml),
      'a confirmatory-stage link showed no more than a pre-meeting one');

    // Said rather than hidden: a reader who can see that folders exist and are
    // not open yet is better informed than one who cannot tell whether they are
    // missing or empty.
    assert.match(earlyHtml, /open at later stages/);
  } finally { await app.close(); }
});

test('a document link renders the document, and a room link refuses to', async () => {
  const app = await withExample({ generate: true });
  try {
    const artifact = liveArtifact(app);
    const docLink = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'Doc Reader', subject_kind: 'ARTIFACT', artifact_id: artifact.id,
      stage: 'QUALIFIED', share_mode: 'PINNED',
    }).body.token;
    const roomLink = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'Room Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
    }).body.token;

    const doc = await get(app, `/s/${docLink}/document`, '');
    assert.equal(doc.status, 200);
    assert.match(await doc.text(), /a generated document/);
    // The document is a full HTML page of somebody else's making, served inside
    // this origin. Sandboxed, or it is a page with access to the app's cookies.
    assert.match(doc.headers.get('content-security-policy') ?? '', /^sandbox;/);
    assert.match(doc.headers.get('content-security-policy') ?? '', /default-src 'none'/);

    // A room link is an index of source documents, not a licence to read
    // anything the company has generated.
    const refused = await get(app, `/s/${roomLink}/document`, '');
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /index of the data room/);
  } finally { await app.close(); }
});

test('a revoked link stops working, and says nothing about why', async () => {
  const app = await withExample();
  try {
    const created = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'A Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
    }).body;
    assert.equal((await get(app, `/s/${created.token}`, '')).status, 200);

    sharing.revokeShare(app.ctx, app.org.id, created.share.id, { reason: 'process ended' });

    const after = await get(app, `/s/${created.token}`, '');
    assert.ok(after.status >= 400, 'a revoked link still opened');
    const html = await after.text();
    // The reason is the company's business, not the reader's.
    assert.ok(!html.includes('process ended'), 'the revoke reason was shown to the reader');
  } finally { await app.close(); }
});

test('a counterparty can ask a question, and it reaches the question log', async () => {
  const app = await withExample();
  try {
    const token = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'A Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
    }).body.token;

    // No session, so no CSRF token. Holding the link is what authorises this,
    // exactly as it authorises reading the page.
    const res = await post(app, `/s/${token}/ask`, {
      question: 'What is the trend in customer concentration?',
    }, { cookie: '', csrf: null });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /asked=1/);

    const log = await (await get(app, `/org/${app.org.id}/questions`)).text();
    assert.match(log, /trend in customer concentration/);
    assert.match(log, /A Reader/);
  } finally { await app.close(); }
});

test('a question is checked against earlier answers before it is sent', async () => {
  // The damaging thing is not an imperfect answer. It is two different answers
  // to the same question given to two parties.
  const app = await withExample();
  try {
    const first = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'First Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
    }).body.token;
    const second = sharing.createShare(app.ctx, app.org.id, {
      recipient_name: 'Second Reader', subject_kind: 'ROOM', stage: 'QUALIFIED',
    }).body.token;

    const q1 = sharing.askThroughShare(app.ctx, first,
      { question: 'How concentrated is your customer revenue?' }).body.question;
    await post(app, `/org/${app.org.id}/questions/${q1.id}`, {
      answer: 'Our largest customer is thirty-four percent of revenue and the share is rising.',
    });

    const q2 = sharing.askThroughShare(app.ctx, second,
      { question: 'How concentrated is your customer revenue, roughly?' }).body.question;

    const draft = await post(app, `/org/${app.org.id}/questions/${q2.id}/draft`, {
      answer: 'Nothing above a tenth of turnover sits with any single account whatsoever.',
    });
    const html = await draft.text();

    assert.match(html, /answered a similar question before/,
      'the inconsistency was not flagged');
    assert.match(html, /thirty-four percent/, 'the earlier answer was not shown for comparison');
    // Flagged, not blocked. Deciding whether two prose answers mean the same
    // thing is a judgement a product would make wrongly and confidently.
    assert.match(html, /Send this answer/);
  } finally { await app.close(); }
});

// ─────────────────────────────────────────────── regeneration in two steps ──

test('the regenerate control opens a preview rather than regenerating', async () => {
  const app = await withExample({ generate: true });
  try {
    const artifact = liveArtifact(app);
    const before = app.db.get('artifact', artifact.id);

    const list = await (await get(app, `/org/${app.org.id}/artifacts`)).text();
    assert.match(list, new RegExp(`/artifacts/${artifact.id}/regenerate`),
      'the list has no link to the preview');

    const preview = await get(app, `/org/${app.org.id}/artifacts/${artifact.id}/regenerate`);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /does not rewrite a document somebody else is holding/);

    const after = app.db.get('artifact', artifact.id);
    assert.equal(after.state, before.state, 'looking at the preview changed the artifact');
    assert.equal(after.superseded_by, null, 'looking at the preview superseded the artifact');
  } finally { await app.close(); }
});

test('the preview names which figures moved and which only changed source', async () => {
  const app = await withExample({ generate: true });
  try {
    const artifact = liveArtifact(app);
    const refs = JSON.parse(app.db.get('artifact', artifact.id).fact_refs ?? '[]');
    const corrected = app.db.get('fact', refs[0]);

    svc.supersedeFact(app.ctx, app.org.id, corrected.id, {
      value_numeric: Number(corrected.value_numeric) + 1234,
      reason: 'The accounts were restated.',
    });

    const html = await (await get(app, `/org/${app.org.id}/artifacts/${artifact.id}/regenerate`)).text();
    assert.match(html, /Figures whose value moved/);
    assert.match(html, new RegExp(corrected.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /The value/, 'the change was not classified');
  } finally { await app.close(); }
});

test('regenerating a document somebody is holding says so instead of redirecting', async () => {
  const app = await withExample({ generate: true });
  try {
    const artifact = liveArtifact(app);
    await post(app, `/org/${app.org.id}/artifacts/${artifact.id}/release`, {
      note: 'Emailed to the investment committee on Tuesday.',
    });

    const refs = JSON.parse(app.db.get('artifact', artifact.id).fact_refs ?? '[]');
    const fact = app.db.get('fact', refs[0]);
    svc.supersedeFact(app.ctx, app.org.id, fact.id, {
      value_numeric: Number(fact.value_numeric) + 5000,
      reason: 'Corrected against the audited accounts.',
    });

    const res = await post(app, `/org/${app.org.id}/artifacts/${artifact.id}/regenerate`, {});
    assert.equal(res.status, 200, 'the warning was skipped by a redirect');
    const html = await res.text();
    assert.match(html, /investment committee/, 'it did not say who is holding the old one');
    assert.match(html, /Telling them yourself is a short conversation/);

    // And the old version is kept, because it is what somebody was sent.
    assert.equal(app.db.get('artifact', artifact.id).state, 'SUPERSEDED');
    assert.ok(app.db.get('artifact', artifact.id).superseded_by);
  } finally { await app.close(); }
});

test('marking a document as sent needs a note saying who', async () => {
  const app = await withExample({ generate: true });
  try {
    const artifact = liveArtifact(app);
    const res = await post(app, `/org/${app.org.id}/artifacts/${artifact.id}/release`, { note: '' });
    assert.ok(res.status >= 400);
    assert.match(await res.text(), /who this went to/i);
    assert.equal(app.db.get('artifact', artifact.id).released_at, null);
  } finally { await app.close(); }
});

// ─────────────────────────────────────────────────────────── contradictions ──

test('a contradiction is shown level, with no side preferred', async () => {
  const app = await withExample();
  try {
    // Two records of the same figure, far enough apart to be a disagreement
    // rather than rounding. Written straight to the table: detection is tested
    // exhaustively in `conflicts.test.js`, and what is under test here is how a
    // detected one is presented.
    const left = app.db.find('fact', { org_id: app.org.id })
      .find((f) => f.fact_key === 'financials.arr' && !f.superseded_by);
    assert.ok(left, 'the worked example has no ARR figure to disagree about');

    app.db.insert('conflict', {
      org_id: app.org.id,
      rule_ref: 'test-rule', kind: 'VALUE_MISMATCH', severity: 'HIGH',
      left_ref: `fact:${left.id}`, left_summary: 'The accounts say $3,800,000',
      right_ref: 'fact:other', right_summary: 'The deck says $4,100,000',
      detail: 'Annual recurring revenue is recorded twice with different values.',
      resolved_at: null, resolved_by: null, resolution: null, resolution_note: null,
      created_at: app.ctx.now(),
    });

    const html = await (await get(app, `/org/${app.org.id}/conflicts`)).text();
    assert.match(html, /recorded twice with different values/);
    assert.match(html, /One record says/);
    assert.match(html, /The other says/);
    assert.match(html, /Neither figure changes/,
      'the page does not say that resolving changes nothing');
    assert.ok(!/recommend|correct value|should be/i.test(html),
      'the page implied which record is right');
  } finally { await app.close(); }
});

test('settling a contradiction records a reason and changes neither figure', async () => {
  const app = await withExample();
  try {
    const left = app.db.find('fact', { org_id: app.org.id })
      .find((f) => f.fact_key === 'financials.arr' && !f.superseded_by);
    const conflict = app.db.insert('conflict', {
      org_id: app.org.id,
      rule_ref: 'test-rule', kind: 'VALUE_MISMATCH', severity: 'HIGH',
      left_ref: `fact:${left.id}`, left_summary: 'The accounts say one thing',
      right_ref: 'fact:other', right_summary: 'The deck says another',
      detail: 'Two records disagree.',
      resolved_at: null, resolved_by: null, resolution: null, resolution_note: null,
      created_at: app.ctx.now(),
    });

    // A reason is required, and one word is not a reason.
    const thin = await post(app, `/org/${app.org.id}/conflicts/${conflict.id}`, {
      resolution: 'LEFT', note: 'ok',
    });
    assert.ok(thin.status >= 400);
    assert.match(await thin.text(), /the only record of why one figure was preferred/);

    const done = await post(app, `/org/${app.org.id}/conflicts/${conflict.id}`, {
      resolution: 'LEFT',
      note: 'The audited accounts are the source; the deck was drafted before the restatement.',
    });
    assert.equal(done.status, 303);

    const settled = app.db.get('conflict', conflict.id);
    assert.equal(settled.resolution, 'LEFT');
    assert.ok(settled.resolution_note.includes('audited accounts'));

    // The figure itself is untouched. Deciding which record to trust and
    // correcting a number are different acts, and conflating them would let a
    // resolution quietly rewrite the record.
    const after = app.db.get('fact', left.id);
    assert.equal(after.value_numeric, left.value_numeric);
    assert.equal(after.superseded_by, null);
  } finally { await app.close(); }
});

// ───────────────────────────────────────────────────── the paper workbook ──

test('the transfer sheet imports what it can and names what it cannot', async () => {
  const app = await withExample({ generate: false });
  try {
    const org = emptyOrg(app);
    const sheet = {
      sheet_version: '1.0',
      receipt_ref: 'RCPT-TEST-0001',
      ...Object.fromEntries(ALL_REFS.map((r, i) => [SCORE_FIELD_OF(r), String((i % 5) + 1)])),
      norm_reported_profit: '410000',
      norm_normalised_earnings: '512000',
      conc_top1: '34',
      conc_top3: 'about a half',          // deliberately unreadable
      conc_direction: 'INCREASING',
      assum_1: 'Enterprise win rate holds as deal size rises',
      kp1_person: 'The founder',
      kp1_holds: 'Every top-ten customer relationship',
      kp1_deputy: '',                     // deliberately blank: that is the finding
    };

    const res = await post(app, `/org/${org.id}/transfer-sheet`, sheet);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /boxes read/);
    assert.match(html, /could not be read/, 'the unreadable box was not named');
    assert.match(html, /recorded as entered by hand/,
      'transcribed figures were not marked as typed');

    // The legible figures went in, as typed rather than as confirmed: nothing
    // was inferred, so nothing is marked as having been.
    const top1 = app.db.find('fact', { org_id: org.id })
      .find((f) => f.fact_key === 'commercial.concentration.top1' && !f.superseded_by);
    assert.equal(Number(top1.value_numeric), 34);
    assert.equal(top1.source, 'USER_ENTERED');

    // And a blank box is blank, not zero. The sheet's own parser knows the
    // difference and the score depends on it: an unanswered criterion is not a
    // nought.
    const deputy = app.db.find('fact', { org_id: org.id })
      .find((f) => String(f.fact_key).includes('deputy') && Number(f.value_numeric) === 0);
    assert.equal(deputy, undefined, 'a blank box was recorded as zero');
  } finally { await app.close(); }
});

test('a receipt can only be redeemed once, and the page says so before the form', async () => {
  const app = await withExample({ generate: false });
  try {
    const org = emptyOrg(app, 'First Company');
    const sheet = {
      sheet_version: '1.0', receipt_ref: 'RCPT-TEST-0002',
      norm_reported_profit: '410000', conc_top1: '34',
    };
    assert.equal((await post(app, `/org/${org.id}/transfer-sheet`, sheet)).status, 200);

    const again = await get(app, `/org/${org.id}/transfer-sheet`);
    assert.match(await again.text(), /Already transcribed/);

    // The same receipt in a different organisation is refused too. A credit
    // that can be claimed twice is a credit that will be.
    const second = emptyOrg(app, 'Second Company');
    const reused = await post(app, `/org/${second.id}/transfer-sheet`, sheet);
    assert.ok(reused.status >= 400, 'the same receipt was redeemed twice');
    assert.match(await reused.text(), /already been applied/);
  } finally { await app.close(); }
});

// ─────────────────────────────────────────────────────────────── languages ──

test('a machine translation is not used until a person approves it', async () => {
  const app = await withExample({ translator: fakeTranslator() });
  try {
    const block = prose.listProse(app.ctx, app.org.id).body.prose[0];
    assert.ok(block, 'the worked example wrote no prose to translate');

    const made = await post(app, `/org/${app.org.id}/languages/${block.id}/machine`,
      { locale: 'fr-FR' });
    assert.equal(made.status, 303);

    const row = app.db.find('prose_translation', { org_id: app.org.id })
      .find((t) => t.prose_id === block.id && !t.superseded_by);
    assert.equal(row.state, 'MACHINE_TRANSLATED');

    // Asserted on this passage, not on the page's text. The first version of
    // this test matched "Waiting for a reader" and "renders in English"
    // anywhere in the HTML — both of which are static labels that appear
    // whatever the state, so it passed when the usability rule was widened to
    // let a machine translation through. A phrase on a page is not a fact about
    // a row.
    const waiting = () => localisation.translationStatus(app.ctx, app.org.id, 'fr-FR')
      .body.passages.find((p) => p.prose_id === block.id);

    assert.equal(waiting().usable, false, 'a machine translation was usable without approval');
    assert.equal(waiting().renders, 'en-GB', 'a document would render an unapproved translation');

    await post(app, `/org/${app.org.id}/languages/${row.id}/approve`, {});
    assert.equal(app.db.get('prose_translation', row.id).state, 'HUMAN_APPROVED');
    assert.equal(waiting().usable, true, 'an approved translation is still not usable');
    assert.equal(waiting().renders, 'fr-FR');

    // And the page says which, next to that passage rather than anywhere on it.
    const after = await (await get(app, `/org/${app.org.id}/languages?locale=fr-FR`)).text();
    assert.match(after, /renders in French/);
  } finally { await app.close(); }
});

test('the usable-translation rule admits exactly one state', async () => {
  // The rule the test above rests on. Widening this list is the one change that
  // would put an unreviewed machine translation into a document a company
  // sends to an investor, and it should take a deliberate edit here to do it.
  assert.deepEqual([...localisation.USABLE_TRANSLATION_STATES], ['HUMAN_APPROVED']);
});

test('a translation that drops a figure reference is refused', async () => {
  const app = await withExample();
  try {
    const block = prose.listProse(app.ctx, app.org.id).body.prose
      .find((p) => p.fact_refs.length > 0);
    // Asserted, not fallen back from. A block with no references cannot drop
    // one, so this test would pass on it while checking nothing.
    assert.ok(block, 'no passage in the worked example carries a figure reference');
    assert.ok(block.fact_refs.length >= 1);

    const res = await post(app, `/org/${app.org.id}/languages/${block.id}/write`, {
      locale: 'de-DE',
      body: 'Eine Übersetzung ohne eine einzige Zahl darin.',
    });
    assert.ok(res.status >= 400, 'a translation missing its references was accepted');
    const html = await res.text();
    assert.match(html, /reference/i);
  } finally { await app.close(); }
});

test('a translation written by a person is in use immediately', async () => {
  // A human wrote it, which was always the bar. There is nothing further to
  // approve and pretending otherwise is a queue for its own sake.
  const app = await withExample();
  try {
    const block = prose.listProse(app.ctx, app.org.id).body.prose[0];
    const refs = (block.body.match(/\{\{\s*fact:[a-z0-9_.]+\s*\}\}/gi) ?? []).join(' ');

    const res = await post(app, `/org/${app.org.id}/languages/${block.id}/write`, {
      locale: 'es-ES',
      body: `Una traducción escrita por una persona. ${refs}`,
    });
    assert.equal(res.status, 303);

    const status = localisation.translationStatus(app.ctx, app.org.id, 'es-ES').body;
    const passage = status.passages.find((p) => p.prose_id === block.id);
    assert.equal(passage.state, 'HUMAN_APPROVED');
    assert.equal(passage.usable, true);
    assert.equal(passage.renders, 'es-ES');
  } finally { await app.close(); }
});

test('the never-translated list is shown as the rule it is', async () => {
  const app = await withExample();
  try {
    const html = await (await get(app, `/org/${app.org.id}/languages`)).text();
    assert.match(html, /never machine-translated/i);
    for (const word of ['disclaimer', 'legal notice', 'confidentiality', 'person name']) {
      assert.ok(html.toLowerCase().includes(word), `the list does not mention ${word}`);
    }
  } finally { await app.close(); }
});

// ──────────────────────────────────────────────────────────────── the plan ──

test('with no payment provider the plans are listed and nothing can be bought', async () => {
  const app = await withExample();
  try {
    const html = await (await get(app, `/org/${app.org.id}/plan`)).text();

    assert.match(html, /No payment provider is configured/);
    // A plan's purpose line, which only the catalogue renders — "RaiseRoom"
    // alone would match the wordmark in the header of every page.
    assert.match(html, /Accelerators, funds and banks/,
      'the plans were hidden along with the checkout');
    assert.ok(!html.includes('/plan/checkout'), 'a checkout form was rendered with no provider');

    const res = await post(app, `/org/${app.org.id}/plan/checkout`,
      { plan_key: 'RAISEROOM', term: 'ANNUAL' });
    assert.equal(res.status, 503);
  } finally { await app.close(); }
});

test('with a provider, checkout hands off and this product never sees a price', async () => {
  const app = await withExample({ payments: fakeBillingProvider() });
  try {
    const page = await (await get(app, `/org/${app.org.id}/plan`)).text();
    assert.match(page, /Prices are shown at checkout/);
    // The price is the provider's. A price stored in two places disagrees
    // eventually, and the wrong copy is always the one the customer sees.
    assert.ok(!/\$\d+ ?\/ ?(month|year)/.test(page), 'a price was rendered in the product');

    const res = await post(app, `/org/${app.org.id}/plan/checkout`,
      { plan_key: 'RAISEROOM', term: 'ANNUAL' });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /^https:\/\/billing\.test\/checkout\//);
  } finally { await app.close(); }
});

test('somebody about to cancel is told what happens to their records', async () => {
  // The sentence existed, as a lede at the top of a page a departing customer
  // scrolls past on the way out. It is now beside the cancel link, which is
  // where the question is actually being asked.
  const app = await withExample({ payments: fakeBillingProvider() });
  try {
    const sub = app.db.findOne('subscription', { org_id: app.org.id });
    app.db.update('subscription', sub.id, {
      provider: 'fake-billing', provider_ref: 'sub_live_1', term: 'ANNUAL', state: 'ACTIVE',
    });

    const html = await (await get(app, `/org/${app.org.id}/plan`)).text();
    assert.match(html, /Change or cancel/);
    assert.match(html, /you can export the whole lot whenever you like/,
      'the cancel section does not say what happens to their records');
    assert.match(html, /Cancelling does not delete anything/);
    assert.match(html, /keep exporting all of it in full/);
    assert.match(html, new RegExp(`/org/${app.org.id}/plan/portal`),
      'there is no way to reach the provider to cancel');

    // The ORDER is the point, and it is the whole reason this changed. The same
    // promise set underneath the cancel link is read after the decision, by
    // somebody who has already braced for bad news. Above it, it is read while
    // they are still deciding — which is the only moment it is worth anything.
    const reassurance = html.indexOf('Cancelling does not delete anything');
    const control = html.indexOf('Manage or cancel');
    assert.ok(reassurance > -1 && control > -1);
    assert.ok(reassurance < control,
      'the reassurance must come before the cancel control, not after it');
  } finally { await app.close(); }
});

test('a trial and a demonstration grant offer no cancel link', async () => {
  // Neither has taken any money, so neither has anything at a provider to
  // manage. A cancel link on either sends somebody to a page about nothing.
  const trial = await withExample({ payments: fakeBillingProvider() });
  try {
    trial.db.remove('subscription', trial.db.findOne('subscription', { org_id: trial.org.id }).id);
    const html = await (await get(trial, `/org/${trial.org.id}/plan`)).text();
    assert.ok(!html.includes('Change or cancel'), 'a trial was offered a cancel link');
  } finally { await trial.close(); }

  const granted = await withExample({ payments: fakeBillingProvider() });
  try {
    const html = await (await get(granted, `/org/${granted.org.id}/plan`)).text();
    assert.match(html, /demonstration grant/);
    assert.ok(!html.includes('Change or cancel'), 'a demonstration grant was offered a cancel link');
  } finally { await granted.close(); }
});

test('the plan page leads with what is kept, not with what is lost', async () => {
  const app = await withExample();
  try {
    const html = await (await get(app, `/org/${app.org.id}/plan`)).text();
    assert.match(html, /What never depends on a plan/);
    assert.match(html, /exportable after a subscription ends/);
    assert.match(html, /Export everything/);
  } finally { await app.close(); }
});

test('the last owner cannot be removed through the people page', async () => {
  const app = await withExample();
  try {
    const membership = app.db.findOne('membership', { org_id: app.org.id, user_id: app.user.id });
    assert.equal(membership.role, 'OWNER');

    const res = await post(app, `/org/${app.org.id}/people/${membership.id}/remove`, {});
    assert.ok(res.status >= 400, 'the last owner was removed');
    assert.ok(app.db.get('membership', membership.id), 'the membership is gone');
  } finally { await app.close(); }
});

// ──────────────────────────────────────────────────── keeping it current ──

test('document ageing is judged by kind, not by one interval', async () => {
  const app = await withExample();
  try {
    const html = await (await get(app, `/org/${app.org.id}/upkeep`)).text();
    assert.match(html, /A document ages at the rate its own kind ages at/);
    // Both policies named, which is the whole argument for the feature.
    assert.match(html, /Management accounts/);
    assert.match(html, /certificate of incorporation/);
  } finally { await app.close(); }
});

test('a document that cannot age is never listed as worth refreshing', async () => {
  // The bug this guards against was visible only in a screenshot: six
  // certificates and contracts under a heading reading "worth refreshing",
  // each one explaining underneath that it could not go out of date. The
  // domain has a TIMELESS state and the page had no label for it, so it fell
  // through to "no date recorded" and into the warning list.
  //
  // A list that flags things it then says are fine is a list people stop
  // reading, which is how the one document that has genuinely gone stale gets
  // missed.
  const app = await withExample();
  try {
    const { body } = (await import('../src/api/freshness.js'))
      .roomFreshness(app.ctx, app.org.id);
    const timeless = body.documents.filter((d) => d.state === 'TIMELESS');
    assert.ok(timeless.length >= 2,
      'the worked example has no documents that cannot age, so this proves nothing');

    const html = await (await get(app, `/org/${app.org.id}/upkeep`)).text();

    const heading = html.match(/<h2>(\d+) documents? worth refreshing<\/h2>/);
    const flagged = heading ? Number(heading[1]) : 0;
    const ageing = body.documents.filter((d) => d.state === 'AGEING' || d.state === 'STALE');
    assert.equal(flagged, ageing.length,
      'the refresh list counts documents that do not age on a clock');

    // They are still named, once, so an empty warning list cannot be mistaken
    // for a page that never looked at them.
    assert.match(html, /will never appear above/);
    for (const d of timeless.slice(0, 2)) assert.ok(html.includes(d.filename));
  } finally { await app.close(); }
});

test('the what-moved digest reports corrections separately from additions', async () => {
  const app = await withExample();
  try {
    const fact = app.db.find('fact', { org_id: app.org.id })
      .find((f) => f.fact_key === 'financials.arr' && !f.superseded_by);
    svc.supersedeFact(app.ctx, app.org.id, fact.id, {
      value_numeric: 3_900_000, reason: 'Restated against the audited accounts.',
    });

    const html = await (await get(app, `/org/${app.org.id}/upkeep?since=2025-01-01`)).text();
    assert.match(html, /was corrected/, 'the correction was not reported');
    assert.match(html, /wrong, not merely old/,
      'the page does not distinguish a corrected figure from an old one');
    // Additions are counted, not listed: a new figure does not make an existing
    // document wrong, and a list of fifty would bury the one that does.
    assert.match(html, /counted rather than listed/);
  } finally { await app.close(); }
});

// ─────────────────────────────────────────────────── reviewing a document ──

test('a figure read from a document can be confirmed, corrected or rejected', async () => {
  const app = await withExample({ generate: false });
  try {
    const { document, candidate } = pendingCandidate(app, app.org.id);

    const page = await (await get(app, `/org/${app.org.id}/documents/${document.id}/review`)).text();
    assert.match(page, /Headcount/);
    assert.match(page, /Note 12, staff costs/, 'where it was read from is not shown');
    assert.match(page, /proposal until somebody confirms it/);

    // Corrected rather than confirmed: both values stay on the record.
    const res = await post(app, `/org/${app.org.id}/documents/${document.id}/review`, {
      candidate: candidate.id, decision: 'CONFIRM', value_numeric: '43',
    });
    assert.equal(res.status, 303);

    const decided = app.db.get('extraction_candidate', candidate.id);
    assert.equal(decided.state, 'EDITED_CONFIRMED');
    assert.equal(Number(decided.value_numeric), 41, 'the extractor’s reading was overwritten');
    assert.equal(Number(app.db.get('fact', decided.fact_id).value_numeric), 43);
  } finally { await app.close(); }
});

test('a figure waiting for review is announced on the documents page', async () => {
  // The regression this exists for: both this page and the review page filtered
  // candidates by state names that do not exist in the enum, so the prompt
  // telling somebody that figures were waiting on them rendered empty for ever.
  // Nothing failed, because an empty list is exactly what an organisation with
  // nothing waiting looks like — which is why the assertion here is that the
  // prompt appears, not that the page loads.
  const app = await withExample({ generate: false });
  try {
    pendingCandidate(app, app.org.id);

    const html = await (await get(app, `/org/${app.org.id}/documents`)).text();
    assert.match(html, /1 figure waiting for you/);
    assert.match(html, /Headcount/);
    assert.match(html, /A figure read from a document is a proposal/);
  } finally { await app.close(); }
});

test('the states a candidate page filters on are states the domain has', async () => {
  // The structural half of the test above. A page can filter correctly today
  // and drift tomorrow; this fails if either page starts naming states itself
  // again instead of asking the domain.
  const { readFileSync } = await import('node:fs');
  const { CANDIDATE_STATES } = await import('../src/domain/extraction.js');

  for (const file of ['work.js', 'evidence.js']) {
    const source = readFileSync(new URL(`../src/web/routes/${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const named = [...source.matchAll(/c\.state\s*[=!]==\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    for (const state of named) {
      assert.ok(CANDIDATE_STATES.includes(state),
        `${file} compares a candidate state to "${state}", which is not one of ${CANDIDATE_STATES.join(', ')}`);
    }
  }
});

test('rejecting a figure needs a reason', async () => {
  const app = await withExample({ generate: false });
  try {
    const { document, candidate } = pendingCandidate(app, app.org.id, {
      fact_key: 'financials.other.test', label: 'Something misread',
      value_numeric: 9, source_page: 2, locator: 'page 2, header', confidence: 0.4,
    });

    const thin = await post(app, `/org/${app.org.id}/documents/${document.id}/review`, {
      candidate: candidate.id, decision: 'REJECT', reason: '',
    });
    assert.ok(thin.status >= 400);
    assert.match(await thin.text(), /only record of why a figure/);
    assert.equal(app.db.get('extraction_candidate', candidate.id).state, 'AWAITING_REVIEW');

    const done = await post(app, `/org/${app.org.id}/documents/${document.id}/review`, {
      candidate: candidate.id, decision: 'REJECT',
      reason: 'The extractor read a page number as a figure.',
    });
    assert.equal(done.status, 303);
    assert.equal(app.db.get('extraction_candidate', candidate.id).state, 'REJECTED');
  } finally { await app.close(); }
});

// ────────────────────────────────────────────────────────────── isolation ──

test('no page of one organisation leaks into another', async () => {
  const mine = await withExample();
  const theirs = await withExample();
  try {
    // A second user on the first server, with their own organisation.
    const other = auth.register({ ...ctxFor(mine.db, 'system'), storage: mine.storage }, {
      email: 'other@example.com', password: 'a different long passphrase',
    }).body.user;
    const otherSession = auth.openSession({ ...ctxFor(mine.db, 'system') }, other.id);
    const otherCookie = `rr_session=${otherSession.token}`;

    for (const route of ROUTES.filter((r) => (r.method ?? 'GET') === 'GET' && r.path.includes(':org'))) {
      const path = route.path.replace(':org', mine.org.id).replace(/:(\w+)/g, 'x');
      const res = await get(mine, path, otherCookie);
      // 404, never 403 — a 403 confirms the organisation exists, and a company
      // in a confidential process should not be confirmable by a stranger.
      assert.equal(res.status, 404, `${path} returned ${res.status} to a non-member`);
      const html = await res.text();
      assert.ok(!html.includes('Northwind'), `${path} named the company to a non-member`);
    }
  } finally { await mine.close(); await theirs.close(); }
});

test('an applied workbook credit is not still announced as waiting', async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // A SIGNAL THAT FIRES REGARDLESS OF STATE IS ONE NOBODY READS
  //
  // This banner read `credit.applied` off `onramp.creditStatus()`, whose credit
  // summary does not carry that field. `undefined` is falsy, so the banner said
  // "your $147 credit is waiting" for ever — including after it had been spent.
  // The authoritative summary is `billing.status().credit`, which carries both
  // the amount and whether it was applied.
  const app = await withExample();
  try {
    const org = emptyOrg(app, 'A Company With A Credit');

    const redemption = app.db.insert('workbook_redemption', {
      org_id: org.id, receipt_ref: 'RCPT-APPLIED-1',
      credit_minor: 14_700, credit_currency: 'USD', facts_seeded: 0,
      redeemed_by: app.user.id, redeemed_at: app.ctx.now(), created_at: app.ctx.now(),
    });

    const waiting = await (await get(app, `/org/${org.id}/plan`)).text();
    assert.match(waiting, /workbook credit is waiting/, 'an unapplied credit is not announced');

    const subscription = app.db.insert('subscription', {
      org_id: org.id, plan_key: 'RAISEROOM', state: 'ACTIVE', term: 'ANNUAL',
      provider: 'test', provider_ref: `sub_${org.id}`, seats: null,
      current_period_end: '2027-01-01T00:00:00.000Z', last_event_at: null,
      started_at: app.ctx.now(), created_at: app.ctx.now(),
    });
    app.db.insert('credit_application', {
      org_id: org.id, redemption_id: redemption.id, subscription_id: subscription.id,
      amount_minor: 14_700, currency: 'USD', provider: 'test', provider_ref: 'credit_1',
      applied_by: app.user.id, created_at: app.ctx.now(),
    });

    const applied = await (await get(app, `/org/${org.id}/plan`)).text();
    assert.ok(!applied.includes('workbook credit is waiting'),
      'a credit that has been applied is still announced as waiting');
    // Still shown, because it is still a fact about the account — just not as a
    // thing to act on.
    assert.match(applied, /Applied/);
  } finally { await app.close(); }
});

test('a document cannot be recorded against storage that is not there', async () => {
  // The bug this exists for: the handler built a dummy storage driver inline so
  // the form would post on a deployment with no storage configured. What that
  // produced was a document row pointing at `https://storage.invalid/…`,
  // discovered weeks later by somebody trying to download their own accounts.
  // A row that looks filed and has nothing behind it is worse than a refusal.
  const db = freshDb();
  const now = ctxFor(db, 'clock').now;
  const app = createApp({ db, now, secure: false, storage: null });
  const server = createServer((req, res) => { app(req, res); });
  await new Promise((r) => { server.listen(0, r); });
  // Unreferenced, so a test that skips its close cannot hang the suite.
  // See the note in `withExample` above.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const sys = { ...ctxFor(db, 'system') };
    const user = auth.register(sys, {
      email: 'founder@example.com', password: 'a long enough passphrase',
    }).body.user;
    const session = auth.openSession(sys, user.id);
    const ctx = { db, now, auth: { userId: user.id, email: user.email } };
    const org = svc.createOrganisation(ctx, { name: 'No Storage Co', path: 'RAISE' }).body.organisation;

    const res = await fetch(`${base}/org/${org.id}/documents`, {
      method: 'POST', redirect: 'manual',
      headers: {
        cookie: `rr_session=${session.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: 'accounts-2026.pdf', kind: 'ACCOUNTS', size_bytes: '120000',
        csrf: session.csrf_token,
      }),
    });

    assert.equal(res.status, 503);
    const html = await res.text();
    assert.match(html, /no file storage configured/i);
    assert.match(html, /row pointing at nothing/, 'the refusal does not say why it refused');
    assert.equal(db.find('document', { org_id: org.id }).length, 0,
      'a document row was created with nowhere for its bytes to go');
  } finally { await new Promise((r) => { server.close(r); }); }
});

// ──────────────────────────────────────── what RaiseRoom records about you ──

test('the page about who can see this company also says what we record', async () => {
  const app = await withExample();
  try {
    const html = await (await get(app, `/org/${app.org.id}/visibility`)).text();

    // On the page somebody opens when the question in their head is "who can
    // see this", because the honest answer to that question includes us.
    assert.match(html, /What we record about how you use RaiseRoom/);
    assert.match(html, /Stop counting/);

    // Generated from the catalogue, not written out beside it. Two entries from
    // opposite ends of it, so a list that silently stopped being generated —
    // and started being a paragraph somebody typed — fails here.
    assert.match(html, /Asking the advisor a question/);
    assert.match(html, /Starting checkout/);

    // And the four things it never holds, said on the page rather than only in
    // a policy nobody opens.
    assert.match(html, /the stored counts have no organisation on them/);
  } finally { await app.close(); }
});

test('an owner can switch off what is recorded, and the page says so afterwards', async () => {
  const app = await withExample();
  try {
    const before = app.db.get('organisation', app.org.id);
    assert.equal(before.usage_analytics, 1, 'counting is on by default');

    const res = await post(app, `/org/${app.org.id}/visibility/analytics`, { on: '0' });
    assert.equal(res.status, 303);

    assert.equal(app.db.get('organisation', app.org.id).usage_analytics, 0);

    const html = await (await get(app, `/org/${app.org.id}/visibility`)).text();
    assert.match(html, /Nothing about how this organisation uses RaiseRoom is being recorded/);
    assert.match(html, /Start counting/, 'there is no way back on');
  } finally { await app.close(); }
});
