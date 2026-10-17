/**
 * Plans, entitlements, and what happens when somebody stops paying.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROMISE THAT SHAPES THIS FILE
 *
 * **An expired subscription never takes anything away.** Not a document, not a
 * fact, not an audit row, not the ability to take all of it elsewhere.
 *
 * This is a commercial decision as much as an ethical one, and it is worth being
 * explicit about why it is built as a structural guarantee rather than a policy.
 * A company that stops paying for RaiseRoom has usually stopped because the raise
 * is over — they will be back in two years with a different raise, or they will
 * be acquired and their acquirer will ask what this tool was. A product that
 * holds their diligence file hostage converts that into a support ticket, a
 * chargeback and a review. One that hands it over gets recommended.
 *
 * So `gate()` below has exactly one job: deciding whether a WRITE may proceed.
 * There is no read gate and no export gate, and there is no plan or state in
 * which either returns false — not because somebody remembered to allow it, but
 * because the function that would refuse does not exist.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND THE ONE ABOUT PRICES
 *
 * **There is no price in this file.** The billing provider holds the plan and
 * what it costs. A price kept in two places disagrees eventually, and the copy
 * that is wrong is always the one shown to the customer.
 *
 * Which features sit in which plan, and how many seats each has, ARE commercial
 * decisions — they are made here because they are structural, they are marked as
 * the owner's to change, and every change to them is caught by a test.
 */

export class BillingError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Everything a plan can unlock.
 *
 * Deliberately a short list of capabilities that already exist, rather than a
 * taxonomy invented for pricing. A feature flag with nothing behind it is a
 * promise on a pricing page that the product cannot keep.
 */
export const ENTITLEMENTS = Object.freeze([
  'GENERATE_ARTIFACTS',   // Phase 5 — produce documents
  'LIVE_SHARING',         // Phase 8 — per-recipient links
  'ADVISOR',              // Phase 4 — ask, and Phase 10 — propose
  'OPERATING_CADENCE',    // Phase 6 — the forecast ledger
  'LOCALISATION',         // Phase 11 — documents in another language
  'CUSTOM_BRAND',         // Phase 9 — the company's own colours
  'PORTFOLIO',            // Phase 12 — hold several companies
]);

/**
 * What is NEVER gated, in any plan or any state.
 *
 * Listed so that the promise is a thing in the code rather than a sentence in a
 * README. The test suite asserts no plan withholds any of these, which means
 * adding one to a paid tier breaks the build.
 */
export const NEVER_GATED = Object.freeze([
  'READ_EVERYTHING',      // every view of their own data
  'EXPORT_EVERYTHING',    // and taking it away
  'RECORD_FACTS',         // their own records, which they are mid-way through
  'UPLOAD_DOCUMENTS',
  'RUN_ASSESSMENT',
  'BUILD_DATA_ROOM',
]);

/**
 * The plans.
 *
 * Two modes on one spine, as the roadmap has it: a preparation subscription for
 * a company running a raise, and a continuing subscription for a company
 * building the evidence that makes the next one easy. Priced differently
 * because they are used differently — and priced in the billing provider, not
 * here.
 *
 * EVIDENCE is a superset of PREPARE rather than a parallel track. A company
 * moving from "we are raising" to "we are keeping records" should not discover
 * it has lost the ability to generate a document.
 *
 * WHICH FEATURE SITS IN WHICH PLAN IS A COMMERCIAL DECISION AND THE OWNER'S TO
 * CHANGE. This is the current configuration, not a law.
 */
