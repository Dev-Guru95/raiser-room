/**
 * Gap generation and sequencing.
 *
 * A score is a diagnosis. The gap register is the part that changes the score,
 * and its two load-bearing rules are both counter-intuitive:
 *
 *   1. Fix order is NOT score order. Low scores are not equally urgent, and
 *      some fixes unblock others.
 *   2. Owner capacity is a real constraint. A register where one person owns
 *      seven items is not a plan, it is a queue with one person in it.
 */

import { criterionByRef } from './criteria.js';

export const GAP_CATEGORIES = Object.freeze(['BLOCKER', 'LONG_LEAD', 'THIRD_PARTY', 'CHEAP', 'ROOM']);

/** Lower sorts first. This encodes the sequencing argument. */
const PRIORITY = Object.freeze({
  BLOCKER: 0,      // prerequisites — everything else references them
  LONG_LEAD: 1,    // months, not weeks. These set your earliest start date
  THIRD_PARTY: 2,  // someone else's cooperation, which decreases once a deal is public
  CHEAP: 3,        // a competent person, two focused weeks
  ROOM: 4,         // build it once the contents exist
});

/**
 * What to call a category in front of a person.
 *
 * The enum names are for code. Shown to a founder, `CHEAP` reads as
 * "unimportant", which is the exact opposite of what it means here — it means a
 * competent person could clear it in two focused weeks, so it is among the
 * best-value work on the list. A label that inverts its own meaning is worse
 * than no label.
 */
export const CATEGORY_LABEL = Object.freeze({
  BLOCKER: 'Blocks other work',
  LONG_LEAD: 'Months, not weeks',
  THIRD_PARTY: 'Needs someone else',
  CHEAP: 'Two focused weeks',
  ROOM: 'Build the room last',
});

export const categoryLabel = (category) => CATEGORY_LABEL[category] ?? String(category ?? '');

export const CATEGORY_RATIONALE = Object.freeze({
  BLOCKER: 'Blocks other work. Goes first regardless of its score.',
  LONG_LEAD: 'Takes months. Start now even if the score is not the lowest — this sets your earliest realistic go-to-market date.',
  THIRD_PARTY: 'Needs someone else to cooperate, and their willingness falls once a transaction is public.',
  CHEAP: 'A competent person and two focused weeks. Do these in a block.',
  ROOM: 'Build the room once the contents exist. A tidy structure full of placeholders is worse than no room.',
});

/**
 * Default category per criterion, from how the work actually behaves.
 * A user may override; this is the starting point, not a verdict.
 */
const DEFAULT_CATEGORY = Object.freeze({
  '1.1': 'BLOCKER',     '1.2': 'CHEAP',      '1.3': 'THIRD_PARTY', '1.4': 'CHEAP',
  '2.1': 'LONG_LEAD',   '2.2': 'CHEAP',      '2.3': 'CHEAP',       '2.4': 'LONG_LEAD',
  '3.1': 'CHEAP',       '3.2': 'CHEAP',      '3.3': 'CHEAP',       '3.4': 'CHEAP',
  '4.1': 'CHEAP',       '4.2': 'CHEAP',      '4.3': 'CHEAP',       '4.4': 'THIRD_PARTY',
  '5.1': 'THIRD_PARTY', '5.2': 'THIRD_PARTY','5.3': 'CHEAP',       '5.4': 'CHEAP',
  '6.1': 'THIRD_PARTY', '6.2': 'CHEAP',      '6.3': 'LONG_LEAD',   '6.4': 'THIRD_PARTY',
  '7.1': 'CHEAP',       '7.2': 'CHEAP',      '7.3': 'CHEAP',       '7.4': 'CHEAP',
  '8.1': 'ROOM',        '8.2': 'ROOM',       '8.3': 'ROOM',        '8.4': 'ROOM',
});

/** Scores at or below this generate a gap. */
export const GAP_THRESHOLD = 3;

/** No individual should hold more than this many open gaps at once. */
export const OWNER_CAPACITY = 3;

/**
 * Derive gaps from a scored assessment.
 * Returns them already in fix order.
 */
export function deriveGaps(scored) {
  const out = [];
  for (const d of scored.domains) {
    for (const [ref, value] of Object.entries(d.criteria)) {
      if (value === null || value > GAP_THRESHOLD) continue;
      const criterion = criterionByRef(ref);
      const category = DEFAULT_CATEGORY[ref] ?? 'CHEAP';
      out.push({
        criterion_ref: ref,
        domain: d.domain,
        score: value,
        category,
        description: criterion.text,
        // "Done when" must be observable. "Improve the management accounts" is
        // not a finish line; the criterion restated as an outcome is.
        done_when: criterion.text,
        rationale: CATEGORY_RATIONALE[category],
      });
    }
  }
  return sortGaps(out);
}

/** Fix order: category first, then severity, then domain weight. */
export function sortGaps(gaps) {
  return [...gaps].sort((a, b) =>
    PRIORITY[a.category] - PRIORITY[b.category] ||
    a.score - b.score ||
    a.domain - b.domain ||
    String(a.criterion_ref).localeCompare(String(b.criterion_ref)));
}

/**
 * Owner capacity check.
 * Returns the owners who are over capacity, with their open gap counts.
 */
export function overCapacityOwners(openGaps, limit = OWNER_CAPACITY) {
  const counts = new Map();
  for (const g of openGaps) {
    if (!g.owner_user_id) continue;
    counts.set(g.owner_user_id, (counts.get(g.owner_user_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > limit)
    .map(([owner_user_id, open]) => ({
      owner_user_id,
      open,
      limit,
      detail: `${open} open gaps against one owner. Above ${limit} this is a queue, not a plan — ` +
              'it will run at the speed of their worst week.',
    }))
    .sort((a, b) => b.open - a.open);
}

/** Gaps with no named owner. An unowned gap does not get fixed. */
export const unownedGaps = (openGaps) => openGaps.filter((g) => !g.owner_user_id);

/** Gaps past their due date. */
export const overdueGaps = (openGaps, asOf) =>
  openGaps.filter((g) => g.due_date && !g.closed_at && String(g.due_date) < String(asOf));
