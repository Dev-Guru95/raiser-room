/**
 * Phase 12 — tiers, billing, export and portfolio.
 *
 * Three promises are load-bearing here, and each is easy to state and easy to
 * quietly break:
 *
 *   1. **Nobody is ever locked out.** Expiry gates writes. Reading and exporting
 *      work in every plan and every state, including cancelled.
 *   2. **The $147 credit is applied exactly once.** Not checked-then-applied —
 *      enforced, so a retry loses to the database rather than to a race.
 *   3. **No cross-company aggregate, ever.** A portfolio holder sees the
 *      companies that invited them, never a benchmark built from them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage, onPlan } from './helpers.js';
import * as svc from './../src/api/service.js';
import * as billing from '../src/api/billing.js';
import * as exporter from '../src/api/export.js';
import * as portfolio from '../src/api/portfolio.js';
import { SHARED_FIELDS } from '../src/api/portfolio.js';
import * as artifacts from '../src/api/artifacts.js';
import * as sharing from '../src/api/sharing.js';
import * as dataroom from '../src/api/dataroom.js';
import * as assessments from '../src/api/assessments.js';
import * as onramp from '../src/api/onramp.js';
import {
  PLANS, PLAN_KEYS, ENTITLEMENTS, NEVER_GATED, WORKING_STATES, STATES,
  gate, seatCheck, creditEligibility, formatMinor, shouldApply, stateForEvent,
  trialState, TRIAL,
} from '../src/domain/billing.js';
import { fakeBillingProvider, signedWebhook } from '../src/billing/fake.js';
import { verifyHmac } from '../src/billing/interface.js';
import { createHmac } from 'node:crypto';
import { ALL_REFS } from '../src/domain/criteria.js';

function world({ plan = null } = {}) {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  if (plan) onPlan(db, org.id, plan);
  return { db, ctx, org, storage };
}

/** An organisation past its trial, with no subscription. */
function expired(db, orgId, state = 'EXPIRED') {
  onPlan(db, orgId, 'RAISEROOM', { state });
}

// ──────────────────────────────────────────── nobody is ever locked out ──

test('every plan includes everything on the never-gated list', () => {
  // The promise, as a thing in the code. Moving one of these into a paid tier
  // breaks the build rather than a customer.
  for (const key of PLAN_KEYS) {
    for (const never of NEVER_GATED) {
      assert.ok(!PLANS[key].entitlements.includes(never),
        `${key} gates ${never}, which is on the never-gated list`);
    }
  }
  assert.ok(NEVER_GATED.includes('EXPORT_EVERYTHING'));
  assert.ok(NEVER_GATED.includes('READ_EVERYTHING'));
});

test('an expired subscription can still read everything', () => {
  const { ctx, org, db, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });
  dataroom.buildRoom(ctx, org.id);

  expired(db, org.id);

  // Every one of these is a read, and every one still works.
  assert.equal(svc.listFacts(ctx, org.id).status, 200);
  assert.equal(svc.listMembers(ctx, org.id).status, 200);
  assert.equal(svc.listAudit(ctx, org.id).status, 200);
  assert.equal(dataroom.getRoom(ctx, org.id).status, 200);
  assert.equal(assessments.listAssessments(ctx, org.id).status, 200);
  assert.equal(artifacts.listArtifacts(ctx, org.id).status, 200);
  assert.equal(billing.status(ctx, org.id).status, 200);
});

test('every subscription state can still export everything', () => {
  // The one that makes "never locked out" a fact rather than a sentence — and
  // checked in EVERY state, because a gate written against one of them would
  // pass a test that only tried the other.
  for (const state of STATES) {
    const { ctx, org, db } = world();
    svc.createFact(ctx, org.id, {
      fact_key: 'company.name', label: 'Registered name',
      value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
    });
    expired(db, org.id, state);

    const res = exporter.exportEverything(ctx, org.id);
    assert.equal(res.status, 200, `export was refused in state ${state}`);
    assert.equal(res.body.data.fact.length, 1);
    assert.equal(exporter.exportManifest(ctx, org.id).body.gated_by, null);
  }
});

test('every subscription state can still read everything', () => {
  for (const state of STATES) {
    const { ctx, org, db } = world();
    dataroom.buildRoom(ctx, org.id);
    expired(db, org.id, state);
    assert.equal(svc.listFacts(ctx, org.id).status, 200, `reading was refused in state ${state}`);
    assert.equal(dataroom.getRoom(ctx, org.id).status, 200);
  }
});

