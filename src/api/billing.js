/**
 * Phase 12 — tiers and billing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 * **1. Nobody is ever locked out.** `requireEntitlement` gates writes. There is
 * no read gate and no export gate anywhere in this product, and `whatIsLost`
 * below exists to say so in the refusal itself — a customer whose card has
 * failed should learn in the same sentence that their data is safe.
 *
 * **2. The credit is applied exactly once.** Not "checked before applying" —
 * enforced by a unique index on the redemption, so a retried request loses to
 * the database rather than to a race. The provider call is idempotent on its own
 * key as well, because a lost response is indistinguishable from a failed one
 * and the caller will retry.
 *
 * **3. A webhook is an unauthenticated public request until it is verified.**
 * Verification happens before anything is believed, failures are recorded rather
 * than dropped, and every event is stored verbatim before it is acted on — a
 * billing dispute is answered from the record of what the provider said, not
 * from the state it left behind.
 */

import { authorise, AccessError } from '../domain/access.js';
import {
  PLANS, PLAN_KEYS, TERMS, STATES, WORKING_STATES, ENTITLEMENTS, NEVER_GATED,
  planFor, gate, seatCheck, creditEligibility, formatMinor,
  shouldApply, stateForEvent, capabilityName, trialState, TRIAL, BillingError,
  DEMONSTRATION_PROVIDER, isDemonstration,
} from '../domain/billing.js';
import { assertProvider } from '../billing/interface.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth?.userId ?? 'system', action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * The subscription an organisation is on.
 *
 * An organisation with no row is on FREE and ACTIVE. Materialising a row at
 * signup would be one more thing to go wrong, and the absence of a row is not an
 * error state — it is the commonest state in the product.
 */
export function subscriptionFor(ctx, orgId) {
  const row = ctx.db.findOne('subscription', { org_id: orgId });
  if (row) return row;

  // No row: either a trial that is still running or the free plan. Computed from
  // when the organisation was created rather than stored, so a trial cannot be
  // left switched on by a sweeper that stopped running — and cannot be extended
  // by anything other than editing the organisation's creation date.
  const org = ctx.db.get('organisation', orgId);
  const trial = trialState(org?.created_at, ctx.now());

  return trial.in_trial
    ? {
      org_id: orgId, plan_key: TRIAL.plan_key, state: 'ACTIVE', term: 'TRIAL',
      provider: null, provider_ref: null, seats: PLANS[TRIAL.plan_key].seats,
      current_period_end: trial.ends_at, last_event_at: null,
      implicit: true, trial,
    }
    : {
      org_id: orgId, plan_key: 'FREE', state: 'ACTIVE', term: 'NONE',
      provider: null, provider_ref: null, seats: PLANS.FREE.seats,
      current_period_end: null, last_event_at: null,
      implicit: true, trial,
    };
}

/**
 * Gate a write.
 *
 * Called by the service functions that produce something. Throws with a refusal
 * that says what plan has the thing and what has NOT been taken away.
 */
export function requireEntitlement(ctx, orgId, entitlement) {
  const subscription = subscriptionFor(ctx, orgId);
  const decision = gate(subscription, entitlement);
  if (decision.allowed) return decision;

  throw new BillingError(decision.code, decision.says, 402, {
    entitlement,
    capability: capabilityName(entitlement),
    plan: decision.plan,
    available_in: decision.available_in ?? null,
    // In the refusal itself. Somebody reading an error about billing is exactly
    // the person wondering whether their work is about to disappear.
    still_yours: whatIsLost(),
  });
}

/**
 * What a lapsed subscription costs you: nothing you already have.
 *
 * Returned with every billing refusal, because the question a person actually
 * has when they see one is not "which plan has this" but "have I lost my file".
 */
export const whatIsLost = () => ({
  lost: [],
  kept: NEVER_GATED,
  says: 'Nothing you have is affected. Every document, figure and record stays exactly where it is, '
      + 'you can keep reading all of it, and you can export the whole lot whenever you like — '
      + 'including after a subscription ends.',
});

