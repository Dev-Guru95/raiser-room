/**
 * The action catalogue — what the advisor is allowed to propose.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF THE PROBLEM
 *
 * "Let the AI make changes for you" is the easiest feature in this product to
 * build badly. The naive version gives a model write access and a system prompt
 * telling it what not to touch, and it works until the day it does not — at
 * which point a figure in a data room has been changed by something that cannot
 * be asked why.
 *
 * The architecture already answered this once. Facts are immutable, their source
 * enum is frozen, and there is no `AI_GENERATED` value in it. This module is the
 * same answer applied to structure instead of numbers:
 *
 *   1. There is a CATALOGUE. An action not in it cannot be proposed, because
 *      there is no code path that would accept it. Not "is refused" — does not
 *      exist.
 *
 *   2. Each entry declares the EXACT columns it may write. A proposal carrying
 *      any other field is rejected before it is stored, so a widened payload
 *      cannot quietly widen the action.
 *
 *   3. No entry targets `fact`. That is asserted by a test, not promised by a
 *      comment, and it is what keeps `USER_ENTERED` meaning what it says.
 *
 *   4. Nothing here applies anything. A proposal is data. The change happens in
 *      `api/actions.js`, which calls the ordinary service functions — so the
 *      advisor is a caller with no privileges, and every rule that protects a
 *      human's edit protects this one too.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A PROPOSAL CARRIES THE BEFORE STATE
 *
 * A proposal written on Tuesday and confirmed on Friday is a statement about
 * Tuesday's world. If someone assigned that gap on Wednesday, confirming on
 * Friday silently overwrites them — and the person who did the overwriting is a
 * human who pressed "confirm" on a one-line summary that was true when it was
 * written. So each proposal records what it read, and refuses to apply if that
 * has changed.
 *
 * Narrowly, though. The precondition covers ONLY the fields the action reads or
 * writes. Hashing the whole row would invalidate a gap's owner proposal because
 * somebody edited its description, and a product that cries stale at every
 * unrelated edit teaches people to confirm without reading — which is the exact
 * failure the precondition exists to prevent. That lesson is Phase 7's and it
 * applies here unchanged.
 */

import { GAP_CATEGORIES } from './gaps.js';
import { STAGES } from './dataroom.js';
import { unaccountedNumerals } from './advisor.js';

export class ActionError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** How long a proposal stays confirmable. */
export const PROPOSAL_TTL_DAYS = 14;

/**
 * The states a proposal can be in.
 *
 * REJECTED and EXPIRED are kept rather than deleted. "The advisor suggested
 * this and we said no" is a useful thing to be able to show, and an empty
 * proposal list is indistinguishable from an advisor that never suggests
 * anything.
 */
export const PROPOSAL_STATES = Object.freeze(['PROPOSED', 'APPLIED', 'REJECTED', 'EXPIRED', 'UNDONE']);

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)
  && !Number.isNaN(new Date(v).getTime());

// ─────────────────────────────────────────────────────────── the catalogue ──

/**
 * Every action the advisor may propose.
 *
 * `reads` are the fields whose change invalidates the proposal. `writes` are
 * the fields it may set. `check` validates the payload in isolation; the
 * service layer re-checks everything when it applies, because that is where the
 * real rules live.
 */