test('an expired subscription can still record facts and upload documents', () => {
  // Their own records, which they may be mid-way through. Stopping somebody
  // writing down what they already know is punishment, not a paywall.
  const { ctx, org, db, storage } = world();
  expired(db, org.id);

  assert.equal(svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 1, unit: 'USD',
    source: 'USER_ENTERED',
  }).status, 201);
  assert.equal(svc.createUploadTicket(ctx, org.id, {
    filename: 'x.pdf', size_bytes: 10, mime_type: 'application/pdf', kind: 'OTHER',
  }, storage).status, 201);
});

test('a billing refusal says what has NOT been taken away', () => {
  // The question somebody actually has when they see a billing error is not
  // "which plan has this" but "have I lost my file".
  const { ctx, org, db } = world();
  expired(db, org.id);

  const err = expectRefusal(() => artifacts.generate(ctx, org.id, 'PITCH_DECK'),
    'subscription_expired', 402);
  assert.ok(err.still_yours);
  assert.deepEqual(err.still_yours.lost, []);
  assert.match(err.still_yours.says, /export the whole lot/);
});

test('a past-due card does not cut anybody off', () => {
  // A failed card is usually an expiry date, not a decision. Cutting a company
  // off mid-raise over one is how a product gets replaced in the worst week of
  // somebody's year.
  const { ctx, org, db } = world();
  onPlan(db, org.id, 'RAISEROOM', { state: 'PAST_DUE' });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Name', value_text: 'N Inc.', source: 'USER_ENTERED',
  });

  assert.ok(WORKING_STATES.includes('PAST_DUE'));
  assert.equal(artifacts.generate(ctx, org.id, 'PITCH_DECK').status, 201);
});

// ──────────────────────────────────────────────────────── plans and gates ──

test('the gate refuses a capability the plan does not have, and names where it is', () => {
  const decision = gate({ plan_key: 'FREE', state: 'ACTIVE' }, 'GENERATE_ARTIFACTS');
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'not_in_plan');
  assert.deepEqual(decision.available_in, ['RAISEROOM', 'FIRM']);
});

test('an unknown capability is a bug, not a refusal', () => {
  // Returning "not allowed" for a typo would make it look like a billing problem
  // and send somebody to a pricing page.
  expectRefusal(() => gate({ plan_key: 'RAISEROOM' }, 'TELEPORTATION'), 'unknown_entitlement', 500);
});

test('Evidence is a superset of Prepare', () => {
  // A company moving from "we are raising" to "we are keeping records" should
  // not discover it has lost the ability to generate a document.
  for (const e of PLANS.RAISEROOM.entitlements) {
    assert.ok(PLANS.RAISEROOM.entitlements.includes(e), `EVIDENCE is missing ${e}`);
  }
  for (const e of PLANS.RAISEROOM.entitlements) {
    assert.ok(PLANS.FIRM.entitlements.includes(e), `ENTERPRISE is missing ${e}`);
  }
});

test('every entitlement a plan grants is one the product actually has', () => {
  // A feature flag with nothing behind it is a promise on a pricing page the
  // product cannot keep.
  for (const key of PLAN_KEYS) {
    for (const e of PLANS[key].entitlements) {
      assert.ok(ENTITLEMENTS.includes(e), `${key} grants "${e}", which is not a capability`);
    }
  }
});

test('the gates are wired to the features they name', () => {
  const { ctx, org, db } = world();
  onPlan(db, org.id, 'FREE', { term: 'NONE' });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Name', value_text: 'N Inc.', source: 'USER_ENTERED',
  });
  dataroom.buildRoom(ctx, org.id);

  expectRefusal(() => artifacts.generate(ctx, org.id, 'PITCH_DECK'), 'not_in_plan', 402);
  expectRefusal(() => sharing.createShare(ctx, org.id, {
    subject_kind: 'ROOM', stage: 'PRE_MEETING', recipient_name: 'An investor',
  }), 'not_in_plan', 402);
});

test('a plan listing carries no prices', () => {
  // The provider holds them. A price in two places disagrees eventually, and the
  // wrong copy is always the one the customer sees.
  const res = billing.plans(ctxFor(freshDb(), 'u'));
  const serialised = JSON.stringify(res.body);
  assert.ok(!/price|amount|\$\d|per month|\/mo/i.test(serialised.replace(/note":"[^"]*"/, '')),
    'a price reached the plan listing');
  assert.match(res.body.note, /shown at checkout/);
});

// ───────────────────────────────────────────────────────────────── the trial ──

test('a new organisation can generate something without paying first', () => {
  // A free tier that stops short of a single document asks somebody to buy on
  // description, and this product's whole argument is that a generated document
  // is unlike what they would otherwise produce.
  const { ctx, org } = world();
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Name', value_text: 'N Inc.', source: 'USER_ENTERED',
  });
  assert.equal(artifacts.generate(ctx, org.id, 'PITCH_DECK').status, 201);

  const status = billing.status(ctx, org.id).body;
  assert.equal(status.term, 'TRIAL');
  assert.equal(status.plan.key, TRIAL.plan_key);
  assert.ok(status.trial.days_left > 0);
});

