/**
 * Operational analytics — the catalogue of what gets counted.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE QUESTION THIS ANSWERS, AND THE ONE IT REFUSES TO
 *
 * It answers: which capabilities does anybody use, which does nobody try, where
 * does the product refuse people, and what is slow. Those are the questions a
 * small team has to answer to decide what to build next, and the alternative to
 * answering them with counts is answering them with opinions.
 *
 * It refuses: anything about a particular company. Not as a policy somebody
 * administers — the counter rows carry no organisation, no person, and no time
 * finer than a day, so the question has no answer rather than a forbidden one.
 * That is the same technique as the frozen `Fact.source` enum with no
 * `AI_GENERATED` in it: make the wrong thing unrepresentable instead of
 * unauthorised.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE CATALOGUE IS FROZEN AND LIVES HERE
 *
 * A `capability` string invented at a call site is a dimension nobody declared,
 * and the first typo becomes a second row that quietly splits a metric in two.
 * So a key not in this catalogue throws. The catalogue also carries the words
 * shown to the customer on the visibility page — the list of what is recorded is
 * GENERATED from this object rather than written out beside it, so the published
 * list cannot drift from what the code actually counts. A privacy disclosure
 * maintained by hand is a privacy disclosure that is wrong within two releases.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY ABSENT
 *
 * No page views. The policy reserved them; the product does not take them. A
 * write per page view is a cost paid on every request to learn something the
 * capability counts already imply, and the narrower collection is the one worth
 * having.
 *
 * No distribution of timings. A sum, a count and a maximum give a mean and a
 * worst case. A median or a 95th percentile needs the individual timings, and
 * those are exactly what has just been decided not to keep.
 *
 * No funnel, no session, no sequence. Reconstructing an order of events needs
 * per-person state over time, which is the profile the policy says is not built.
 */

/**
 * Every capability that is counted.
 *
 *   label — what it is, in the customer's words. Shown on the visibility page.
 *   why   — what knowing it is for. Also shown, because "we collect usage data"
 *           with no reason attached is the sentence everybody distrusts.
 *   timed — whether a duration is recorded. Only the slow things are timed.
 */
export const CAPABILITIES = Object.freeze({
  ASSESSMENT_SCORED: Object.freeze({
    label: 'Answering a readiness question',
    why: 'Whether people finish the assessment or stop part way through',
  }),
  ASSESSMENT_COMPLETED: Object.freeze({
    label: 'Finishing a readiness assessment',
    why: 'How many assessments are completed rather than abandoned',
  }),
  GAP_UPDATED: Object.freeze({
    label: 'Assigning or dating a gap',
    why: 'Whether the gap list is worked through or only read',
  }),
  GAP_CLOSED: Object.freeze({
    label: 'Closing a gap',
    why: 'Whether the product actually helps anything get finished',
  }),
  DOCUMENT_UPLOADED: Object.freeze({
    label: 'Uploading a document',
    why: 'How much material a data room holds, and how often an upload fails',
  }),
  EXTRACTION_RUN: Object.freeze({
    label: 'Reading figures out of a document',
    why: 'Whether extraction is used, and how long it takes',
    timed: true,
  }),
  EXTRACTION_DECIDED: Object.freeze({
    label: 'Accepting or rejecting an extracted figure',
    why: 'Whether extracted figures are reviewed or ignored — the review step is '
       + 'the one that makes a figure trustworthy, so it matters whether it happens',
  }),
  TRANSFER_SHEET_IMPORTED: Object.freeze({
    label: 'Transcribing a workbook transfer sheet',
    why: 'Whether the workbook route into the product is used at all',
  }),
  FACT_RECORDED: Object.freeze({
    label: 'Recording a figure',
    why: 'How much of a fact store is typed in by hand rather than extracted',
  }),
  CONFLICT_RESOLVED: Object.freeze({
    label: 'Settling two figures that disagree',
    why: 'Whether contradictions get resolved, and how many there are to resolve',
  }),
  PROSE_WRITTEN: Object.freeze({
    label: 'Writing a passage',
    why: 'Whether the writing step is used or skipped',
  }),
  ARTIFACT_GENERATED: Object.freeze({
    label: 'Generating a document',
    why: 'Which documents are worth generating, which nobody wants, and how long '
       + 'generation takes',
    timed: true,
  }),
  ARTIFACT_RELEASED: Object.freeze({
    label: 'Marking a document as sent',
    why: 'Whether generated documents are actually used outside the product',
  }),
  TRANSLATION_WRITTEN: Object.freeze({
    label: 'Drafting a translation',
    why: 'Which languages are asked for',
    timed: true,
  }),
  TRANSLATION_DECIDED: Object.freeze({
    label: 'Approving or rejecting a translation',
    why: 'How much machine drafting survives review',
  }),
  SHARE_CREATED: Object.freeze({
    label: 'Creating a share link',
    why: 'Whether companies share out of the product or export and send a file',
  }),
  SHARE_OPENED: Object.freeze({
    label: 'A recipient opening a share link',
    why: 'Whether share links are opened by the people they were sent to',
  }),
  SHARE_QUESTION_ASKED: Object.freeze({
    label: 'A recipient asking a question through a link',
    why: 'Whether the question log is used',
  }),
  QUESTION_ANSWERED: Object.freeze({
    label: 'Answering a recipient question',
    why: 'Whether questions get answered, and so whether the log is worth having',
  }),
  ADVISOR_ASKED: Object.freeze({
    label: 'Asking the advisor a question',
    why: 'How much the advisor is used, how often it declines, and how slow it is',
    timed: true,
  }),
  ACTION_PROPOSED: Object.freeze({
    label: 'The advisor proposing a change',
    why: 'Whether proposals are generated',
  }),
  ACTION_CONFIRMED: Object.freeze({
    label: 'Confirming or rejecting a proposed change',
    why: 'What proportion of proposals a person agrees with — if it were low, the '
       + 'feature would be making work rather than saving it',
  }),
  FORECAST_LOCKED: Object.freeze({
    label: 'Locking a forecast',
    why: 'Whether the operating cadence is used past the first forecast',
  }),
  PERIOD_CLOSED: Object.freeze({
    label: 'Closing a period',
    why: 'Whether companies keep the cadence going month after month',
  }),
  VARIANCE_EXPLAINED: Object.freeze({
    label: 'Explaining a variance',
    why: 'Whether variances are explained or left sitting',
  }),
  BRAND_SET: Object.freeze({
    label: 'Setting document branding',
    why: 'Whether branding is worth the build',
  }),
  PORTFOLIO_INVITED: Object.freeze({
    label: 'Letting an investor or accelerator see progress',
    why: 'Whether portfolio visibility is used',
  }),
  EXPORT_TAKEN: Object.freeze({
    label: 'Exporting everything',
    why: 'How often the export is used — a promise nobody exercises is a promise '
       + 'that may have quietly broken',
  }),
  CHECKOUT_STARTED: Object.freeze({
    label: 'Starting checkout',
    why: 'How many people reach the payment page',
  }),
});