export function status(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const subscription = subscriptionFor(ctx, orgId);
  const plan = planFor(subscription.plan_key) ?? PLANS.FREE;
  const members = ctx.db.count('membership', { org_id: orgId });

  const redemption = ctx.db.findOne('workbook_redemption', { org_id: orgId });
  const applied = redemption
    ? ctx.db.findOne('credit_application', { redemption_id: redemption.id })
    : null;

  return ok({
    plan: {
      key: plan.key, name: plan.name, purpose: plan.purpose,
      entitlements: plan.entitlements, seats: plan.seats,
    },
    state: subscription.state,
    term: subscription.term,
    // Shown on every page that names a plan. A grant that looks like a paid
    // subscription makes a revenue report a work of fiction.
    demonstration: isDemonstration(subscription),
    trial: subscription.term === 'TRIAL'
      ? { ...subscription.trial, plan: TRIAL.plan_key, days: TRIAL.days }
      : null,
    current_period_end: subscription.current_period_end,
    working: WORKING_STATES.includes(subscription.state),
    seats: seatCheck(subscription, members),
    // Every capability, and whether this organisation has it. A list of what you
    // cannot do is more useful than a plan name, and it is what a UI needs.
    capabilities: ENTITLEMENTS.map((key) => {
      const decision = gate(subscription, key);
      return {
        key, name: capabilityName(key),
        allowed: decision.allowed,
        reason: decision.allowed ? null : decision.code,
        available_in: decision.available_in ?? null,
      };
    }),
    credit: creditSummary(redemption, applied),
    never_gated: NEVER_GATED,
    ...whatIsLost(),
  });
}

function creditSummary(redemption, applied) {
  if (!redemption) return null;
  return {
    amount: formatMinor(redemption.credit_minor, redemption.credit_currency),
    amount_minor: redemption.credit_minor,
    currency: redemption.credit_currency,
    label: 'Credit for Before They Ask',
    applied: Boolean(applied),
    applied_at: applied?.created_at ?? null,
    // Said plainly because the alternative is somebody worrying about it.
    note: applied
      ? 'Applied to your subscription.'
      : 'Waiting for an annual subscription. It does not expire.',
  };
}

/** Where to go to subscribe. The provider takes the money; this product never sees a card. */
export function checkout(ctx, orgId, input, provider) {
  return usage.around(ctx, orgId, 'CHECKOUT_STARTED', () => doCheckout(ctx, orgId, input, provider));
}

function doCheckout(ctx, orgId, { plan_key, term }, provider) {
  authorise(membershipOf(ctx, orgId), 'own');
  const p = assertProvider(provider);

  const plan = planFor(plan_key);
  if (!plan) throw new BillingError('unknown_plan', `No plan called "${plan_key}".`, 400, { known: PLAN_KEYS });
  if (!plan.terms.includes(term)) {
    throw new BillingError('term_not_available',
      `${plan.name} is not offered ${String(term).toLowerCase()}.`, 400, { terms: plan.terms });
  }
  if (typeof p.checkoutUrl !== 'function') {
    throw new BillingError('no_checkout', 'This provider does not offer a checkout link.', 502);
  }

  audit(ctx, orgId, 'billing.checkout_started', 'organisation', orgId, { plan_key, term, provider: p.id });
  return ok({
    url: p.checkoutUrl({ planRef: plan.key, term, orgId }),
    plan: { key: plan.key, name: plan.name },
    term,
    // No price. The provider's checkout shows it, and showing a second copy here
    // is how a product ends up advertising a price it does not charge.
    note: 'The price is shown at checkout. Payment is handled by the provider — this product never '
        + 'sees or stores a card.',
  });
}

/**
 * Where to go to change or cancel a subscription.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SENTENCE IS THE POINT OF THIS FUNCTION
 *
 * Cancelling happens at the provider, so this product's only job in it is the
 * link. But a customer about to cancel a tool that holds four years of their
 * financial records is, at that exact moment, wondering what happens to them —
 * and until now the product answered that question only in a lede at the top of
 * a page they were scrolling past on their way out.
 *
 * So the answer travels with the link. It is the same sentence `whatIsLost`
 * gives a customer whose card has failed, for the same reason: the moment
 * somebody is worried about losing access is the moment to say they will not.
 *
 * It is also true, which is what makes it worth saying. An ended subscription
 * is read-only with a full export, enforced by `NEVER_GATED` and covered by
 * tests, not by a promise in a terms document.
 */