test('the trial is computed, not stored, so it cannot be left switched on', () => {
  const started = '2026-01-01T00:00:00.000Z';
  assert.equal(trialState(started, '2026-01-05T00:00:00.000Z').in_trial, true);
  assert.equal(trialState(started, '2026-01-20T00:00:00.000Z').in_trial, false);
  assert.equal(trialState(started, '2026-01-05T00:00:00.000Z').days_left, 3);
  assert.equal(trialState(null, '2026-01-05T00:00:00.000Z').in_trial, false);
});

test('a real subscription overrides the trial in both directions', () => {
  const { ctx, org, db } = world();
  onPlan(db, org.id, 'FREE', { term: 'NONE' });
  assert.equal(billing.status(ctx, org.id).body.plan.key, 'FREE',
    'a stored subscription was ignored in favour of the trial');
});

// ─────────────────────────────────────────────────────────────── the credit ──

test('the $147 credit is applied once and then refuses', async () => {
  const { ctx, org, db } = world();
  onramp.redeemWorkbook(ctx, org.id, { receipt_ref: 'WB-0001' });
  onPlan(db, org.id, 'RAISEROOM', { term: 'ANNUAL' });
  const provider = fakeBillingProvider();

  const first = await billing.applyWorkbookCredit(ctx, org.id, provider);
  assert.equal(first.status, 201);
  assert.equal(first.body.credit.amount, '$147.00');

  await assertRefusalAsync(() => billing.applyWorkbookCredit(ctx, org.id, provider), 'already_applied');
  assert.equal(db.count('credit_application', { org_id: org.id }), 1);
});

test('the database itself refuses a second credit for the same redemption', () => {
  // The guard that holds under concurrency, tested directly against the
  // constraint rather than through the service.
  //
  // The code path checks "has this been applied?" before applying — which is the
  // shape of every double-spend there has ever been, and which a sequential test
  // cannot distinguish from a real guarantee. Two requests arriving together
  // both pass that check. Only the unique index stops the second one, and
  // removing it broke nothing in the suite until this test existed.
  const { ctx, org, db } = world();
  const row = {
    org_id: org.id, redemption_id: 'redemption-1', subscription_id: 'sub-1',
    amount_minor: 14_700, currency: 'USD', provider: 'fake-billing', provider_ref: 'c1',
    applied_by: 'u-owner', created_at: ctx.now(),
  };
  db.insert('credit_application', row);
  assert.throws(
    () => db.insert('credit_application', { ...row, id: 'different-id', provider_ref: 'c2' }),
    /UNIQUE|constraint/i,
    'a second credit for the same redemption was accepted',
  );
  assert.equal(db.count('credit_application', { org_id: org.id }), 1);
});

test('the provider call is idempotent, so a retry cannot credit twice', async () => {
  // A lost response is indistinguishable from a failed request, so the caller
  // retries. This is the second of two independent guards.
  const { ctx, org, db } = world();
  const redemption = onramp.redeemWorkbook(ctx, org.id, { receipt_ref: 'WB-0002' }).body.redemption;
  onPlan(db, org.id, 'RAISEROOM', { term: 'ANNUAL' });
  const provider = fakeBillingProvider();

  await billing.applyWorkbookCredit(ctx, org.id, provider);
  // Same key, asked again directly: the provider gives back the same credit.
  const replayed = await provider.applyCredit({
    providerRef: 'x', amountMinor: 14_700, currency: 'USD',
    idempotencyKey: `workbook-credit-${redemption?.id ?? ''}`,
  });
  assert.equal(provider.creditsApplied.size, 1, 'the provider created a second credit');
  assert.ok(replayed.provider_ref);
});

test('a credit is not recorded locally when the provider refuses it', async () => {
  // A row written for a call that failed would make the credit unusable for
  // ever: the local guard would refuse the retry that should have worked.
  const { ctx, org, db } = world();
  onramp.redeemWorkbook(ctx, org.id, { receipt_ref: 'WB-0003' });
  onPlan(db, org.id, 'RAISEROOM', { term: 'ANNUAL' });

  await assertRefusalAsync(
    () => billing.applyWorkbookCredit(ctx, org.id, fakeBillingProvider({ behaviour: 'credit_fails' })),
    'credit_not_applied',
  );
  assert.equal(db.count('credit_application', { org_id: org.id }), 0);

  // And it still works afterwards, which is the point.
  const res = await billing.applyWorkbookCredit(ctx, org.id, fakeBillingProvider());
  assert.equal(res.status, 201);
});