export const PLANS = Object.freeze({
  FREE: {
    key: 'FREE',
    name: 'Free',
    purpose: 'Find out where you stand, and start the file.',
    // Everything in NEVER_GATED, and nothing else. A free account is a real
    // account: the assessment, the room, the facts and the export all work.
    entitlements: Object.freeze([]),
    seats: 2,
    terms: Object.freeze(['NONE']),
  },
  RAISEROOM: {
    key: 'RAISEROOM',
    name: 'RaiseRoom',
    purpose: 'One company, raising or selling, and the record that outlives it.',
    // Every paid capability except the portfolio, which is the only one that is
    // about more than one company. Deliberately not split into a "run a raise"
    // tier and a "keep the record" tier: the forecast ledger is worth nothing
    // until it has years in it, so putting it behind a second purchase means
    // nobody starts it during the raise, which is the only time they are paying
    // attention to this product at all.
    entitlements: Object.freeze([
      'GENERATE_ARTIFACTS', 'LIVE_SHARING', 'ADVISOR', 'LOCALISATION',
      'OPERATING_CADENCE', 'CUSTOM_BRAND',
    ]),
    seats: 10,
    terms: Object.freeze(['MONTHLY', 'ANNUAL']),
  },
  FIRM: {
    key: 'FIRM',
    name: 'Firm',
    purpose: 'Accelerators, funds and banks preparing several companies.',
    entitlements: Object.freeze([
      'GENERATE_ARTIFACTS', 'LIVE_SHARING', 'ADVISOR', 'LOCALISATION',
      'OPERATING_CADENCE', 'CUSTOM_BRAND', 'PORTFOLIO',
    ]),
    // Ten, like every other plan. A firm holding twenty companies gets ten
    // seats per company, not twenty seats here: the portfolio is a view onto
    // companies that invited it, and each of those companies has its own.
    seats: 10,
    terms: Object.freeze(['MONTHLY', 'ANNUAL']),
  },
});

export const PLAN_KEYS = Object.freeze(Object.keys(PLANS));
export const planFor = (key) => PLANS[key] ?? null;

export const TERMS = Object.freeze(['NONE', 'TRIAL', 'MONTHLY', 'ANNUAL']);

/**
 * What a brand-new organisation gets, and for how long.
 *
 * A COMMERCIAL DECISION, AND THE OWNER'S TO CHANGE. It is here because it has to
 * be somewhere, and this is the only place it is read from.
 *
 * The reasoning behind the default: a company signing up cannot tell whether
 * this product is worth paying for until it has generated something and looked
 * at it. A free tier that stops short of a single document asks them to buy on
 * description — and this product's whole argument is that a generated document
 * is unlike what they would otherwise produce. So a new organisation starts on
 * the preparation plan for a fortnight, which is long enough to run an
 * assessment, fill some of the room and generate a deck.
 *
 * The trial needs no row and no sweeper: it is computed from when the
 * organisation was created, so it cannot be left switched on by a job that
 * stopped running.
 */
export const TRIAL = Object.freeze({
  plan_key: 'RAISEROOM',
  days: 7,
});

/** Has an organisation's trial run out, as at `now`? */
export function trialState(orgCreatedAt, now, days = TRIAL.days) {
  if (!orgCreatedAt) return { in_trial: false, ends_at: null, days_left: 0 };
  const started = new Date(orgCreatedAt);
  if (Number.isNaN(started.getTime())) return { in_trial: false, ends_at: null, days_left: 0 };

  const ends = new Date(started);
  ends.setUTCDate(ends.getUTCDate() + days);
  const endsAt = ends.toISOString();

  const at = new Date(now);
  const left = Math.ceil((ends.getTime() - at.getTime()) / 86_400_000);
  return {
    in_trial: String(now) < endsAt,
    ends_at: endsAt,
    days_left: Math.max(0, left),
  };
}

/**
 * A subscription nobody paid for, marked as such.
 *
 * Pure, and down here rather than in the billing API, because two things need to
 * know about it and one of them is the usage counter — which must not import the
 * billing API, since the billing API records usage. A constant that lives in
 * whichever file first needed it is how an import cycle gets built.
 */
export const DEMONSTRATION_PROVIDER = 'demonstration';

export function isDemonstration(subscription) {
  return subscription?.provider === DEMONSTRATION_PROVIDER;
}