const CATALOGUE = [
  {
    kind: 'CREATE_FOLDER',
    label: 'Create a folder in the data room',
    target: 'data_room_node',
    // A create has no existing target, so its "target" is the parent it hangs
    // under — and the parent disappearing is exactly what should invalidate it.
    creates: true,
    reads: ['id'],
    writes: ['name', 'parent_id', 'stage', 'required'],
    check(payload) {
      const problems = [];
      if (!nonEmpty(payload.name)) problems.push('A folder needs a name.');
      if (payload.name && payload.name.length > 80) problems.push('That folder name is too long.');
      if (payload.stage !== undefined && !STAGES.includes(payload.stage)) {
        problems.push(`Stage must be one of ${STAGES.join(', ')}.`);
      }
      return problems;
    },
    describe: (p) => `Create a folder called "${p.name}"`,
  },

  {
    kind: 'MARK_ITEM_NOT_APPLICABLE',
    label: 'Mark a data room item not applicable',
    target: 'data_room_item',
    // `document_id` is read as well as written: the action clears it, so an item
    // that has gained a document since the proposal was written must not be
    // quietly emptied by confirming a three-day-old suggestion.
    reads: ['not_applicable', 'na_reason', 'document_id'],
    writes: ['not_applicable', 'na_reason', 'document_id'],
    check(payload) {
      const problems = [];
      const reason = String(payload.reason ?? '').trim();
      // The same floor the human path enforces. Duplicated here only so the
      // advisor is told at propose time rather than at confirm time; the real
      // enforcement is still in `markNotApplicable`.
      if (reason.length < 10) {
        problems.push('Not applicable needs a written reason. Without one it is missing with better '
          + 'manners, and a counterparty will read it that way.');
      }
      return problems;
    },
    describe: (p) => `Mark not applicable: ${String(p.reason ?? '').trim()}`,
  },

  {
    kind: 'ASSIGN_GAP_OWNER',
    label: 'Assign an owner to a gap',
    target: 'gap',
    reads: ['owner_user_id', 'closed_at'],
    writes: ['owner_user_id'],
    check(payload) {
      // Null is legitimate — unassigning is an action. Membership is checked by
      // `updateGap` at apply time, because that is where the membership table is.
      if (payload.owner_user_id !== null && !nonEmpty(payload.owner_user_id)) {
        return ['An owner must be a user, or null to unassign.'];
      }
      return [];
    },
    describe: (p) => (p.owner_user_id === null ? 'Remove the owner' : `Assign to ${p.owner_user_id}`),
  },

  {
    kind: 'SET_GAP_DUE_DATE',
    label: 'Set a due date on a gap',
    target: 'gap',
    reads: ['due_date', 'closed_at'],
    writes: ['due_date'],
    check(payload) {
      if (payload.due_date === null) return [];
      if (!isIsoDate(payload.due_date)) return ['A due date must be a calendar date.'];
      return [];
    },
    describe: (p) => (p.due_date === null ? 'Clear the due date' : `Due ${p.due_date}`),
  },

  {
    kind: 'SET_GAP_CATEGORY',
    label: 'Recategorise a gap',
    target: 'gap',
    reads: ['category', 'closed_at'],
    writes: ['category'],
    check(payload) {
      if (!GAP_CATEGORIES.includes(payload.category)) {
        return [`Category must be one of ${GAP_CATEGORIES.join(', ')}.`];
      }
      return [];
    },
    describe: (p) => `Recategorise as ${p.category}`,
  },

  {
    kind: 'SET_GAP_DONE_WHEN',
    label: 'Write the done-when test for a gap',
    target: 'gap',
    reads: ['done_when', 'closed_at'],
    writes: ['done_when'],
    check(payload) {
      const dw = String(payload.done_when ?? '').trim();
      if (dw.length < 10) {
        return ['A done-when test has to be specific enough that two people would agree whether it '
          + 'has been met.'];
      }
      return [];
    },
    describe: (p) => `Done when: ${String(p.done_when ?? '').trim()}`,
  },

  {
    kind: 'REORDER_FOLDER',
    label: 'Reorder a folder in the data room',
    target: 'data_room_node',
    reads: ['sort_key'],
    writes: ['sort_key'],
    check(payload) {
      if (!nonEmpty(payload.sort_key)) return ['A sort key is required.'];
      return [];
    },
    describe: (p) => `Move to position ${p.sort_key}`,
  },

  {
    kind: 'SET_FOLDER_STAGE',
    label: 'Change which stage a folder becomes visible at',
    target: 'data_room_node',
    reads: ['stage'],
    writes: ['stage'],
    check(payload) {
      if (!STAGES.includes(payload.stage)) return [`Stage must be one of ${STAGES.join(', ')}.`];
      return [];
    },
    describe: (p) => `Visible from ${p.stage}`,
  },

  {
    kind: 'DRAFT_PROSE',
    label: 'Draft prose for a document block',
    target: 'organisation',
    reads: ['id'],
    writes: ['slot', 'text'],
    // The dangerous one. Prose is the gap in the fence: everything else on this
    // list is a structural field with a closed set of values, but prose is free
    // text, and free text can carry a number. "Revenue grew to $4.2m" written
    // into a deck is a fact value, whatever table it is stored in.
    //
    // So prose takes the same number rule as an advisor's answer: every numeral
    // must be accounted for by something cited. The check needs the citation
    // context, so it is completed in `checkProse` at propose time, where that
    // context exists.
    check(payload) {
      const problems = [];
      if (!nonEmpty(payload.slot)) problems.push('Prose needs a slot to go in.');
      if (!nonEmpty(payload.text)) problems.push('There is no prose here.');
      if (payload.text && payload.text.length > 4000) {
        problems.push('That is longer than any block in a generated document.');
      }
      return problems;
    },
    describe: (p) => `Draft the "${p.slot}" prose`,
  },

  {
    kind: 'REQUEST_DOCUMENT',
    label: 'Request a document from someone',
    target: 'data_room_item',
    reads: ['document_id', 'not_applicable'],
    // Writes nothing on the item. A request is a message, and recording it as a
    // change to the room would make the room look fuller than it is.
    writes: [],
    check(payload) {
      const problems = [];
      if (!nonEmpty(payload.note)) problems.push('A request needs to say what is being asked for.');
      if (payload.note && payload.note.length > 600) problems.push('That request is too long to send.');
      return problems;
    },
    describe: (p) => `Request: ${String(p.note ?? '').trim()}`,
  },
];