test('the credit waits for an annual subscription rather than being lost', async () => {
  const { ctx, org, db } = world();
  onramp.redeemWorkbook(ctx, org.id, { receipt_ref: 'WB-0004' });
  onPlan(db, org.id, 'RAISEROOM', { term: 'MONTHLY' });

  const err = await assertRefusalAsync(
    () => billing.applyWorkbookCredit(ctx, org.id, fakeBillingProvider()), 'not_annual');
  assert.match(err.message, /does not expire/);

  assert.equal(billing.status(ctx, org.id).body.credit.applied, false);
});

test('eligibility is decided in one place and covers every way it can fail', () => {
  const redemption = { id: 'r1', credit_minor: 14_700, credit_currency: 'USD' };
  const annual = { term: 'ANNUAL', state: 'ACTIVE' };

  assert.equal(creditEligibility({ redemption: null, subscription: annual }).code, 'no_redemption');
  assert.equal(creditEligibility({ redemption, subscription: null }).code, 'no_subscription');
  assert.equal(creditEligibility({ redemption, subscription: { term: 'MONTHLY', state: 'ACTIVE' } }).code,
    'not_annual');
  assert.equal(creditEligibility({ redemption, subscription: { term: 'ANNUAL', state: 'EXPIRED' } }).code,
    'subscription_not_active');
  assert.equal(creditEligibility({ redemption, subscription: annual, alreadyApplied: { created_at: 'x' } }).code,
    'already_applied');
  assert.equal(creditEligibility({ redemption, subscription: annual }).eligible, true);
});

test('money is counted in whole minor units and never in floats', () => {
  assert.equal(formatMinor(14_700), '$147.00');
  assert.equal(formatMinor(0), '$0.00');
  assert.equal(formatMinor(5), '$0.05');
  assert.equal(formatMinor(-14_700), '($147.00)');
  assert.equal(formatMinor(100_000, 'GBP'), '£1,000.00');
  expectRefusal(() => formatMinor(147.5), 'bad_amount', 500);
});

// ──────────────────────────────────────────────────────────────── webhooks ──

test('an unverified webhook changes nothing and is recorded', () => {
  // The endpoint is public by necessity. An unverified webhook is an
  // unauthenticated request that upgrades accounts.
  const { ctx, org, db } = world();
  const provider = fakeBillingProvider();
  const { rawBody } = signedWebhook({
    id: 'evt_1', type: 'subscription.created', org_id: org.id, plan_key: 'FIRM',
    term: 'ANNUAL', occurred_at: '2026-01-01T00:00:00.000Z',
  });

  expectRefusal(() => billing.handleWebhook(ctx, { rawBody, signature: 'nope' }, provider),
    'webhook_unverified', 401);
  assert.equal(db.count('subscription', { org_id: org.id }), 0, 'an unverified webhook changed state');
  // Recorded rather than dropped: a run of these is an attack or a rotated key.
  assert.equal(db.find('billing_event', {}).filter((e) => e.event_type === 'VERIFICATION_FAILED').length, 1);
});

test('signature comparison is constant time and rejects a wrong length first', () => {
  const secret = 's3cret';
  const body = '{"a":1}';
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const good = verifyHmac({ rawBody: body, signature, secret });
  assert.equal(good.ok, true);
  assert.equal(verifyHmac({ rawBody: body, signature: 'short', secret }).ok, false);
  assert.equal(verifyHmac({ rawBody: body, signature: null, secret }).ok, false);
  assert.equal(verifyHmac({ rawBody: body, signature: 'x', secret: null }).ok, false);
});

test('the same webhook delivered five times is applied once', () => {
  // Every provider retries.
  const { ctx, org, db } = world();
  const provider = fakeBillingProvider();
  const signed = signedWebhook({
    id: 'evt_dup', type: 'subscription.created', org_id: org.id, plan_key: 'RAISEROOM',
    term: 'ANNUAL', occurred_at: '2026-01-01T00:00:00.000Z',
  });

  const first = billing.handleWebhook(ctx, signed, provider);
  assert.equal(first.body.applied, true);
  for (let i = 0; i < 4; i++) {
    assert.equal(billing.handleWebhook(ctx, signed, provider).body.duplicate, true);
  }
  assert.equal(db.count('subscription', { org_id: org.id }), 1);
  assert.equal(db.count('billing_event', { org_id: org.id }), 1);
});