/** Stable order for anything that lists the catalogue. */
export const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITIES));

/**
 * What happened.
 *
 * REFUSED and FAILED are the half worth reading. A capability with a high
 * refusal count is a capability the product is gating in somebody's way; a
 * capability with failures is broken for somebody who has not written in.
 */
export const OUTCOMES = Object.freeze(['DONE', 'REFUSED', 'FAILED']);

/**
 * The only grouping dimension besides the capability itself.
 *
 * Coarse on purpose. A trial is its own cohort rather than folded into the plan
 * it trials, because what a trial user does before deciding is the single most
 * useful thing in here and plan key alone hides it.
 */
export const COHORTS = Object.freeze(['FREE', 'TRIAL', 'RAISEROOM', 'FIRM']);

/** How long counters are kept. Stated in the privacy policy as 24 months. */
export const RETENTION_DAYS = 730;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'usage_catalogue';
  }
}

/** A key not in the catalogue is a programming error, not a bad input. */
export function assertCapability(key) {
  if (!Object.hasOwn(CAPABILITIES, key)) {
    throw new UsageError(`"${key}" is not in the usage catalogue (src/domain/usage.js)`);
  }
  return key;
}

export function assertOutcome(outcome) {
  if (!OUTCOMES.includes(outcome)) {
    throw new UsageError(`"${outcome}" is not a usage outcome; expected one of ${OUTCOMES.join(', ')}`);
  }
  return outcome;
}

/** The UTC date a timestamp falls in. The finest resolution anything is kept at. */
export function dayOf(iso) {
  const day = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UsageError(`cannot read a day from "${iso}"`);
  return day;
}

/** The first day still inside the retention window, given today. */
export function cutoffDay(iso, days = RETENTION_DAYS) {
  const at = new Date(`${dayOf(iso)}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return dayOf(at.toISOString());
}

/**
 * Which cohort a subscription row counts as.
 *
 * Returns null for a demonstration grant, which is the signal not to record at
 * all. The worked example is driven by a seeder and would otherwise be the
 * busiest account in the product by an order of magnitude.
 */
export function cohortOf(subscription, { demonstration = false } = {}) {
  if (demonstration) return null;
  if (!subscription) return 'FREE';
  if (subscription.term === 'TRIAL') return 'TRIAL';
  const plan = subscription.plan_key;
  return COHORTS.includes(plan) ? plan : 'FREE';
}

/**
 * Parse the set of capabilities an organisation has already used.
 *
 * Tolerant of null, of a string, and of nonsense, because this value only ever
 * decides whether a first-time counter is incremented. A corrupt value that
 * threw here would take down the capability it was recording.
 */
export function triedSet(value) {
  if (!value) return new Set();
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** The customer-facing list of what is recorded, generated from the catalogue. */
export function disclosure() {
  return CAPABILITY_KEYS.map((key) => ({
    key,
    label: CAPABILITIES[key].label,
    why: CAPABILITIES[key].why,
    timed: CAPABILITIES[key].timed === true,
  }));
}