export const ACTIONS = Object.freeze(
  Object.fromEntries(CATALOGUE.map((a) => [a.kind, Object.freeze({
    ...a,
    reads: Object.freeze([...a.reads]),
    writes: Object.freeze([...a.writes]),
  })])),
);

export const ACTION_KINDS = Object.freeze(CATALOGUE.map((a) => a.kind));

/**
 * Tables no action may ever target.
 *
 * `fact` is the whole point. The others are here because an action that could
 * rewrite an audit row, a stored artifact or a share token would undo the
 * guarantees those tables exist to provide — an audit trail the actor can edit
 * is not an audit trail.
 */
export const FORBIDDEN_TARGETS = Object.freeze([
  'fact', 'audit_log', 'artifact', 'share', 'share_view', 'extraction', 'extraction_candidate',
  'forecast', 'forecast_line', 'period_close', 'variance', 'membership', 'organisation_owner',
]);

export const actionFor = (kind) => ACTIONS[kind] ?? null;

// ──────────────────────────────────────────────────────────── validation ──

/**
 * Validate one proposed action, in isolation.
 *
 * Returns the problems rather than throwing, because a batch should report
 * everything wrong with it at once — an advisor fixing one problem per round
 * trip is a slow and expensive way to discover five.
 */
export function validateAction(proposed = {}) {
  const problems = [];
  const action = actionFor(proposed.action_kind);

  if (!action) {
    // Named rather than generic. "unknown_action" with the catalogue attached is
    // debuggable; "invalid" is not.
    return [{
      code: 'unknown_action',
      problem: `"${proposed.action_kind}" is not an action the advisor may propose.`,
      allowed: ACTION_KINDS,
    }];
  }

  if (!nonEmpty(proposed.target_id)) {
    problems.push({ code: 'no_target', problem: 'An action has to say what it acts on.' });
  }

  const rationale = String(proposed.rationale ?? '').trim();
  if (rationale.length < 15) {
    // An action with no stated reason is one a user has to accept on trust, and
    // the entire point of proposing rather than doing is that they do not have
    // to. Phase 4 made the same requirement of retrieval.
    problems.push({
      code: 'no_rationale',
      problem: 'Every proposed action has to say why, in enough words to be disagreed with.',
    });
  }

  const payload = proposed.payload ?? {};
  const allowed = new Set([...action.writes, ...PAYLOAD_EXTRAS[action.kind] ?? []]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      // A payload field outside the declared set is how an action quietly grows.
      problems.push({
        code: 'field_not_writable',
        problem: `${action.kind} may not set "${key}".`,
        allowed: [...allowed],
      });
    }
  }

  for (const problem of action.check(payload)) {
    problems.push({ code: 'invalid_payload', problem });
  }

  return problems;
}