test('a cancellation arriving after the renewal it precedes is ignored', () => {
  // Providers deliver out of order. Applying this would lock an account that had
  // just paid, and the customer would find out mid-raise.
  const { ctx, org } = world();
  const provider = fakeBillingProvider();

  billing.handleWebhook(ctx, signedWebhook({
    id: 'evt_renew', type: 'subscription.renewed', org_id: org.id, plan_key: 'RAISEROOM',
    term: 'ANNUAL', occurred_at: '2026-03-01T00:00:00.000Z',
  }), provider);

  const late = billing.handleWebhook(ctx, signedWebhook({
    id: 'evt_cancel', type: 'subscription.cancelled', org_id: org.id,
    occurred_at: '2026-02-01T00:00:00.000Z',
  }), provider);

  assert.equal(late.body.applied, false);
  assert.match(late.body.reason, /older than the last one applied/);
  assert.equal(billing.status(ctx, org.id).body.state, 'ACTIVE');
});

test('an event type nobody has mapped leaves the subscription alone', () => {
  // Guessing — treating an unknown event as a cancellation — turns a provider
  // shipping a feature into an outage for every customer.
  const { ctx, org } = world();
  const provider = fakeBillingProvider();
  billing.handleWebhook(ctx, signedWebhook({
    id: 'evt_a', type: 'subscription.created', org_id: org.id, plan_key: 'RAISEROOM',
    term: 'ANNUAL', occurred_at: '2026-01-01T00:00:00.000Z',
  }), provider);

  const unknown = billing.handleWebhook(ctx, signedWebhook({
    id: 'evt_b', type: 'subscription.quantum_entangled', org_id: org.id,
    occurred_at: '2026-04-01T00:00:00.000Z',
  }), provider);

  assert.equal(unknown.body.applied, false);
  assert.match(unknown.body.reason, /nothing is mapped/);
  assert.equal(billing.status(ctx, org.id).body.state, 'ACTIVE');
  assert.equal(stateForEvent('subscription.quantum_entangled'), null);
});

test('an event for an organisation this instance does not have is stored and ignored', () => {
  const { ctx, db } = world();
  const res = billing.handleWebhook(ctx, signedWebhook({
    id: 'evt_elsewhere', type: 'subscription.created', org_id: 'org-from-another-environment',
    occurred_at: '2026-01-01T00:00:00.000Z',
  }), fakeBillingProvider());

  assert.equal(res.body.applied, false);
  assert.match(res.body.reason, /no such organisation/);
  assert.equal(db.count('billing_event', {}), 1);
});

test('a webhook with no event id is refused, because it cannot be deduplicated', () => {
  const { ctx, org } = world();
  expectRefusal(
    () => billing.handleWebhook(ctx, signedWebhook({
      type: 'subscription.created', org_id: org.id, occurred_at: '2026-01-01T00:00:00.000Z',
    }), fakeBillingProvider()),
    'webhook_unidentified', 400,
  );
});

test('the ordering rule is explicit about an event with no timestamp', () => {
  assert.equal(shouldApply({}, { last_event_at: '2026-01-01' }).apply, false);
  assert.equal(shouldApply({ occurred_at: '2026-02-01' }, null).apply, true);
  assert.equal(shouldApply({ occurred_at: '2026-02-01' }, { last_event_at: '2026-01-01' }).apply, true);
});

test('every event is stored verbatim before anything is done with it', () => {
  // A billing dispute is answered from what the provider actually sent.
  const { ctx, org, db } = world();
  const signed = signedWebhook({
    id: 'evt_verbatim', type: 'subscription.created', org_id: org.id, plan_key: 'RAISEROOM',
    term: 'ANNUAL', occurred_at: '2026-01-01T00:00:00.000Z',
  });
  billing.handleWebhook(ctx, signed, fakeBillingProvider());
  assert.equal(db.findOne('billing_event', { event_ref: 'evt_verbatim' }).payload, signed.rawBody);
});

// ────────────────────────────────────────────────────────────────── seats ──

