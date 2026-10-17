/**
 * Recording usage, and reading it back.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO HALVES
 *
 * `record()` is called from the service functions — the capability boundary, so
 * that a capability is counted whether it was reached from a page, a form or a
 * future API. It takes an organisation and turns it into a cohort, which is the
 * last point at which this code knows which company it is. Nothing downstream
 * does.
 *
 * `report()` reads the counters. It takes a database rather than a `ctx`, and
 * there is no HTTP route that calls it — the only caller is `tools/usage.mjs`,
 * run by whoever operates the service. That is deliberate. A route would need an
 * authorisation rule, the product has no staff role to write one against, and an
 * operator report behind a role that does not exist yet is a 403 away from being
 * a customer-visible cross-organisation page. Out of band is simpler and cannot
 * be got wrong.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY RECORDING CANNOT FAIL A REQUEST
 *
 * A person uploading a document at 11pm before a deadline should not see it fail
 * because a counter could not be written. So a storage failure here is swallowed
 * and logged, never raised.
 *
 * A bad capability key is the opposite: it is a programming error, it is caught
 * before any storage is touched, and it throws loudly so that a test fails
 * rather than a metric silently splitting in two. The distinction is between
 * "the world went wrong" and "this code is wrong".
 *
 * Swallowing has a cost — a bug in the increment itself would be invisible — so
 * the increments are asserted directly in test/usage.test.js rather than left to
 * be noticed in production.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RETENTION
 *
 * The privacy policy says 24 months, then deleted. That promise is kept here,
 * once per process, rather than by a cron job somebody has to remember to set
 * up: a published retention period enforced by external scheduling is a
 * published retention period that breaks the first time the scheduler is
 * reinstalled. It costs one DELETE per process lifetime.
 */

import {
  CAPABILITIES, CAPABILITY_KEYS, OUTCOMES, COHORTS, RETENTION_DAYS,
  assertCapability, assertOutcome, dayOf, cutoffDay, cohortOf, triedSet, disclosure,
} from '../domain/usage.js';
import { isDemonstration, trialState, TRIAL, PLANS } from '../domain/billing.js';
import { authorise } from '../domain/access.js';

const ok = (body, status = 200) => ({ status, body });

export { CAPABILITIES, CAPABILITY_KEYS, OUTCOMES, COHORTS, disclosure };

// ───────────────────────────────────────────────────────────── recording ──

/** Set once per process, so retention runs once rather than on every call. */
let prunedThisProcess = false;

/**
 * Count one use of a capability.
 *
 * @param {object} ctx
 * @param {string} orgId
 * @param {string} capability  a key from the frozen catalogue
 * @param {{outcome?: string, ms?: number|null}} [options]
 * @returns {boolean} whether anything was written — false when the organisation
 *   has objected, or is a demonstration. Returned for the tests; no caller acts
 *   on it, because no caller should behave differently either way.
 */
export function record(ctx, orgId, capability, { outcome = 'DONE', ms = null } = {}) {
  // Validation first, and outside the try: a key that is not in the catalogue
  // must reach a developer, not a log file.
  assertCapability(capability);
  assertOutcome(outcome);

  try {
    const org = ctx.db.get('organisation', orgId);
    if (!org) return false;

    // The objection the privacy policy grants. Checked before anything is read
    // about the organisation's plan, so an opted-out organisation is not even
    // classified into a cohort.
    if (!analyticsOn(org)) return false;

    const subscription = subscriptionRow(ctx, org);
    const cohort = cohortOf(subscription, { demonstration: isDemonstration(subscription) });
    if (cohort === null) return false;

    const day = dayOf(ctx.now());
    const firstTime = markTried(ctx, org, capability);
    const duration = timedMs(capability, ms);

    bump(ctx, { day, capability, cohort, outcome }, { firstTime, ms: duration });
    pruneOnce(ctx, day);
    return true;
  } catch (err) {
    ctx.log?.warn?.('usage.record failed', { capability, outcome, message: err.message });
    return false;
  }
}