/**
 * Payload keys that are inputs to an action rather than columns it writes.
 *
 * `reason` becomes `na_reason` and `note` is sent rather than stored, so neither
 * appears in `writes` — but both have to survive the field check above.
 */
const PAYLOAD_EXTRAS = Object.freeze({
  MARK_ITEM_NOT_APPLICABLE: ['reason'],
  REQUEST_DOCUMENT: ['note', 'to'],
});

/**
 * The number rule, applied to drafted prose.
 *
 * Identical in spirit to the one governing an advisor's answers, and deliberately
 * the same function: prose drafted into a deck is more consequential than prose
 * in a chat reply, so it cannot be held to a looser standard.
 */
export function checkProse(text, cited) {
  const unaccounted = unaccountedNumerals(text, cited);
  if (!unaccounted.length) return [];
  return [{
    code: 'unaccounted_numerals',
    problem: `This prose contains ${unaccounted.length === 1 ? 'a figure' : 'figures'} nothing cited `
      + `accounts for: ${unaccounted.join(', ')}. A number written into a document is a fact value, `
      + 'whichever block it sits in. Cite the fact it comes from, or leave the figure out and let the '
      + 'document resolve it.',
    numerals: unaccounted,
  }];
}

// ───────────────────────────────────────────────────────────── preconditions ──

/**
 * The slice of a row a proposal depends on.
 *
 * Only the declared `reads` and `writes`. See the header: a precondition over
 * the whole row cries stale at every unrelated edit, and a warning that fires
 * constantly is one nobody reads.
 */
export function snapshot(action, row) {
  const fields = [...new Set([...action.reads, ...action.writes])];
  const out = {};
  for (const field of fields) {
    // Normalised to a string or null so that SQLite's 0/1 and a JSON round trip
    // cannot make an unchanged row look changed.
    out[field] = row?.[field] === null || row?.[field] === undefined ? null : String(row[field]);
  }
  return out;
}

/** What moved between the world the proposal was written against and this one. */
export function drift(before = {}, current = {}) {
  const moved = [];
  for (const [field, was] of Object.entries(before)) {
    const now = current[field] ?? null;
    if (was !== now) moved.push({ field, was, now });
  }
  return moved;
}

/**
 * A readable account of what the action will do.
 *
 * Built from the real before-state rather than from the proposal's assumptions,
 * so what the user is shown is what will actually happen.
 */
export function describeChange(action, payload, before) {
  const changes = [];
  for (const field of action.writes) {
    const to = field in payload ? payload[field] : undefined;
    if (to === undefined) continue;
    const from = before?.[field] ?? null;
    const toText = to === null ? null : String(to);
    if (from === toText) continue;
    changes.push({ field, from, to: toText });
  }
  return { summary: action.describe(payload), changes };
}

/**
 * The inverse of an applied action.
 *
 * Computed from what was ACTUALLY there, not from what the proposal expected,
 * because those differ whenever a domain rule adjusted the write on the way in.
 * An undo built from the proposal would restore a state that never existed.
 */
export function inverseOf(action, before) {
  const restore = {};
  for (const field of action.writes) {
    const was = before?.[field] ?? null;
    restore[field] = was;
  }
  return restore;
}

export function expiryFrom(nowIso, days = PROPOSAL_TTL_DAYS) {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) throw new ActionError('bad_clock', 'cannot compute an expiry', 500);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export const hasExpired = (proposal, nowIso) =>
  Boolean(proposal?.expires_at) && String(nowIso) >= String(proposal.expires_at);