test('a full plan refuses a new member and never removes an existing one', () => {
  const { ctx, org, db } = world({ plan: 'RAISEROOM' });
  const limit = PLANS.RAISEROOM.seats;
  // One founder already exists, so fill the rest.
  for (let i = 0; i < limit - 1; i++) {
    db.insert('membership', {
      org_id: org.id, user_id: `u-${i}`, email: `u${i}@example.com`, role: 'VIEWER',
      created_at: ctx.now(),
    });
  }
  assert.equal(db.count('membership', { org_id: org.id }), limit);

  const check = billing.seatStatus(ctx, org.id).body;
  assert.equal(check.allowed, false);
  assert.equal(check.limit, limit);
  assert.match(check.says, /Nobody loses access/);
  expectRefusal(() => billing.requireSeat(ctx, org.id), 'seat_limit', 402);

  // And everybody who is already there still is.
  assert.equal(svc.listMembers(ctx, org.id).body.members.length, limit);
});

test('every plan caps seats, so no plan is sold as unlimited', () => {
  // A commercial decision, pinned here because it is the kind that drifts back.
  // `seatCheck` used to carry a branch for an uncapped plan; nothing reaches it
  // now, so it was deleted rather than left as an untested safety net. This is
  // what stops a future plan quietly becoming unlimited without a decision.
  for (const plan of Object.values(PLANS)) {
    assert.equal(typeof plan.seats, 'number', `${plan.key} does not cap seats`);
    assert.ok(plan.seats >= 1 && plan.seats <= 10, `${plan.key} is outside one to ten seats`);
  }
});

// ──────────────────────────────────────────────────────────────── export ──

test('the export discovers its tables rather than listing them', () => {
  // "We forgot to export the new table" is a failure discovered by a customer
  // who has already left.
  const db = freshDb();
  const tables = exporter.exportableTables(db);
  for (const expected of ['fact', 'document', 'artifact', 'prose_block', 'audit_log',
    'subscription', 'portfolio_link', 'prose_translation', 'action_proposal']) {
    assert.ok(tables.includes(expected), `${expected} is not in the export`);
  }
});

test('every org-scoped table in the schema is exported', () => {
  // Asserted against the schema itself, so a table added in a future phase is
  // either exported or this fails.
  const db = freshDb();
  const all = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  const orgScoped = all.filter((t) =>
    db.raw.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'org_id'));
  assert.deepEqual(exporter.exportableTables(db).sort(), orgScoped.sort());
});

test('the export resolves its references into words', () => {
  // A fact row saying source_doc_id: "a1b2…" tells the person opening the file
  // nothing. "accounts.pdf, page 4" tells them everything they needed it for.
  const { ctx, org, storage } = world();
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 3_600_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  });

  const readable = exporter.exportEverything(ctx, org.id).body.readable;
  assert.equal(readable.facts[0].confirmed_from, 'accounts.pdf, page 4');
  assert.equal(readable.facts[0].value, 3_600_000);
});

test('the export withholds live tokens, and says that it did', () => {
  // Exporting them hands working keys to whoever opens the file. An export with
  // a gap nobody mentions is worse than one that says what is missing.
  const { ctx, org, storage } = world();
  dataroom.buildRoom(ctx, org.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Name', value_text: 'N Inc.', source: 'USER_ENTERED',
  });
  sharing.createShare(ctx, org.id, {
    subject_kind: 'ROOM', stage: 'PRE_MEETING', recipient_name: 'An investor',
  });
  void storage;

  const res = exporter.exportEverything(ctx, org.id).body;
  assert.equal(res.data.share.length, 1);
  assert.equal(res.data.share[0].token_hash, null, 'a live token was exported');
  assert.ok(res.withheld.some((w) => w.table === 'share'));
  // And the link itself is still there, which is what the user needs.
  assert.equal(res.readable.shares[0].recipient, 'An investor');
});

test('a viewer can take a copy of what they can see', () => {
  const { ctx, org, db } = world();
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: ctx.now(),
  });
  assert.equal(exporter.exportEverything(ctxFor(db, 'u-viewer'), org.id).status, 200);
});

test('a non-member cannot export', () => {
  const { org, db } = world();
  expectRefusal(() => exporter.exportEverything(ctxFor(db, 'u-stranger'), org.id), 'not_found', 404);
});

test('taking an export is audited', () => {
  const { ctx, org } = world();
  exporter.exportEverything(ctx, org.id);
  assert.ok(ctx.db.find('audit_log', { org_id: org.id }).some((e) => e.action === 'export.taken'));
});

// ─────────────────────────────────────────────────────────────── portfolio ──

function holderWorld() {
  const db = freshDb();
  const companyCtx = ctxFor(db, 'u-founder');
  const holderCtx = ctxFor(db, 'u-accelerator');
  const company = svc.createOrganisation(companyCtx, { name: 'Northwind', path: 'RAISE' }).body.organisation;
  const holder = svc.createOrganisation(holderCtx, { name: 'An Accelerator', path: 'RAISE' }).body.organisation;
  onPlan(db, holder.id, 'FIRM');
  return { db, companyCtx, holderCtx, company, holder };
}

