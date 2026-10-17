/**
 * The knowledge corpus — what the advisor is permitted to know.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT A PROMPT, AND NOT A TABLE
 *
 * The obvious way to build an advisor is to put fundraising expertise into a
 * system prompt. That is wrong three times over:
 *
 *   · It rots silently. A model has a training cutoff. Text encoding what a
 *     diligence process looks like in 2026 is wrong by 2028 and nothing tells
 *     you — not the model, not the user, not the logs.
 *
 *   · It cannot be cited. A user asking "says who, and when was that last
 *     checked?" is asking a reasonable question, and a prompt cannot answer it.
 *
 *   · It breaks the product's own rule. The app refuses to let a model
 *     originate a number. It must equally refuse to let one originate guidance.
 *
 * A database table would fix the first two and fail a fourth test: guidance
 * could then change without a code review. In git, a change to what the product
 * tells people arrives as a diff, in a pull request, with an author and a date,
 * and an accelerator auditing what its companies are being told can read it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT MAY AND MAY NOT GO IN HERE
 *
 * MAY: what a question is actually testing; what a document contains when it is
 * complete; what makes a figure reproducible; the order in which work is best
 * done. All of it operational, all of it checkable against the record itself.
 *
 * MAY NOT, ever:
 *   · Statistics, benchmarks, percentages or "typical" figures. If a number
 *     appears in a record body it must be a definition (a bridge has three
 *     columns), never a measurement of the world. Nothing in here is measured.
 *   · Claims about what investors or buyers "require", "expect" or "look for".
 *     The product does not speak for counterparties it has not met. Records say
 *     what question is being tested, which is defensible, and attribute it.
 *   · Legal, tax, accounting, valuation or investment advice, or anything that
 *     reads as a recommendation to raise, sell, or accept terms.
 *   · Vendor, product or firm names.
 *
 * `test/knowledge.test.js` enforces most of that automatically.
 */

import { KNOWLEDGE_SOURCE } from '../domain/criteria.js';

/** Bump when any record changes. Stored on every answer, so an old answer stays explicable. */
export const CORPUS_VERSION = '1.0';

/**
 * The publication every record is attributed to.
 *
 * One source today, and the shape is deliberately plural: a record carries a
 * `source` id so a second publication — a jurisdiction-specific supplement, a
 * partner's methodology — can be added without rewriting anything that cites
 * the first.
 */
export const SOURCES = Object.freeze([
  KNOWLEDGE_SOURCE,
]);

const sourceById = new Map(SOURCES.map((s) => [s.id, s]));
export const sourceOf = (id) => sourceById.get(id) ?? null;

/** What kind of thing a record is. Changes how the advisor is allowed to use it. */
export const RECORD_KINDS = Object.freeze([
  'TESTED',      // what a question is actually testing
  'CONTENTS',    // what a document contains when it is complete
  'METHOD',      // how a figure is produced so it can be reproduced
  'SEQUENCING',  // what order work is best done in, and why
  'PROCESS',     // how the room and the process are run
]);

const R = (r) => Object.freeze({ source: KNOWLEDGE_SOURCE.id, jurisdiction: 'GENERAL', ...r });

/**
 * The records.
 *
 * `applies_to` lists criterion refs, which is what lets the advisor answer "what
 * should I do about 2.3?" by retrieving rather than recalling. `tested` is the
 * question a counterparty is actually asking — the most useful sentence in most
 * of these records, and the one users quote back.
 */
