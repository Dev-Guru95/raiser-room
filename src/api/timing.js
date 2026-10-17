/**
 * Phase 3 — the timing instrument.
 *
 * Milestones are recorded as a side effect of work that was going to happen
 * anyway, so nothing depends on anyone remembering to log. `recordMilestone` is
 * deliberately forgiving: it never throws into a caller's path, because a
 * failure to record a timestamp must never be able to fail a user's action.
 * The measurement is for us; the work is for them.
 */

import { authorise, AccessError } from '../domain/access.js';
import {
  MILESTONES, INTERVALS, assertMilestone, intervalsFor, cohortClaim,
  assertSingleClock, MIN_SAMPLE, TimingError,
} from '../domain/timing.js';

const ok = (body, status = 200) => ({ status, body });
const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * Record a milestone. First occurrence wins; later calls are no-ops.
 *
 * Returns the row, or null if it was already recorded or could not be written.
 * Callers ignore the return value — that is the point.
 */
export function recordMilestone(ctx, orgId, key, at = null) {
  try {
    const spec = assertMilestone(key);
    if (ctx.db.findOne('timing_event', { org_id: orgId, milestone: key })) return null;
    return ctx.db.insert('timing_event', {
      org_id: orgId, milestone: key, clock: spec.clock,
      occurred_at: at ?? ctx.now(), created_at: ctx.now(),
    });
  } catch {
    // A unique-index race, or an unknown milestone from a caller that has not
    // been updated. Neither is worth failing a user's action over.
    return null;
  }
}

/** This organisation's own timings. */
export function timingFor(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const events = ctx.db.find('timing_event', { org_id: orgId })
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));

  return ok({
    milestones: MILESTONES.map((m) => {
      const hit = events.find((e) => e.milestone === m.key);
      return { ...m, reached_at: hit?.occurred_at ?? null };
    }),
    intervals: intervalsFor(events),
    // Said on the organisation's own view, because one company's timeline is
    // not evidence about anybody else's.
    note: 'These are your own timings. They are not a benchmark and nothing is compared against '
        + 'other organisations.',
  });
}

/**
 * A measured claim about an interval — or an honest refusal.
 *
 * `samples` is supplied by the caller rather than queried here, because
 * aggregating across organisations is a cross-organisation read and this
 * codebase does not do those casually. In production this is fed by an
 * analytics job on an anonymised export, never by a query that can see a
 * company's identity.
 */
export function measuredClaim(ctx, intervalRef, samples, { minSample = MIN_SAMPLE } = {}) {
  if (!ctx?.auth?.isInternal) {
    // A tenant cannot ask what other tenants' timings look like. There is no
    // benchmarking feature, and this is where that stays true.
    throw new AccessError('not_found', 404);
  }
  return ok(cohortClaim(intervalRef, samples, { minSample }));
}

export { INTERVALS, assertSingleClock, TimingError };