/**
 * Wrap a capability so that its outcome and duration are counted.
 *
 * One line at a call site instead of four, and — more to the point — one place
 * where an outcome is classified. Instrumented by hand, half the call sites
 * would count a billing refusal as a failure and the other half would not count
 * it at all, and the refusal column is the one worth reading.
 *
 * The rule: a 4xx is the product saying no, which is REFUSED. Anything else
 * thrown is the product breaking, which is FAILED. A refusal is a product
 * decision to review; a failure is a bug to fix. Counting them in one column
 * would hide the bugs behind the decisions.
 *
 * `refusedWhen` is for the capability that declines by returning rather than by
 * throwing — generation answers a document that is not ready with a 200 and a
 * list of reasons, and those are refusals however they travel.
 */
export function around(ctx, orgId, capability, fn, { refusedWhen = null } = {}) {
  const startedAt = Date.now();
  try {
    const result = fn();
    record(ctx, orgId, capability, {
      outcome: refusedWhen?.(result) ? 'REFUSED' : 'DONE',
      ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    record(ctx, orgId, capability, { outcome: outcomeFor(err), ms: Date.now() - startedAt });
    throw err;
  }
}

/** `around`, for a capability that returns a promise. */
export async function aroundAsync(ctx, orgId, capability, fn, { refusedWhen = null } = {}) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    record(ctx, orgId, capability, {
      outcome: refusedWhen?.(result) ? 'REFUSED' : 'DONE',
      ms: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    record(ctx, orgId, capability, { outcome: outcomeFor(err), ms: Date.now() - startedAt });
    throw err;
  }
}

const outcomeFor = (err) => {
  const status = Number(err?.status);
  return status >= 400 && status < 500 ? 'REFUSED' : 'FAILED';
};

/**
 * A duration is kept only for the capabilities declared as timed.
 *
 * Otherwise a stray `ms` passed at one call site puts a duration into a bucket
 * whose other call sites do not, and the mean becomes a mean of whichever half
 * happened to be instrumented.
 */
function timedMs(capability, ms) {
  if (CAPABILITIES[capability].timed !== true) return 0;
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Increment the bucket, creating it if this is its first event today.
 *
 * Find-then-write rather than an upsert, because the two dialects spell upsert
 * differently and the adapter interface is deliberately small. Two concurrent
 * first events race on the unique index; the loser re-reads and updates, which
 * is the one case the retry exists for.
 */
function bump(ctx, key, { firstTime, ms }) {
  const existing = ctx.db.findOne('usage_counter', key);
  if (existing) return apply(ctx, existing, { firstTime, ms });

  try {
    return ctx.db.insert('usage_counter', {
      ...key,
      events: 1,
      first_time: firstTime ? 1 : 0,
      ms_total: ms,
      ms_max: ms,
      created_at: ctx.now(),
    });
  } catch {
    const row = ctx.db.findOne('usage_counter', key);
    if (!row) throw new Error('usage bucket could neither be created nor found');
    return apply(ctx, row, { firstTime, ms });
  }
}

const apply = (ctx, row, { firstTime, ms }) => ctx.db.update('usage_counter', row.id, {
  events: row.events + 1,
  first_time: row.first_time + (firstTime ? 1 : 0),
  ms_total: row.ms_total + ms,
  ms_max: Math.max(row.ms_max, ms),
});

/**
 * Record that this organisation has now used this capability, and say whether
 * that was the first time ever.
 *
 * This is the only per-organisation state analytics keeps, and it is a set of
 * capability keys — not a log, not a timestamp, nothing that could reconstruct
 * an order of events. It lives on the organisation row so that deleting an
 * organisation deletes it, with no sweeper to forget.
 *
 * Two concurrent first uses can both read an absent key and both count a first
 * time. It is a count of adoption, off by one at most, once per capability per
 * organisation; locking a row to make it exact would be the wrong trade.
 */
function markTried(ctx, org, capability) {
  const tried = triedSet(org.tried);
  if (tried.has(capability)) return false;
  tried.add(capability);
  ctx.db.update('organisation', org.id, { tried: JSON.stringify([...tried]) });
  return true;
}

/** The subscription row as stored, or the implied one. */
function subscriptionRow(ctx, org) {
  const row = ctx.db.findOne('subscription', { org_id: org.id });
  if (row) return row;

  // Mirrors billing.subscriptionFor, which cannot be called from here without an
  // import cycle. Only two fields are read downstream — the term and the plan —
  // so this returns those rather than a whole fake subscription that would drift
  // from the real one.
  const trial = trialState(org.created_at, ctx.now());
  return trial.in_trial
    ? { org_id: org.id, plan_key: TRIAL.plan_key, term: 'TRIAL', provider: null }
    : { org_id: org.id, plan_key: 'FREE', term: 'NONE', provider: null };
}

/** Delete counters past the published retention period. Once per process. */
function pruneOnce(ctx, today) {
  if (prunedThisProcess) return;
  prunedThisProcess = true;
  prune(ctx.db, today);
}

/**
 * Drop every bucket older than the retention window.
 *
 * Exported so the operator tool can run it on demand and so a test can prove it
 * deletes the right rows. Takes a database rather than a `ctx` because it is
 * also called from outside a request.
 */
export function prune(db, today, days = RETENTION_DAYS) {
  const cutoff = cutoffDay(today, days);
  // `to` is exclusive of the cutoff day itself: a bucket dated exactly the
  // cutoff is the oldest day still inside the window, and deleting it would make
  // the retention period 729 days rather than the published 730.
  const doomed = db.range('usage_counter', 'day', { to: cutoff })
    .filter((row) => row.day < cutoff);
  for (const row of doomed) db.remove('usage_counter', row.id);
  return { cutoff, deleted: doomed.length };
}

// ──────────────────────────────────────────────────────── the opt-out ──

/** Whether an organisation is counted. Absent column means yes, by default. */
export const analyticsOn = (org) => org?.usage_analytics !== 0;

/**
 * Read the setting, with the generated list of what is recorded.
 *
 * The list comes from the catalogue rather than from prose written beside it, so
 * what the page shows and what the code counts cannot diverge.
 */
export function analyticsSetting(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const org = ctx.db.get('organisation', orgId);
  return ok({
    on: analyticsOn(org),
    retention_days: RETENTION_DAYS,
    recorded: disclosure(),
    says: analyticsOn(org)
      ? 'Counted. Which capabilities get used, and how long the slow ones take — in '
        + 'daily totals that carry no company, no person and no figure from your records.'
      : 'Not counted. Nothing about how this organisation uses RaiseRoom is being recorded.',
    never: [
      'Which company did it — the stored counts have no organisation on them',
      'Who did it',
      'Any figure from your records, or anything you have written',
      'Anything finer than a daily total',
    ],
  });
}

/**
 * Turn counting off, or back on.
 *
 * Owner only. It is a statement about the organisation rather than about one
 * person's preferences, and the policy frames it as the organisation objecting.
 */
export function setAnalytics(ctx, orgId, on) {
  authorise(membershipOf(ctx, orgId), 'own');
  const next = on ? 1 : 0;
  ctx.db.update('organisation', orgId, { usage_analytics: next });

  // Written to the organisation's own audit log, because a change to what is
  // collected about them is exactly the kind of thing they should be able to see
  // somebody made, and when.
  ctx.db.insert('audit_log', {
    org_id: orgId,
    actor_id: ctx.auth.userId,
    action: on ? 'usage.analytics_on' : 'usage.analytics_off',
    target_type: 'organisation',
    target_id: orgId,
    metadata: null,
    created_at: ctx.now(),
  });

  return analyticsSetting(ctx, orgId);
}

const membershipOf = (ctx, orgId) =>
  ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

// ──────────────────────────────────────────────────────────── reporting ──

/**
 * What the counters say, over a window.
 *
 * Returns one entry per capability — including the ones with nothing in them,
 * because a capability nobody has ever used is the most actionable row in the
 * report and leaving it out is how it stays unnoticed.
 */
export function report(db, { from, to, days = 30 } = {}) {
  const until = to ? dayOf(to) : dayOf(new Date().toISOString());
  const since = from ? dayOf(from) : cutoffDay(until, days);

  const rows = db.range('usage_counter', 'day', { from: since, to: until });

  const blank = () => ({ DONE: 0, REFUSED: 0, FAILED: 0 });
  const byCapability = new Map(CAPABILITY_KEYS.map((key) => [key, {
    key,
    label: CAPABILITIES[key].label,
    timed: CAPABILITIES[key].timed === true,
    // Attempts, not successes: a capability tried twice and refused twice reads
    // as 2 and 2 rather than as 0 and 2, which is the shape that shows somebody
    // wanted it.
    events: 0,
    first_time: 0,
    outcomes: blank(),
    cohorts: Object.fromEntries(COHORTS.map((c) => [c, 0])),
    ms_total: 0,
    ms_max: 0,
  }]));

  for (const row of rows) {
    const entry = byCapability.get(row.capability);
    // A key no longer in the catalogue. Kept out of the report rather than
    // crashing it: the row is historical and the catalogue has moved on.
    if (!entry) continue;
    entry.events += row.events;
    entry.first_time += row.first_time;
    if (entry.outcomes[row.outcome] !== undefined) entry.outcomes[row.outcome] += row.events;
    if (entry.cohorts[row.cohort] !== undefined) entry.cohorts[row.cohort] += row.events;

    // Timings from the successful bucket only. A refusal is decided in a
    // millisecond or two, so folding refusals into the mean makes a slow
    // capability look fast exactly when it is being refused most — which is the
    // moment somebody would be reading the number.
    if (row.outcome === 'DONE') {
      entry.ms_total += row.ms_total;
      entry.ms_max = Math.max(entry.ms_max, row.ms_max);
    }
  }

  const capabilities = [...byCapability.values()].map((entry) => ({
    ...entry,
    // Null rather than zero when there is nothing to average: a mean of no
    // observations is not fast, it is unknown.
    ms_mean: entry.timed && entry.outcomes.DONE > 0
      ? Math.round(entry.ms_total / entry.outcomes.DONE)
      : null,
  }));

  return {
    from: since,
    to: until,
    days_covered: new Set(rows.map((r) => r.day)).size,
    capabilities,
    untouched: capabilities.filter((c) => c.events === 0).map((c) => c.key),
    refusals: capabilities
      .filter((c) => c.outcomes.REFUSED > 0)
      .sort((a, b) => b.outcomes.REFUSED - a.outcomes.REFUSED)
      .map((c) => ({ key: c.key, label: c.label, refused: c.outcomes.REFUSED })),
    failures: capabilities
      .filter((c) => c.outcomes.FAILED > 0)
      .sort((a, b) => b.outcomes.FAILED - a.outcomes.FAILED)
      .map((c) => ({ key: c.key, label: c.label, failed: c.outcomes.FAILED })),
    // Said in the report itself, so that anybody who opens it and starts
    // wondering which customer is behind a number has the answer immediately.
    scope: 'Daily totals across all organisations that have not opted out. No organisation, '
         + 'person or record is identified in the stored data, so no figure here can be '
         + 'attributed to a customer.',
  };
}

/** Plan keys, for the tool's header. Keeps the report honest about the cohorts. */
export const planNames = () => Object.fromEntries(Object.keys(PLANS).map((k) => [k, PLANS[k].name]));