/**
 * Subscription states.
 *
 * PAST_DUE is a separate state from EXPIRED and behaves like ACTIVE, because a
 * failed card is usually an expiry date rather than a decision. Cutting a
 * company off mid-raise over a card that needs updating is how a product gets
 * replaced during the worst week of somebody's year.
 */
export const STATES = Object.freeze(['ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED']);

/** States in which paid features still work. */
export const WORKING_STATES = Object.freeze(['ACTIVE', 'PAST_DUE']);

/**
 * May this organisation use this capability right now?
 *
 * The ONLY gate in the product, and it only ever gates writing. Returns a
 * decision object rather than a boolean so that a refusal can say what to do
 * about it — "upgrade" and "your card needs updating" are different problems
 * with different buttons.
 */
export function gate(subscription, entitlement) {
  if (!ENTITLEMENTS.includes(entitlement)) {
    // A capability nobody has defined is a bug, not a refusal. Returning
    // "not allowed" would make a typo look like a billing problem.
    throw new BillingError('unknown_entitlement',
      `"${entitlement}" is not a capability any plan grants.`, 500, { known: ENTITLEMENTS });
  }

  const plan = planFor(subscription?.plan_key ?? 'FREE') ?? PLANS.FREE;
  const state = subscription?.state ?? 'ACTIVE';

  if (!plan.entitlements.includes(entitlement)) {
    return {
      allowed: false,
      code: 'not_in_plan',
      plan: plan.key,
      // Named rather than implied: a user should be able to see which plan has
      // the thing they are looking at without reading a pricing page.
      available_in: PLAN_KEYS.filter((k) => PLANS[k].entitlements.includes(entitlement)),
      says: `${capabilityName(entitlement)} is not part of ${plan.name}.`,
    };
  }

  if (!WORKING_STATES.includes(state)) {
    return {
      allowed: false,
      code: state === 'CANCELLED' ? 'subscription_cancelled' : 'subscription_expired',
      plan: plan.key,
      state,
      says: 'Your subscription has ended, so new documents and links are paused. '
          + 'Everything you have is still here, you can still read all of it, and you can export '
          + 'the lot at any time.',
    };
  }

  return { allowed: true, plan: plan.key, state };
}

const CAPABILITY_NAMES = Object.freeze({
  GENERATE_ARTIFACTS: 'Generating documents',
  LIVE_SHARING: 'Live sharing links',
  ADVISOR: 'The advisor',
  OPERATING_CADENCE: 'The forecast ledger',
  LOCALISATION: 'Documents in another language',
  CUSTOM_BRAND: 'Your own brand',
  PORTFOLIO: 'The portfolio view',
});

export const capabilityName = (key) => CAPABILITY_NAMES[key] ?? key;

/**
 * Seats, counted against the plan.
 *
 * Over the limit is a refusal to ADD somebody, never a removal of somebody who
 * is already there. Silently dropping a member because a plan changed would
 * lose a person their access to a data room mid-diligence.
 */
export function seatCheck(subscription, currentMembers) {
  const plan = planFor(subscription?.plan_key ?? 'FREE') ?? PLANS.FREE;
  // There was a branch here for `plan.seats === null`, meaning a plan that does
  // not cap seats. Every plan caps them now — ten, on all three — so nothing
  // could reach it. Deleted rather than kept as defence: an unreachable branch
  // cannot be tested, and an untested branch that looks like a safety net is
  // worse than no branch, because the next person trusts it.
  // `test/billing.test.js` pins the rule itself: every plan carries a number.
  if (currentMembers < plan.seats) {
    return { allowed: true, limit: plan.seats, used: currentMembers, remaining: plan.seats - currentMembers };
  }
  return {
    allowed: false,
    code: 'seat_limit',
    limit: plan.seats,
    used: currentMembers,
    says: `${plan.name} includes ${plan.seats} ${plan.seats === 1 ? 'seat' : 'seats'}, and they are all `
        + 'in use. Nobody loses access — this only stops a new person being added.',
    available_in: PLAN_KEYS.filter((k) => PLANS[k].seats === null || PLANS[k].seats > plan.seats),
  };
}