export const RECORDS = Object.freeze([
  // ── Domain 1 — corporate and cap table ──────────────────────────────────
  R({
    id: 'K-1.1-captable',
    kind: 'CONTENTS',
    title: 'What a cap table has to reconcile to',
    applies_to: ['1.1', '1.2'],
    tags: ['cap table', 'shares', 'equity', 'dilution', 'register', 'waterfall', 'safe', 'note', 'warrant'],
    tested: 'Will the shares I am buying actually exist, in the quantity stated, and does anyone else have a '
          + 'claim on them?',
    body:
      'A cap table is complete when three things agree without explanation: the table itself, the statutory '
      + 'register of members, and every executed instrument that could ever convert into shares. Agreement '
      + 'means line by line, not in total. '
      + 'Fully diluted means every instrument modelled through to shares — options granted and unexercised, '
      + 'the unallocated pool, convertible notes and SAFEs run through their conversion terms at the '
      + 'contemplated price, warrants, and anything promised in writing but not yet documented. '
      + 'The common failure is not arithmetic. It is an instrument nobody could find, or a promise made in an '
      + 'email that was never papered.',
    pitfalls: [
      'A table that reconciles in total but not line by line.',
      'Convertibles shown at face value rather than run through their conversion terms.',
      'An option promise made verbally or in an offer letter and never granted.',
    ],
  }),
  R({
    id: 'K-1.3-promises',
    kind: 'TESTED',
    title: 'Undocumented equity promises',
    applies_to: ['1.3', '6.4'],
    tags: ['options', 'promise', 'equity', 'grant', 'board approval', 'offer letter'],
    tested: 'Has anything been promised to anyone that is not on the cap table?',
    body:
      'An equity promise exists from the moment it is made, not from the moment it is documented. An offer '
      + 'letter saying "and equity to be agreed", a conversation with an early contractor, a founder '
      + 'understanding never put to the board — each is an outstanding claim that a cap table showing only '
      + 'granted options does not disclose. '
      + 'The work is to list every person who could reasonably believe they are owed equity, establish what '
      + 'was said and by whom, and then either document it properly or settle it in writing. '
      + 'This is slow because it involves conversations, which is why it belongs early rather than during a '
      + 'process.',
  }),

  // ── Domain 2 — the financial record ─────────────────────────────────────
  R({
    id: 'K-2.1-management-accounts',
    kind: 'CONTENTS',
    title: 'What makes management accounts usable',
    applies_to: ['2.1'],
    tested: 'Did this business produce these numbers, and does anyone here know what they mean month to month?',
    tags: ['management accounts', 'monthly', 'close', 'reconciliation', 'statutory', 'bookkeeping'],
    body:
      'Management accounts become usable at the point where they are produced on a predictable cycle, on a '
      + 'consistent basis, and reconcile to the statutory accounts without a working paper nobody can '
      + 'reproduce. A set assembled for the first time in response to a request is identifiable as such, and '
      + 'what it signals is not a weak finance function but an absence of the monthly rhythm that makes any '
      + 'other number defensible. '
      + 'Speed of close matters less than consistency of close. Accounts produced slowly but always on the '
      + 'same basis are worth more than fast accounts whose basis moves.',
    pitfalls: [
      'A basis that changes partway through the period, with no note saying so.',
      'A reconciliation to statutory accounts that only one person can reproduce.',
    ],
  }),
  R({
    id: 'K-2.3-normalisation',
    kind: 'METHOD',
    title: 'The normalisation bridge',
    applies_to: ['2.3'],
    tested: 'What does this business actually earn, as opposed to what the statutory accounts happen to show?',
    tags: ['normalisation', 'bridge', 'adjustment', 'ebitda', 'add-back', 'owner', 'one-off', 'underlying'],
    body:
      'A normalisation bridge runs from reported profit to underlying earnings, one adjustment per line, and '
      + 'each line carries three things: what the adjustment is, what it is worth, and the document that '
      + 'evidences it. A line with no evidence is not an adjustment, it is an assertion, and it will be '
      + 'removed by whoever is reading it. '
      + 'The discipline that matters is building the bridge yourself, before anyone asks. An adjustment you '
      + 'identify and evidence is a correction. The same adjustment produced after a counterparty queries the '
      + 'line is a negotiation you are having from behind. '
      + 'Adjustments typically fall into owner-specific costs that would not continue, genuinely non-recurring '
      + 'items, and accounting presentation differences. Each needs the evidence attached, not merely '
      + 'described.',
    pitfalls: [
      'An add-back that recurs every year, which makes it a cost of the business.',
      'A bridge with no evidence column.',
      'Normalising upward only. A bridge that never adjusts against you reads as advocacy.',
    ],
  }),
  R({
    id: 'K-2.2-revenue-recognition',
    kind: 'METHOD',
    title: 'Writing down revenue recognition',
    applies_to: ['2.2'],
    tested: 'When exactly does this business count a pound of revenue, and has it always counted it that way?',
    tags: ['revenue recognition', 'policy', 'deferred', 'contract', 'accrual', 'invoice', 'subscription'],
    body:
      'A revenue recognition policy is a written statement of when revenue is recognised, applied the same '
      + 'way in every period. It is operational before it is technical: the question is whether the point of '
      + 'recognition is the same in January as in December, and whether the people entering the transactions '
      + 'know what it is. '
      + 'The work is to write the policy down in plain terms, then test it against a sample of actual '
      + 'transactions from different periods and see whether practice matches. Where it does not, the gap is '
      + 'the finding. '
      + 'Treatment under a specific accounting standard is a question for your accountant, and this record '
      + 'does not answer it.',
    not_advice: 'Operational preparation only. The applicable accounting standard is a matter for a qualified '
              + 'accountant in your jurisdiction.',
  }),
  R({
    id: 'K-2.4-forecast-credibility',
    kind: 'METHOD',
    title: 'Demonstrating forecast credibility',
    applies_to: ['2.4', '7.2'],
    tested: 'When this company has forecast before, what happened?',
    tags: ['forecast', 'variance', 'actuals', 'budget', 'plan', 'credibility', 'track record'],
    body:
      'Forecast credibility is not established by the quality of the current forecast. It is established by '
      + 'what happened to the previous ones. Setting the last three forecasts against actuals, with the '
      + 'variances explained, converts the forecast in front of someone from an assertion into something with '
      + 'a track record behind it. '
      + 'Missing forecasts explained well are more useful than hitting them with no explanation, because the '
      + 'explanation is the evidence that the business understands its own drivers. A company that missed and '
      + 'can say precisely why is demonstrating the thing being tested. '
      + 'This is cheap to produce if the forecasts were kept, and impossible to produce retrospectively if '
      + 'they were not — which is the argument for keeping them from now on even if the history is gone.',
  }),

  // ── Domain 3 — commercial ───────────────────────────────────────────────
  R({
    id: 'K-3.1-concentration',
    kind: 'METHOD',
    title: 'Quantifying customer concentration, including the trend',
    applies_to: ['3.1'],
    tested: 'If the largest customer left, what happens, and is the business becoming more or less exposed?',
    tags: ['concentration', 'customer', 'revenue', 'top customer', 'dependency', 'gross profit', 'trend'],
    body:
      'Concentration is quantified as the share of revenue held by the top one, three and five customers, and '
      + 'then again by gross profit, because the two can point in different directions: a large customer on '
      + 'thin margin is a different exposure from a large customer carrying the margin. '
      + 'The figure that does the work is the trend. A share that has risen while revenue grew means the '
      + 'growth came from one relationship, which is a different conversation from the same share on a larger '
      + 'base. Showing the two-year trend yourself is better than being asked for it, because the question '
      + 'arrives either way. '
      + 'Where concentration is high and cannot be changed quickly, what is testable instead is the strength '
      + 'of the relationship: contract term, notice period, how many people inside the customer know the '
      + 'business, and whether the relationship survives one individual leaving.',
    pitfalls: [
      'Concentration by revenue only, where the margin picture differs.',
      'A single point-in-time figure with no trend.',
      'Grouping entities of one corporate parent as separate customers.',
    ],
  }),
  R({
    id: 'K-3.2-retention-definitions',
    kind: 'METHOD',
    title: 'Defining retention so the figure is reproducible',
    applies_to: ['3.2', '7.1'],
    tested: 'How is this calculated, and can I get the same answer from the raw data?',
    tags: ['retention', 'churn', 'nrr', 'expansion', 'cohort', 'definition', 'logo', 'gross'],
    body:
      'Retention, churn and expansion are not standard terms. They are whatever a company has defined them '
      + 'to mean, which is why the written definition matters more than the number. A figure that cannot be '
      + 'reproduced from source data by someone following the definition is not a metric, it is a claim. '
      + 'A usable definition states the unit being counted, the window, how mid-period movements are '
      + 'treated, and what is excluded. Then the calculation is run from raw data and the result compared '
      + 'with the number currently being quoted. Where they differ, the difference is found before anyone '
      + 'else finds it. '
      + 'Logo retention and revenue retention answer different questions and routinely move in opposite '
      + 'directions. Quoting one without saying which it is creates a contradiction the moment the other '
      + 'is calculated.',
  }),

  // ── Domain 4 and 5 — contracts, IP ──────────────────────────────────────
  R({
    id: 'K-4.2-change-of-control',
    kind: 'TESTED',
    title: 'Provisions that behave differently on a change of ownership',
    applies_to: ['4.1', '4.2'],
    tested: 'Does anything in this contract base change, terminate or become payable because of this '
          + 'transaction?',
    tags: ['change of control', 'contract', 'assignment', 'consent', 'termination', 'exclusivity', 'guarantee'],
    body:
      'Certain provisions are triggered by a change in ownership rather than by anything the business does: '
      + 'consent or notice requirements on assignment, termination rights, acceleration, exclusivity, '
      + 'minimum commitments, and guarantees given by individuals. They are found by reading the contracts, '
      + 'which is slow, and they cannot be found any other way. '
      + 'The output is one page listing each provision, the counterparty, and what it would require. Finding '
      + 'these during a process is expensive because the remedy — asking a counterparty for consent — is '
      + 'itself a disclosure, on a timetable set by someone with no reason to hurry. '
      + 'Whether a specific clause operates as it appears to is a legal question and this record does not '
      + 'answer it.',
    not_advice: 'Identifying where to look. Interpretation of any specific provision is a matter for a '
              + 'qualified lawyer in the relevant jurisdiction.',
  }),
  R({
    id: 'K-5.1-ip-assignment',
    kind: 'TESTED',
    title: 'IP assignment gaps and why they are slow to close',
    applies_to: ['5.1', '5.3'],
    tested: 'Does the company own what it is selling, outright, with no one else able to claim part of it?',
    tags: ['ip', 'assignment', 'contractor', 'founder', 'employee', 'open source', 'licence', 'ownership'],
    body:
      'Ownership of what was built depends on a signed assignment from every person who contributed, '
      + 'including founders before incorporation, contractors, agencies and anyone paid in equity. An '
      + 'unsigned assignment from someone who left years ago is the single most common long-lead item in '
      + 'preparation, because closing it means finding a person with no remaining relationship to the company '
      + 'and asking them to sign something. '
      + 'The work is an inventory first: who contributed, what they contributed, and whether a signed '
      + 'assignment exists. Gaps found early can be closed over months. Gaps found during a process are '
      + 'closed under time pressure, by someone who now knows the company needs the signature. '
      + 'Open-source dependencies sit alongside this: an inventory of what is used, under which licence, and '
      + 'whether that licence is compatible with how the product is distributed.',
    pitfalls: [
      'Founder contributions made before the company existed.',
      'An agency whose standard terms retain ownership.',
      'Treating "we paid them" as equivalent to an assignment.',
    ],
  }),

  // ── Domain 6 — people ───────────────────────────────────────────────────
  R({
    id: 'K-6.2-key-person',
    kind: 'METHOD',
    title: 'Naming key-person dependency usefully',
    applies_to: ['6.2', '6.3'],
    tested: 'Does this business work without the people sitting in this room?',
    tags: ['key person', 'dependency', 'founder', 'second layer', 'succession', 'deputy', 'knowledge'],
    body:
      'A key-person register that lists job titles records nothing. The useful version names the specific '
      + 'thing each person uniquely holds — a relationship with a named customer, knowledge of a system '
      + 'nobody else has entered, an access right, an understanding of why something is built the way it is. '
      + 'Stated that specifically, each line suggests its own remedy: document it, introduce a second person '
      + 'to the relationship, or give someone else the access and have them use it. '
      + 'The second layer is testable rather than assertable. For each critical function, name the person '
      + 'other than the founder who could run it, and then establish whether they ever have.',
  }),

  // ── Domain 7 — the story and the model ──────────────────────────────────
  R({
    id: 'K-7.1-deck-model-agreement',
    kind: 'METHOD',
    title: 'Making the deck and the model agree',
    applies_to: ['7.1'],
    tested: 'Do the two documents this company sent me say the same thing?',
    tags: ['deck', 'model', 'consistency', 'contradiction', 'figure', 'source', 'traceable'],
    body:
      'Every figure that appears in more than one document is a place the two can diverge, and they diverge '
      + 'without anyone deciding to: a deck is updated for a meeting, the model is not, and both continue in '
      + 'circulation. The reader finds it by reading both, which they will. '
      + 'The durable fix is structural rather than diligent: one source for each figure, with documents '
      + 'rendered from it, so there is no second copy to fall out of date. Where that is not possible, the '
      + 'minimum is a list of every shared figure and a check of each before anything is sent. '
      + 'A contradiction found by a counterparty does not cost the difference between the two numbers. It '
      + 'costs the assumption that the other figures were checked.',
  }),
  R({
    id: 'K-7.2-driver-based-model',
    kind: 'METHOD',
    title: 'What makes a model driver-based',
    applies_to: ['7.2', '7.3'],
    tested: 'Where does this growth come from, and what would have to be true for it to happen?',
    tags: ['model', 'driver', 'assumption', 'growth', 'bottom-up', 'pricing', 'hard-coded'],
    body:
      'A model is driver-based when growth emerges from stated assumptions about customers, pricing, '
      + 'conversion and retention, rather than from a growth rate typed into a cell. The test is mechanical: '
      + 'change one assumption and see whether anything downstream moves. If the output is unchanged, the '
      + 'growth was asserted rather than built. '
      + 'Market sizing is the same argument. A figure built upward from addressable customers and realistic '
      + 'pricing can be interrogated; a top-down figure can only be believed or not, and is most useful as a '
      + 'cross-check on the bottom-up number. '
      + 'The practical benefit is that a driver-based model survives being pulled apart in a meeting, because '
      + 'each number has somewhere to come from.',
  }),
  R({
    id: 'K-7.4-load-bearing-assumptions',
    kind: 'METHOD',
    title: 'Stating the assumptions the plan depends on',
    applies_to: ['7.4'],
    tested: 'What would have to go wrong for this plan to fail, and does the company know?',
    tags: ['assumption', 'risk', 'plan', 'falsifiable', 'dependency', 'sensitivity'],
    body:
      'A load-bearing assumption is one where, if it is wrong, the plan does not work. Most plans rest on '
      + 'about three. Stating them explicitly — with what would have to be observed for each to be wrong — '
      + 'does two things: it makes the plan interrogable, and it demonstrates that the company has looked. '
      + 'An assumption that nothing could disprove is not an assumption, it is a hope, and it is recognisable '
      + 'as one. "The market will continue to grow" fails the test. "Enterprise win rate holds at its current '
      + 'level as deal size rises" passes it, because it names what to watch. '
      + 'Volunteering these is counter-intuitive and is usually the strongest move available, because the '
      + 'alternative is a counterparty discovering them and wondering what else was not mentioned.',
  }),

  // ── Domain 8 and process ────────────────────────────────────────────────
  R({
    id: 'K-8.1-room-structure',
    kind: 'PROCESS',
    title: 'Running a room so it reads as organised',
    applies_to: ['8.1', '8.2'],
    tested: 'How is this company actually run?',
    tags: ['data room', 'folder', 'naming', 'version', 'structure', 'superseded', 'index'],
    body:
      'A room is read as evidence about the business, not merely as a container. A numbered folder structure, '
      + 'a consistent file-naming convention, and the absence of superseded versions are not presentation — '
      + 'they are the cheapest available demonstration that the company is run in an orderly way. '
      + 'The specific failure that costs most is two versions of the same document, because a reader cannot '
      + 'tell which one is current and has to ask. Every question asked is time, and a question about '
      + 'housekeeping is time spent on nothing of value. '
      + 'This is the cheapest domain to fix and the one most often left until last.',
  }),
  R({
    id: 'K-8.4-qa-log',
    kind: 'PROCESS',
    title: 'Keeping a question log',
    applies_to: ['8.4', '8.3'],
    tested: 'Is this company telling everyone the same thing?',
    tags: ['q&a', 'question', 'log', 'consistency', 'answer', 'access', 'staged'],
    body:
      'Every answer given to any party should be recorded, with who asked, what was asked, what was said and '
      + 'when. Processes involve several people answering questions over months, and an inconsistency between '
      + 'two answers is more damaging than either answer being imperfect — it moves the conversation from the '
      + 'business to whether the company can be relied on. '
      + 'The log is also the fastest way to answer a repeat question, which is most of them. '
      + 'Staged access belongs alongside it: what a party can see should follow the stage they are at, with a '
      + 'record of who received what. Deciding that at the point of a request produces inconsistent '
      + 'disclosure; deciding it in advance does not.',
  }),

  // ── Sequencing ──────────────────────────────────────────────────────────
  R({
    id: 'K-SEQ-order',
    kind: 'SEQUENCING',
    title: 'Why the fix order is not the score order',
    applies_to: [],
    tested: null,
    tags: ['order', 'sequence', 'priority', 'gap', 'blocker', 'long lead', 'third party', 'plan', 'next'],
    body:
      'The worst score is rarely the first thing to do. Work is better ordered by what each item depends on '
      + 'and how long it takes to come back. '
      + 'Blocking items come first because nothing else is worth doing until they are resolved. Long-lead '
      + 'items come next even when they score better, because they are measured in months and the clock '
      + 'starts when they are begun, not when they are reached. Items depending on a third party are started '
      + 'early for the same reason: the time is not yours to compress. Cheap items are done in batches '
      + 'whenever there is capacity, because they cost little and visibly move the position. Room items come '
      + 'last, not because they do not matter, but because they are quick and can absorb the time left over. '
      + 'Ordering by score instead produces a plan that looks rational and finishes late, because the long '
      + 'items were started last.',
  }),
  R({
    id: 'K-SEQ-capacity',
    kind: 'SEQUENCING',
    title: 'Owner capacity',
    applies_to: [],
    tested: null,
    tags: ['owner', 'capacity', 'assign', 'workload', 'parallel', 'plan'],
    body:
      'A gap with no named owner does not get closed. A gap register where one person owns most of the open '
      + 'items also does not get closed, and the register will nonetheless look complete, which is worse '
      + 'than looking incomplete. '
      + 'Holding each owner to a small number of open items at a time is a scheduling constraint rather than '
      + 'a judgement about anyone. The alternative is a plan that is accurate about what must happen and '
      + 'silent about whether it can.',
  }),
  R({
    id: 'K-PROC-self-discovery',
    kind: 'SEQUENCING',
    title: 'Finding it yourself is the whole point',
    applies_to: [],
    tested: null,
    tags: ['process', 'preparation', 'discovery', 'disclosure', 'timing', 'why'],
    body:
      'The same issue costs differently depending on who finds it. Found by the company in advance, it is a '
      + 'thing being worked on, disclosed on the company\'s own timing, with a remedy already underway. '
      + 'Found by a counterparty mid-process, it is a surprise, and the cost is rarely the issue itself — it '
      + 'is the question of what else has not been checked. '
      + 'That is the argument for preparation that runs ahead of any process, and it is also why a low score '
      + 'honestly given is more useful than a high score defended. The scoring is for the company, not for '
      + 'anyone else, and a flattering self-assessment buys nothing.',
  }),
]);