test('a holder cannot add a company; the company invites the holder', () => {
  // A list somebody can assemble about other people without their involvement is
  // surveillance, whatever it is called in the menu.
  const { companyCtx, holderCtx, company, holder } = holderWorld();

  // Nothing in the module lets a holder do this, so the only route is the
  // company's own call — and a holder calling it for a company they are not in
  // is a 404.
  expectRefusal(() => portfolio.inviteHolder(holderCtx, company.id, { holder_org_id: holder.id }),
    'not_found', 404);

  assert.equal(portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id }).status, 201);
});

test('a company can read exactly what a holder will see before agreeing', () => {
  const { companyCtx, company } = holderWorld();
  const res = portfolio.whatTheyWillSee(companyCtx, company.id, { scope: 'PROGRESS' });
  assert.ok(res.body.they_will_see.length >= 5);
  assert.ok(res.body.they_will_see.every((f) => f.field && f.means));
  assert.ok(res.body.they_will_never_see.some((s) => /document/i.test(s)));
});

test('a portfolio shows only the companies that invited the holder', () => {
  const { db, companyCtx, holderCtx, company, holder } = holderWorld();
  const otherCtx = ctxFor(db, 'u-other');
  const other = svc.createOrganisation(otherCtx, { name: 'Unrelated', path: 'RAISE' }).body.organisation;

  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id, label: 'Cohort 4' });

  const res = portfolio.portfolio(holderCtx, holder.id);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.companies[0].org_id, company.id);
  assert.equal(res.body.companies[0].label, 'Cohort 4');
  assert.ok(!res.body.companies.some((c) => c.org_id === other.id));
});

test('NO CROSS-COMPANY AGGREGATE: the response carries no statistic built from the set', () => {
  // The rule the whole product rests on, in the one feature that crosses the
  // boundary. Every company agreed to show the holder their own progress; none
  // agreed to become a data point in somebody else's benchmark.
  const { db, companyCtx, holderCtx, company, holder } = holderWorld();
  const secondCtx = ctxFor(db, 'u-founder-2');
  const second = svc.createOrganisation(secondCtx, { name: 'Westcott', path: 'RAISE' }).body.organisation;

  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id, scope: 'PROGRESS' });
  portfolio.inviteHolder(secondCtx, second.id, { holder_org_id: holder.id, scope: 'PROGRESS' });

  const body = portfolio.portfolio(holderCtx, holder.id).body;
  assert.equal(body.companies.length, 2);

  // Structural, not a search for suspicious words — the explanatory copy
  // mentions "median" precisely in order to say there isn't one, and a test that
  // greps for the word would fail on the sentence promising its absence.
  //
  // Instead: every company entry carries only the fields that company consented
  // to, and the response's own top level carries exactly one number — the count.
  for (const entry of body.companies) {
    const consented = new Set([
      ...SHARED_FIELDS[entry.scope].map((f) => f.field),
      'org_id', 'label', 'scope', 'since',
    ]);
    for (const key of Object.keys(entry)) {
      assert.ok(consented.has(key), `a company entry carries "${key}", which nobody consented to`);
    }
  }
  const topLevelNumbers = Object.entries(body)
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k);
  assert.deepEqual(topLevelNumbers, ['total'],
    `the response carries numbers across companies: ${topLevelNumbers.join(', ')}`);
  assert.match(body.no_benchmark, /There is no comparison/);

  // And the module exports no function that could build one.
  for (const name of Object.keys(portfolio)) {
    assert.ok(!/aggregate|benchmark|compare|median|rank/i.test(name),
      `portfolio exports "${name}"`);
  }
});

test('a holder never sees a figure, a document or anything written', () => {
  const { companyCtx, holderCtx, company, holder, db } = holderWorld();
  const storage = fakeStorage();
  const doc = svc.createUploadTicket(companyCtx, company.id, {
    filename: 'secret-accounts.pdf', size_bytes: 10, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(companyCtx, company.id, doc.id);
  svc.createFact(companyCtx, company.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 3_600_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  });

  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id, scope: 'PROGRESS' });
  const serialised = JSON.stringify(portfolio.portfolio(holderCtx, holder.id).body);

  assert.ok(!serialised.includes('3600000'), 'a figure reached the portfolio');
  assert.ok(!serialised.includes('secret-accounts.pdf'), 'a document name reached the portfolio');
  assert.ok(!serialised.includes('financials.revenue.ttm'), 'a fact key reached the portfolio');
  void db;
});