export function portal(ctx, orgId, provider) {
  authorise(membershipOf(ctx, orgId), 'own');
  const p = assertProvider(provider);

  const subscription = subscriptionFor(ctx, orgId);
  if (!subscription.provider_ref) {
    throw new BillingError('nothing_to_manage',
      'There is no subscription to change yet.', 409);
  }
  if (typeof p.portalUrl !== 'function') {
    throw new BillingError('no_portal',
      'This provider does not offer a self-service portal. Write to support and we will do it.', 502);
  }

  return ok({
    url: p.portalUrl({ providerRef: subscription.provider_ref }),
    ...whatIsLost(),
  });
}

// ──────────────────────────────────────────────────────────────── webhooks ──

/**
 * Handle a webhook.
 *
 * Deliberately not authorised by membership: the caller is a billing provider,
 * not a user. It is authorised by the signature, and by nothing else.
 */
export function handleWebhook(ctx, { rawBody, signature, headers = {} }, provider) {
  const p = assertProvider(provider);

  const verified = p.verify({ rawBody, signature, headers, secret: p.secret });
  if (!verified.ok) {
    // Recorded, not dropped. A run of these is either an attack or a rotated
    // secret, and both need to be visible to somebody.
    ctx.db.insert('billing_event', {
      org_id: null, provider: p.id,
      event_ref: `unverified-${ctx.now()}-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'VERIFICATION_FAILED',
      occurred_at: ctx.now(), payload: String(rawBody ?? '').slice(0, 2000),
      applied: 0, ignored_reason: verified.why, created_at: ctx.now(),
    });
    throw new BillingError('webhook_unverified',
      'This webhook could not be verified, so nothing was done with it.', 401, { why: verified.why });
  }

  let event;
  try {
    event = JSON.parse(String(rawBody));
  } catch {
    throw new BillingError('webhook_malformed', 'The webhook body is not JSON.', 400);
  }

  const eventRef = event.id ?? event.event_id ?? null;
  if (!eventRef) {
    throw new BillingError('webhook_unidentified',
      'The webhook carries no event id, so it cannot be deduplicated.', 400);
  }

  // Idempotent by the provider's own event id. Providers retry; this is what
  // makes the fifth delivery of an event do nothing at all.
  const seen = ctx.db.findOne('billing_event', { provider: p.id, event_ref: String(eventRef) });
  if (seen) {
    return ok({ applied: false, duplicate: true, event_ref: eventRef, note: 'Already handled.' });
  }

  const orgId = event.org_id ?? event.metadata?.org_id ?? null;
  const row = ctx.db.insert('billing_event', {
    org_id: orgId, provider: p.id, event_ref: String(eventRef),
    event_type: String(event.type ?? 'unknown'),
    occurred_at: String(event.occurred_at ?? ctx.now()),
    // Verbatim. A dispute is answered from what the provider actually sent.
    payload: String(rawBody),
    applied: 0, ignored_reason: null, created_at: ctx.now(),
  });

  const outcome = applyEvent(ctx, event, row, p);
  ctx.db.update('billing_event', row.id, {
    applied: outcome.applied ? 1 : 0, ignored_reason: outcome.reason ?? null,
  });

  return ok({ ...outcome, event_ref: eventRef });
}

function applyEvent(ctx, event, row, provider) {
  const orgId = row.org_id;
  if (!orgId || !ctx.db.get('organisation', orgId)) {
    // Stored and ignored. An event for an organisation this instance does not
    // have is not an error — it is a webhook aimed at a different environment.
    return { applied: false, reason: 'no such organisation here' };
  }

  const nextState = stateForEvent(event.type);
  if (!nextState) {
    // Unmapped types leave the subscription alone. Guessing — treating an
    // unknown event as a cancellation — would turn a provider shipping a feature
    // into an outage for every customer.
    return { applied: false, reason: `nothing is mapped for "${event.type}"` };
  }

  const existing = ctx.db.findOne('subscription', { org_id: orgId });
  const ordering = shouldApply(event, existing);
  if (!ordering.apply) return { applied: false, reason: ordering.reason };

  const planKey = planFor(event.plan_key) ? event.plan_key : (existing?.plan_key ?? 'FREE');
  const term = TERMS.includes(event.term) ? event.term : (existing?.term ?? 'NONE');

  const fields = {
    org_id: orgId, plan_key: planKey, state: nextState, term,
    provider: provider.id,
    provider_ref: event.provider_ref ?? existing?.provider_ref ?? null,
    seats: planFor(planKey)?.seats ?? null,
    current_period_end: event.current_period_end ?? existing?.current_period_end ?? null,
    last_event_at: String(event.occurred_at ?? ctx.now()),
    started_at: existing?.started_at ?? ctx.now(),
    created_at: existing?.created_at ?? ctx.now(),
  };

  const subscription = existing
    ? ctx.db.update('subscription', existing.id, fields)
    : ctx.db.insert('subscription', fields);

  audit(ctx, orgId, 'billing.subscription_changed', 'subscription', subscription.id, {
    event_type: event.type, state: nextState, plan_key: planKey, term,
  });

  return { applied: true, state: nextState, plan_key: planKey, subscription_id: subscription.id };
}

// ─────────────────────────────────────────────────────── the workbook credit ──

/**
 * Apply the $147 credit.
 *
 * Two independent guards, because one is not enough:
 *
 *   · the unique index on `redemption_id`, which a retried request loses to even
 *     if two arrive at the same moment;
 *   · the provider call keyed on the redemption id, so even if this product
 *     somehow asked twice, the provider credits once.
 *
 * Checking "has it been applied?" and then applying it is the shape of every
 * double-spend that has ever happened.
 */
export async function applyWorkbookCredit(ctx, orgId, provider) {
  authorise(membershipOf(ctx, orgId), 'own');
  const p = assertProvider(provider);

  const redemption = ctx.db.findOne('workbook_redemption', { org_id: orgId });
  const subscription = ctx.db.findOne('subscription', { org_id: orgId });
  const already = redemption
    ? ctx.db.findOne('credit_application', { redemption_id: redemption.id })
    : null;

  const eligibility = creditEligibility({ redemption, subscription, alreadyApplied: already });
  if (!eligibility.eligible) {
    throw new BillingError(eligibility.code, eligibility.says, 409, {
      applied_at: eligibility.applied_at ?? null,
    });
  }

  // Keyed on the redemption, which is unique per workbook purchase. The same key
  // on a retry gets the same credit back rather than a second one.
  const idempotencyKey = `workbook-credit-${redemption.id}`;

  let providerResult;
  try {
    providerResult = await p.applyCredit({
      providerRef: subscription.provider_ref,
      amountMinor: eligibility.amount_minor,
      currency: eligibility.currency,
      reason: 'Credit for Before They Ask',
      idempotencyKey,
    });
  } catch (err) {
    // Nothing is recorded locally. A credit row written for a provider call that
    // failed would make the credit unusable for ever — the local guard would
    // refuse the retry that should have worked.
    throw new BillingError('credit_not_applied',
      `The provider could not apply the credit: ${err.message}. Nothing has been used up — try again.`,
      502);
  }

  let application;
  try {
    application = ctx.db.insert('credit_application', {
      org_id: orgId, redemption_id: redemption.id, subscription_id: subscription.id,
      amount_minor: eligibility.amount_minor, currency: eligibility.currency,
      provider: p.id, provider_ref: providerResult?.provider_ref ?? null,
      applied_by: ctx.auth.userId, created_at: ctx.now(),
    });
  } catch (err) {
    // The unique index fired, which means a concurrent request got there first.
    // The provider call was idempotent, so the customer has exactly one credit.
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      const existing = ctx.db.findOne('credit_application', { redemption_id: redemption.id });
      return ok({
        credit: presentCredit(existing),
        applied: false, already: true,
        note: 'This credit was already applied. It has not been used twice.',
      });
    }
    throw err;
  }

  audit(ctx, orgId, 'billing.credit_applied', 'credit_application', application.id, {
    amount_minor: eligibility.amount_minor, redemption_id: redemption.id,
  });

  return ok({
    credit: presentCredit(application),
    applied: true,
    note: `${formatMinor(eligibility.amount_minor, eligibility.currency)} credited against your `
        + 'annual subscription.',
  }, 201);
}

const presentCredit = (row) => (row ? {
  id: row.id,
  amount: formatMinor(row.amount_minor, row.currency),
  amount_minor: row.amount_minor,
  currency: row.currency,
  applied_at: row.created_at,
  provider_ref: row.provider_ref,
} : null);

// ───────────────────────────────────────────────────────────────── seats ──

/** Can another person be added? Never removes anybody who is already here. */
export function seatStatus(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const members = ctx.db.count('membership', { org_id: orgId });
  return ok(seatCheck(subscriptionFor(ctx, orgId), members));
}

export function requireSeat(ctx, orgId) {
  const members = ctx.db.count('membership', { org_id: orgId });
  const check = seatCheck(subscriptionFor(ctx, orgId), members);
  if (!check.allowed) {
    throw new BillingError(check.code, check.says, 402, {
      limit: check.limit, used: check.used, available_in: check.available_in,
      still_yours: whatIsLost(),
    });
  }
  return check;
}

// ─────────────────────────────────────────────────── demonstration grant ──

/**
 * The provider string that marks a subscription nobody paid for.
 *
 * A demonstration organisation has to be able to reach every part of the
 * product, including the parts a paying customer buys — a demonstration that
 * stops at a paywall demonstrates the paywall. So it gets a real subscription
 * row, on the top plan, with this in the provider column.
 *
 * It is a real row rather than a special case inside `gate` for one reason: a
 * special case inside the gate would be a second code path through the
 * authorisation logic, and a second code path through authorisation logic is how
 * every entitlement bug gets written. The gate keeps one path. What changes is
 * the data it reads.
 *
 * And it is marked rather than silent so that every page showing a plan can say
 * where it came from. An unmarked grant looks exactly like a paid subscription,
 * which turns a revenue report into a work of fiction.
 *
 * The constant and its predicate are defined in `domain/billing.js` and
 * re-exported here, so that the usage counter can ask the question without
 * importing this file.
 */
export { DEMONSTRATION_PROVIDER, isDemonstration };

/**
 * Put an organisation on the top plan without anybody paying.
 *
 * Owner only, and refused on an organisation that already has a subscription —
 * including a cancelled one, because overwriting a real billing row with a free
 * grant loses the record of what the customer actually bought.
 */
export function grantDemonstration(ctx, orgId, { reason = 'Worked example' } = {}) {
  const membership = membershipOf(ctx, orgId);
  authorise(membership, 'own');

  const existing = ctx.db.findOne('subscription', { org_id: orgId });
  if (existing) {
    if (isDemonstration(existing)) return ok({ subscription: existing, already: true });
    throw new BillingError('already_subscribed',
      'This organisation already has a subscription, which a demonstration grant will not overwrite.',
      409, { plan: existing.plan_key, state: existing.state });
  }

  const subscription = ctx.db.insert('subscription', {
    org_id: orgId, plan_key: 'FIRM', state: 'ACTIVE', term: 'NONE',
    provider: DEMONSTRATION_PROVIDER, provider_ref: `demo_${orgId}`,
    seats: PLANS.FIRM.seats, current_period_end: null, last_event_at: null,
    started_at: ctx.now(), created_at: ctx.now(),
  });

  // Recorded as an event like any other change of plan, so the billing history
  // for this organisation reads as what actually happened to it.
  ctx.db.insert('billing_event', {
    org_id: orgId, provider: DEMONSTRATION_PROVIDER, event_ref: `demo_${orgId}`,
    event_type: 'demonstration.granted', occurred_at: ctx.now(),
    payload: JSON.stringify({ reason }), applied: 1, ignored_reason: null,
    created_at: ctx.now(),
  });

  return ok({ subscription, already: false }, 201);
}

/** The plans, for a pricing page. Without prices, which the provider holds. */
export function plans(ctx) {
  void ctx;
  return ok({
    plans: PLAN_KEYS.map((key) => {
      const plan = PLANS[key];
      return {
        key, name: plan.name, purpose: plan.purpose,
        includes: plan.entitlements.map((e) => capabilityName(e)),
        seats: plan.seats,
        terms: plan.terms,
      };
    }),
    every_plan_includes: NEVER_GATED,
    states: STATES,
    note: 'Prices are shown at checkout, where the billing provider holds them. They are deliberately '
        + 'not duplicated here: a price stored in two places disagrees eventually, and the wrong copy '
        + 'is always the one the customer sees.',
  });
}

export { BillingError };