// ──────────────────────────────────────────────────────── the workbook credit ──

/**
 * Whether the $147 credit can go against this subscription.
 *
 * Annual only, and once. "Applied to your first annual subscription" is what the
 * workbook says, and the workbook is a document somebody bought — so the rule it
 * states is the rule, not a starting position.
 */
export function creditEligibility({ redemption, subscription, alreadyApplied }) {
  if (!redemption) {
    return { eligible: false, code: 'no_redemption', says: 'No workbook has been redeemed here.' };
  }
  if (alreadyApplied) {
    return {
      eligible: false, code: 'already_applied',
      says: 'This credit has already been applied.',
      applied_at: alreadyApplied.created_at,
    };
  }
  if (!subscription) {
    return { eligible: false, code: 'no_subscription', says: 'There is no subscription to apply it to.' };
  }
  if (subscription.term !== 'ANNUAL') {
    return {
      eligible: false, code: 'not_annual',
      says: 'The workbook credit goes against an annual subscription. It stays available until you '
          + 'take one — it does not expire.',
    };
  }
  if (!WORKING_STATES.includes(subscription.state)) {
    return {
      eligible: false, code: 'subscription_not_active',
      says: 'This subscription is not running, so there is nothing to credit yet.',
    };
  }
  return {
    eligible: true,
    amount_minor: redemption.credit_minor,
    currency: redemption.credit_currency,
  };
}

/**
 * A money amount, written out.
 *
 * Minor units in, string out, and never a float in between. 14700 is $147.00;
 * computing that as 14700/100 and formatting the result is how a billing system
 * eventually shows somebody $146.99.
 */
export function formatMinor(minor, currency = 'USD') {
  const n = Number(minor);
  if (!Number.isInteger(n)) {
    throw new BillingError('bad_amount', 'money is counted in whole minor units', 500);
  }
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const part = String(abs % 100).padStart(2, '0');
  const symbol = { USD: '$', GBP: '£', EUR: '€' }[currency] ?? '';
  const body = `${symbol}${whole.toLocaleString('en-US')}.${part}`;
  return negative ? `(${body})` : body;
}

// ──────────────────────────────────────────────── the provider's event clock ──

/**
 * Should this event be applied, given what we already know?
 *
 * Billing providers retry, and they deliver out of order. A `cancelled` webhook
 * arriving after a `renewed` would otherwise lock an account that had just paid,
 * and the customer's first indication would be a refusal in the middle of their
 * raise.
 *
 * So state changes are ordered by the PROVIDER's clock, not by arrival.
 */
export function shouldApply(event, subscription) {
  if (!event?.occurred_at) {
    return { apply: false, reason: 'event carries no timestamp, so it cannot be ordered' };
  }
  if (!subscription?.last_event_at) return { apply: true };

  if (String(event.occurred_at) < String(subscription.last_event_at)) {
    return {
      apply: false,
      reason: `this event is older than the last one applied (${subscription.last_event_at}), `
            + 'so applying it would undo something newer',
    };
  }
  return { apply: true };
}

/**
 * The state an event moves a subscription to.
 *
 * An event type nobody has mapped leaves the subscription alone and is recorded
 * as ignored. Guessing — treating an unknown event as a cancellation, say —
 * would turn a provider's new feature into an outage for every customer.
 */
export const EVENT_STATES = Object.freeze({
  'subscription.created': 'ACTIVE',
  'subscription.renewed': 'ACTIVE',
  'subscription.payment_succeeded': 'ACTIVE',
  'subscription.payment_failed': 'PAST_DUE',
  'subscription.past_due': 'PAST_DUE',
  'subscription.expired': 'EXPIRED',
  'subscription.cancelled': 'CANCELLED',
});

export const stateForEvent = (type) => EVENT_STATES[type] ?? null;