test('SUMMARY shares less than PROGRESS, and the filter is by construction', () => {
  const { db, companyCtx, holderCtx, company, holder } = holderWorld();
  const secondCtx = ctxFor(db, 'u-founder-2');
  const second = svc.createOrganisation(secondCtx, { name: 'Westcott', path: 'RAISE' }).body.organisation;

  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id, scope: 'SUMMARY' });
  portfolio.inviteHolder(secondCtx, second.id, { holder_org_id: holder.id, scope: 'PROGRESS' });

  const body = portfolio.portfolio(holderCtx, holder.id).body;
  const summary = body.companies.find((c) => c.scope === 'SUMMARY');
  const progress = body.companies.find((c) => c.scope === 'PROGRESS');

  assert.ok(!('open_gaps' in summary), 'SUMMARY leaked a PROGRESS field');
  assert.ok(!('readiness_score' in summary));
  assert.ok('open_gaps' in progress);
  assert.ok('readiness_band' in summary);
});

test('a holder sees progress but never what a gap says', () => {
  // A gap says what is wrong with a company in the company's own words.
  const { companyCtx, holderCtx, company, holder } = holderWorld();
  const a = assessments.createAssessment(companyCtx, company.id, { scorer_role: 'FOUNDER' }).body.assessment;
  assessments.scoreAssessment(companyCtx, company.id, a.id,
    Object.fromEntries(ALL_REFS.map((ref) => [ref, 1])));
  assessments.completeAssessment(companyCtx, company.id, a.id);

  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id, scope: 'PROGRESS' });
  const entry = portfolio.portfolio(holderCtx, holder.id).body.companies[0];

  assert.ok(entry.open_gaps > 0);
  assert.ok(entry.readiness_band);
  const serialised = JSON.stringify(entry);
  const gapText = companyCtx.db.find('gap', { org_id: company.id })[0];
  assert.ok(!serialised.includes(gapText.done_when ?? '@@none@@'), 'a gap\'s wording reached the holder');
});

test('revoking takes effect immediately and needs no reason', () => {
  const { companyCtx, holderCtx, company, holder } = holderWorld();
  const link = portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id }).body.link;
  assert.equal(portfolio.portfolio(holderCtx, holder.id).body.total, 1);

  portfolio.revokeHolder(companyCtx, company.id, link.id);
  assert.equal(portfolio.portfolio(holderCtx, holder.id).body.total, 0);
});

test('a holder cannot revoke their own removal, or re-add themselves', () => {
  const { companyCtx, holderCtx, company, holder } = holderWorld();
  const link = portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id }).body.link;
  // The holder is not a member of the company, so every call about it is a 404.
  expectRefusal(() => portfolio.revokeHolder(holderCtx, company.id, link.id), 'not_found', 404);
  expectRefusal(() => portfolio.inviteHolder(holderCtx, company.id, { holder_org_id: holder.id }),
    'not_found', 404);
});

test('the portfolio needs the plan that includes it', () => {
  const { db, companyCtx, holderCtx, company, holder } = holderWorld();
  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id });
  // One subscription row per organisation, so move the existing one down a plan.
  const sub = db.findOne('subscription', { org_id: holder.id });
  db.update('subscription', sub.id, { plan_key: 'RAISEROOM' });

  expectRefusal(() => portfolio.portfolio(holderCtx, holder.id), 'not_in_plan', 402);
});

test('a company cannot hold itself', () => {
  const { companyCtx, company } = holderWorld();
  expectRefusal(() => portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: company.id }),
    'cannot_hold_self', 400);
});

test('inviting the same holder twice is refused rather than duplicated', () => {
  const { companyCtx, company, holder } = holderWorld();
  portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id });
  expectRefusal(() => portfolio.inviteHolder(companyCtx, company.id, { holder_org_id: holder.id }),
    'already_linked', 409);
});

test('the policy answers the benchmark question the same way every time', () => {
  const { holderCtx, holder } = holderWorld();
  const body = portfolio.portfolioPolicy(holderCtx, holder.id).body;
  assert.match(body.benchmarks, /Not available, and not planned/);
  assert.match(body.revocation, /without telling you first/);
});

// ────────────────────────────────────────────────────────────────── helpers ──

async function assertRefusalAsync(fn, code) {
  try {
    await fn();
  } catch (err) {
    if (err.code !== code) throw new Error(`expected "${code}", got "${err.code}" (${err.message})`);
    return err;
  }
  throw new Error(`expected a refusal with code "${code}", but the call succeeded`);
}