const byId = new Map(RECORDS.map((r) => [r.id, r]));
export const recordById = (id) => byId.get(id) ?? null;
export const ALL_RECORD_IDS = Object.freeze(RECORDS.map((r) => r.id));

/**
 * Whether a record is overdue for review.
 *
 * A record past its review interval is not deleted and not hidden — it is
 * flagged, and the advisor must disclose the staleness if it cites one. Silent
 * staleness is the failure mode a prompt has and this design exists to avoid;
 * reproducing it here with a quiet expiry would be worse, because it would look
 * as though it had been handled.
 */
export function reviewStatus(record, asOf) {
  const source = sourceOf(record.source);
  if (!source) return { state: 'UNSOURCED', due: null };

  const reviewed = Date.parse(record.reviewed ?? source.reviewed);
  const months = record.reviewIntervalMonths ?? source.reviewIntervalMonths;
  if (!Number.isFinite(reviewed) || !Number.isFinite(months)) return { state: 'UNKNOWN', due: null };

  const due = new Date(reviewed);
  due.setUTCMonth(due.getUTCMonth() + months);
  const dueIso = due.toISOString();

  return {
    state: Date.parse(asOf) > due.getTime() ? 'OVERDUE' : 'CURRENT',
    due: dueIso,
    reviewed: new Date(reviewed).toISOString(),
  };
}

/** What needs reviewing, for whoever maintains the corpus. */
export function knowledgeHealth(asOf) {
  const rows = RECORDS.map((r) => ({ id: r.id, title: r.title, ...reviewStatus(r, asOf) }));
  const overdue = rows.filter((r) => r.state === 'OVERDUE');
  return {
    corpus_version: CORPUS_VERSION,
    sources: SOURCES,
    records: rows.length,
    overdue,
    current: rows.length - overdue.length,
    // Deliberately blunt. A corpus nobody reviews is a prompt with extra steps.
    note: overdue.length
      ? `${overdue.length} records are past their review date. Answers citing them must say so.`
      : 'Every record is within its review interval.',
  };
}
