/**
 * Phase 10 — the advisor acts.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE DECISION EVERYTHING ELSE FOLLOWS FROM
 *
 * **Applying a proposal calls the ordinary service functions.** Not the
 * database. `markNotApplicable`, `updateGap`, `createFolder` — the same
 * functions a person's click goes through, with the same authorisation, the same
 * validation, the same audit rows.
 *
 * It would be easier to write the rows directly. The proposal has been validated
 * against the catalogue, the target has been checked, the shape is known — and
 * every rule in those service functions would be bypassed. The ten-character
 * floor on a not-applicable reason, the membership check on a gap owner, the
 * duplicate-folder check: all of them live in the service layer, and an advisor
 * path that writes rows is an advisor path where none of them run.
 *
 * So the advisor is a caller with no privileges. If a proposal is refused at
 * confirm time by a rule that did not exist when it was proposed, that is the
 * design working, and the refusal is shown rather than swallowed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A HUMAN IS ACTUALLY AGREEING TO
 *
 * A confirm button is worth nothing if what it confirms is a sentence the model
 * wrote about itself. So the user is shown the diff computed from the CURRENT
 * row — field, from, to — and not the advisor's description of it. The
 * rationale is shown as the advisor's reasoning, labelled as such, beside the
 * change rather than in place of it.
 *
 * And a proposal whose world has moved is refused rather than applied, because
 * the person pressing confirm is agreeing to a summary that was true when it was
 * written.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import {
  ACTIONS, ACTION_KINDS, FORBIDDEN_TARGETS, actionFor, validateAction,
  snapshot, drift, describeChange, inverseOf, expiryFrom, hasExpired,
  PROPOSAL_TTL_DAYS, ActionError,
} from '../domain/actions.js';
import { assertAdvisor } from '../advisor/interface.js';
import * as dataroom from './dataroom.js';
import * as assessments from './assessments.js';
import * as prose from './prose.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

// ──────────────────────────────────────────────────────────── proposing ──

/**
 * Fetch the row an action targets, scoped to the organisation.
 *
 * A target in another organisation is a 404, never a 403 — the same rule as
 * everywhere else, for the same reason: a 403 confirms the id exists.
 */
function targetRow(ctx, orgId, action, targetId) {
  if (action.creates) {
    // A create has no target of its own; it hangs under a parent, or under the
    // organisation when it is top level.
    if (targetId === orgId) return ctx.db.get('organisation', orgId);
    return ctx.db.get(action.target, targetId);
  }
  return ctx.db.get(action.target, targetId);
}

/**
 * Record what the advisor proposes.
 *
 * Nothing is applied. Everything is validated now so the user is not shown a
 * list of suggestions half of which will fail when they press the button — but
 * validation here is a courtesy, and the real check is at apply time.
 */
export function propose(ctx, orgId, input = {}) {
  return usage.around(ctx, orgId, 'ACTION_PROPOSED', () => doPropose(ctx, orgId, input));
}

function doPropose(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const advisor = assertAdvisor(input.advisor);
  const list = Array.isArray(input.actions) ? input.actions : [];
  if (!list.length) throw new ActionError('no_actions', 'there is nothing to propose', 400);
  if (list.length > MAX_BATCH) {
    // A batch nobody will read through is a batch that gets confirmed wholesale,
    // which defeats the point of proposing.
    throw new ActionError('batch_too_large',
      `${list.length} actions at once is more than anyone will read. Propose at most ${MAX_BATCH}.`,
      400);
  }

  const now = ctx.now();
  const batchId = `batch-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const accepted = [];
  const rejected = [];

  list.forEach((proposed, index) => {
    const problems = validateAction(proposed);
    const action = actionFor(proposed.action_kind);

    if (action && FORBIDDEN_TARGETS.includes(action.target)) {
      // Unreachable while the catalogue is correct, and checked anyway: this is
      // the line that has to hold if someone adds an entry carelessly.
      problems.push({ code: 'forbidden_target', problem: `No action may write to ${action.target}.` });
    }

    let row = null;
    if (action && !problems.length) {
      row = targetRow(ctx, orgId, action, proposed.target_id);
      if (!row || (row.org_id && row.org_id !== orgId && row.id !== orgId)) {
        problems.push({ code: 'target_not_found', problem: 'That no longer exists.' });
      }
    }

    if (action?.kind === 'DRAFT_PROSE' && !problems.length) {
      // THE SAME CHECKER THAT RUNS AT CONFIRM TIME.
      //
      // Two checkers meant two rules: the advisor could propose a sentence that
      // passed here and was then refused when a human pressed confirm — which
      // is a worse failure than either rule alone, because it wastes the one
      // moment the user was willing to act.
      //
      // The cited context still narrows it: an advisor is held to what it
      // looked at, not to everything the company happens to hold.
      problems.push(...prose.checkProse(ctx, orgId, proposed.payload?.text ?? '', {
        cited: citedContext(ctx, orgId, proposed),
      }).map((p) => ({ ...p, problem: p.problem })));
    }

    if (problems.length) {
      rejected.push({ index, action_kind: proposed.action_kind, problems });
      return;
    }

    const before = snapshot(action, row);
    const stored = ctx.db.insert('action_proposal', {
      org_id: orgId,
      thread_id: input.thread_id ?? null,
      message_id: input.message_id ?? null,
      batch_id: batchId, seq: index,
      action_kind: action.kind, target_type: action.target, target_id: proposed.target_id,
      payload: JSON.stringify(proposed.payload ?? {}),
      before_state: JSON.stringify(before),
      rationale: String(proposed.rationale).trim(),
      cites: proposed.cites ? JSON.stringify(proposed.cites) : null,
      state: 'PROPOSED',
      depends_on: proposed.depends_on ?? null,
      applied_at: null, applied_by: null, undone_at: null, undone_by: null,
      rejected_at: null, rejected_by: null, reject_reason: null,
      expires_at: expiryFrom(now),
      advisor_id: advisor.id, advisor_version: advisor.version,
      proposed_by: ctx.auth.userId, created_at: now,
    });
    accepted.push(present(ctx, orgId, stored));
  });

  audit(ctx, orgId, 'actions.proposed', 'action_proposal', batchId, {
    advisor: advisor.id, accepted: accepted.length, rejected: rejected.length,
    kinds: accepted.map((a) => a.action_kind),
  });

  return ok({
    batch_id: batchId,
    proposals: accepted,
    rejected,
    expires_at: expiryFrom(now),
    note: accepted.length
      ? 'Nothing has changed yet. Each of these is a suggestion until you confirm it, and each one '
        + 'shows what it would actually change.'
      : 'Nothing could be proposed from that.',
  }, accepted.length ? 201 : 200);
}

/** Enough to read in one sitting. */
export const MAX_BATCH = 8;

/**
 * What the advisor cited, in the shape the numeral checker expects.
 *
 * Deliberately narrow. Passing the org's whole fact store here would let an
 * advisor write any figure the company holds, whether or not it looked at it,
 * which is originating a number with extra steps.
 */
function citedContext(ctx, orgId, proposed) {
  const refs = Array.isArray(proposed.cites) ? proposed.cites : [];
  const factIds = refs.filter((r) => String(r).startsWith('fact:')).map((r) => String(r).slice(5));
  const facts = factIds
    .map((id) => ctx.db.get('fact', id))
    .filter((f) => f && f.org_id === orgId);
  return { facts, figures: [], criteria: [], records: [] };
}

// ───────────────────────────────────────────────────────────── reading ──

function present(ctx, orgId, row) {
  const action = actionFor(row.action_kind);
  const payload = parseJson(row.payload, {});
  const before = parseJson(row.before_state, {});
  const current = row.state === 'PROPOSED' ? targetRow(ctx, orgId, action, row.target_id) : null;

  return {
    id: row.id, batch_id: row.batch_id, seq: row.seq,
    action_kind: row.action_kind, label: action?.label ?? row.action_kind,
    target_type: row.target_type, target_id: row.target_id,
    payload, rationale: row.rationale,
    cites: parseJson(row.cites, []),
    state: row.state,
    depends_on: row.depends_on,
    // The diff is computed from the CURRENT row, not from what the advisor
    // assumed. What the user agrees to is what will happen.
    change: action ? describeChange(action, payload, current ? snapshot(action, current) : before) : null,
    drift: current ? drift(before, snapshot(action, current)) : [],
    expires_at: row.expires_at,
    applied_at: row.applied_at, applied_by: row.applied_by,
    undone_at: row.undone_at, rejected_at: row.rejected_at, reject_reason: row.reject_reason,
    advisor_id: row.advisor_id, advisor_version: row.advisor_version,
    proposed_by: row.proposed_by, created_at: row.created_at,
  };
}

export function listProposals(ctx, orgId, { state = null, batchId = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const now = ctx.now();

  const rows = ctx.db.find('action_proposal', { org_id: orgId })
    .filter((r) => (batchId ? r.batch_id === batchId : true))
    .map((r) => {
      // Expiry is evaluated on read rather than by a sweeper. A proposal that is
      // past its date is expired whether or not anything has run.
      if (r.state === 'PROPOSED' && hasExpired(r, now)) {
        return ctx.db.update('action_proposal', r.id, { state: 'EXPIRED' });
      }
      return r;
    })
    .filter((r) => (state ? r.state === state : true))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || a.seq - b.seq);

  return ok({
    proposals: rows.map((r) => present(ctx, orgId, r)),
    total: rows.length,
    open: rows.filter((r) => r.state === 'PROPOSED').length,
  });
}

export function getProposal(ctx, orgId, proposalId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const row = assertBelongsToOrg(ctx.db.get('action_proposal', proposalId), orgId);
  return ok({ proposal: present(ctx, orgId, row) });
}

// ──────────────────────────────────────────────────────────── confirming ──

/**
 * Apply a proposal.
 *
 * The order here is the whole design: check it is still confirmable, check the
 * world has not moved, then hand the work to the ordinary service function and
 * let it refuse if it wants to.
 */
export function confirm(ctx, orgId, proposalId) {
  return usage.around(ctx, orgId, 'ACTION_CONFIRMED', () => doConfirm(ctx, orgId, proposalId));
}

function doConfirm(ctx, orgId, proposalId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('action_proposal', proposalId), orgId);
  const action = actionFor(row.action_kind);
  if (!action) {
    // The catalogue shrank under a stored proposal — a deployment removed an
    // action. Refusing is right; applying an action the catalogue no longer
    // describes is applying something nobody can now audit.
    throw new ActionError('action_withdrawn',
      `"${row.action_kind}" is no longer an action this product performs.`, 409);
  }

  if (row.state !== 'PROPOSED') {
    throw new ActionError('not_confirmable',
      `This was already ${row.state.toLowerCase()}.`, 409, { state: row.state });
  }
  if (hasExpired(row, ctx.now())) {
    ctx.db.update('action_proposal', row.id, { state: 'EXPIRED' });
    throw new ActionError('proposal_expired',
      `Suggestions stop being confirmable after ${PROPOSAL_TTL_DAYS} days, because they are statements `
      + 'about how things were when they were written. Ask again and you will get one about now.',
      409);
  }

  if (row.depends_on) {
    const parent = ctx.db.get('action_proposal', row.depends_on);
    if (!parent || parent.state !== 'APPLIED') {
      throw new ActionError('dependency_not_applied',
        'This one only makes sense after the suggestion it depends on, which has not been applied.',
        409, { depends_on: row.depends_on });
    }
  }

  const current = targetRow(ctx, orgId, action, row.target_id);
  if (!current) {
    throw new ActionError('target_gone',
      'What this would have changed no longer exists.', 409);
  }

  const before = parseJson(row.before_state, {});
  const moved = drift(before, snapshot(action, current));
  if (moved.length) {
    // Narrowly scoped — see `snapshot`. This fires when something the action
    // reads or writes actually changed, not when any part of the row did.
    throw new ActionError('world_moved',
      'This changed since the suggestion was written, so confirming it would quietly overwrite '
      + 'whoever changed it. Ask again and you will get a suggestion about how things are now.',
      409, { drift: moved });
  }

  const payload = parseJson(row.payload, {});
  // Through the service layer. Every rule that protects a person's edit protects
  // this one, and a refusal here is a refusal the user sees.
  const result = applyThroughService(ctx, orgId, action, row, payload);

  const applied = ctx.db.update('action_proposal', row.id, {
    state: 'APPLIED', applied_at: ctx.now(), applied_by: ctx.auth.userId,
    // Both states captured from the REAL row, before and after.
    //
    // The after state is what makes undo safe, and deriving it from the payload
    // does not work: a payload field need not be a column. `reason` becomes
    // `na_reason`, and marking an item not applicable also clears its
    // `document_id` — an effect that appears in no payload at all. Comparing a
    // payload against the row therefore reports every applied action as having
    // been changed by somebody else.
    before_state: JSON.stringify(snapshot(action, current)),
    after_state: JSON.stringify(snapshot(action, targetRow(ctx, orgId, action, row.target_id))),
  });

  audit(ctx, orgId, 'actions.applied', 'action_proposal', row.id, {
    action_kind: row.action_kind, target_type: row.target_type, target_id: row.target_id,
    advisor: row.advisor_id,
  });

  return ok({
    proposal: present(ctx, orgId, applied),
    result: result?.body ?? null,
    undoable: action.writes.length > 0,
    note: action.writes.length
      ? 'Applied. You can undo this, and the previous values are kept so the undo restores what was '
        + 'actually there.'
      : 'Applied.',
  });
}

/**
 * The dispatch table.
 *
 * Every arm calls a public service function. If an arm ever reaches for
 * `ctx.db` directly, that action has stopped going through the rules that
 * govern the same change made by hand.
 */
function applyThroughService(ctx, orgId, action, row, payload) {
  switch (action.kind) {
    case 'CREATE_FOLDER':
      return dataroom.createFolder(ctx, orgId, {
        name: payload.name,
        parent_id: row.target_id === orgId ? null : row.target_id,
        stage: payload.stage, required: payload.required,
      });

    case 'MARK_ITEM_NOT_APPLICABLE':
      return dataroom.markNotApplicable(ctx, orgId, row.target_id, payload.reason);

    case 'ASSIGN_GAP_OWNER':
      return assessments.updateGap(ctx, orgId, row.target_id, { owner_user_id: payload.owner_user_id });

    case 'SET_GAP_DUE_DATE':
      return assessments.updateGap(ctx, orgId, row.target_id, { due_date: payload.due_date });

    case 'SET_GAP_CATEGORY':
      return assessments.updateGap(ctx, orgId, row.target_id, { category: payload.category });

    case 'SET_GAP_DONE_WHEN':
      return assessments.updateGap(ctx, orgId, row.target_id, { done_when: payload.done_when });

    case 'REORDER_FOLDER':
      return dataroom.updateFolder(ctx, orgId, row.target_id, { sort_key: payload.sort_key });

    case 'SET_FOLDER_STAGE':
      return dataroom.updateFolder(ctx, orgId, row.target_id, { stage: payload.stage });

    case 'DRAFT_PROSE':
      return prose.writeProse(ctx, orgId, payload.slot, payload.text, {
        // The person confirming is recorded as the author, because they are the
        // one who put it in the document.
        source: 'ADVISOR_DRAFTED_USER_APPROVED',
        cites: parseJson(row.cites, []),
        cited: citedContext(ctx, orgId, { cites: parseJson(row.cites, []) }),
        proposal_id: row.id,
      });

    case 'REQUEST_DOCUMENT':
      return dataroom.requestDocument(ctx, orgId, {
        item_id: row.target_id, recipient: payload.to ?? null,
        note: payload.note, proposal_id: row.id,
      });

    default:
      // Unreachable while the catalogue and this table agree, and a loud failure
      // if they ever stop agreeing.
      throw new ActionError('no_handler',
        `${action.kind} is in the catalogue but nothing applies it.`, 500);
  }
}

// ──────────────────────────────────────────────────────── rejecting, undoing ──

export function reject(ctx, orgId, proposalId, options = {}) {
  return usage.around(ctx, orgId, 'ACTION_CONFIRMED', () => doReject(ctx, orgId, proposalId, options));
}

function doReject(ctx, orgId, proposalId, { reason = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('action_proposal', proposalId), orgId);
  if (row.state !== 'PROPOSED') {
    throw new ActionError('not_rejectable', `This was already ${row.state.toLowerCase()}.`, 409);
  }

  const updated = ctx.db.update('action_proposal', row.id, {
    state: 'REJECTED', rejected_at: ctx.now(), rejected_by: ctx.auth.userId,
    reject_reason: reason ? String(reason).trim() : null,
  });
  // Kept, not deleted. "The advisor suggested this and we said no" is worth
  // being able to show, and it is the only signal that would tell anyone the
  // suggestions are poor.
  audit(ctx, orgId, 'actions.rejected', 'action_proposal', row.id,
    { action_kind: row.action_kind, reason: reason ?? null });
  return ok({ proposal: present(ctx, orgId, updated) });
}

/**
 * Undo an applied action.
 *
 * Restores the values that were actually there, and refuses if someone has
 * changed them since — undoing on top of someone else's edit is the same
 * silent overwrite the precondition exists to prevent, in the other direction.
 */
export function undo(ctx, orgId, proposalId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('action_proposal', proposalId), orgId);
  const action = actionFor(row.action_kind);

  if (row.state !== 'APPLIED') {
    throw new ActionError('not_undoable', `This is ${row.state.toLowerCase()}, not applied.`, 409);
  }
  if (!action || !action.writes.length) {
    // A create has nothing to put back, and a request has already been recorded
    // as something somebody may have acted on. Saying so is better than a button
    // that appears to work.
    throw new ActionError('not_reversible',
      `${action?.label ?? row.action_kind} cannot be undone automatically — it did not change a field `
      + 'that can simply be put back. Reverse it the way you would any other change.',
      409);
  }

  const current = targetRow(ctx, orgId, action, row.target_id);
  if (!current) throw new ActionError('target_gone', 'What this changed no longer exists.', 409);

  const before = parseJson(row.before_state, {});
  const after = parseJson(row.after_state, null);
  const nowState = snapshot(action, current);

  // Has anything moved since this action left it? Compared against what the row
  // ACTUALLY became, so the question is "is this still as I left it" rather
  // than "does this match what the advisor asked for" — which are different
  // whenever a service function adjusted the write on the way in.
  const changedSince = (after ? Object.keys(after) : [])
    .filter((f) => action.writes.includes(f))
    .filter((f) => String(after[f] ?? '') !== String(nowState[f] ?? ''))
    .map((f) => ({ field: f, expected: after[f] ?? null, found: nowState[f] ?? null }));

  if (changedSince.length) {
    throw new ActionError('changed_since_applied',
      'Somebody has changed this since the suggestion was applied, so undoing it would overwrite them '
      + 'as well. Change it back by hand if that is what you want.',
      409, { changed: changedSince });
  }

  const restore = inverseOf(action, before);
  // Through the service layer again. An undo is a change like any other.
  undoThroughService(ctx, orgId, action, row, restore);

  const updated = ctx.db.update('action_proposal', row.id, {
    state: 'UNDONE', undone_at: ctx.now(), undone_by: ctx.auth.userId,
  });
  audit(ctx, orgId, 'actions.undone', 'action_proposal', row.id,
    { action_kind: row.action_kind, restored: restore });

  return ok({ proposal: present(ctx, orgId, updated), restored: restore });
}

function undoThroughService(ctx, orgId, action, row, restore) {
  switch (action.kind) {
    case 'MARK_ITEM_NOT_APPLICABLE':
      // There is no "un-mark" service function, because a person undoes this by
      // satisfying the item or by clearing it — and the second does not exist as
      // a public call. Rather than invent a path only the advisor can take, the
      // restore is written here and audited as the ordinary change it is.
      ctx.db.update('data_room_item', row.target_id, {
        not_applicable: restore.not_applicable === null ? 0 : Number(restore.not_applicable),
        na_reason: restore.na_reason,
        document_id: restore.document_id,
      });
      audit(ctx, orgId, 'dataroom.item_not_applicable_undone', 'data_room_item', row.target_id, restore);
      return;

    case 'ASSIGN_GAP_OWNER':
      return assessments.updateGap(ctx, orgId, row.target_id, { owner_user_id: restore.owner_user_id });
    case 'SET_GAP_DUE_DATE':
      return assessments.updateGap(ctx, orgId, row.target_id, { due_date: restore.due_date });
    case 'SET_GAP_CATEGORY':
      return assessments.updateGap(ctx, orgId, row.target_id, { category: restore.category });
    case 'SET_GAP_DONE_WHEN':
      return assessments.updateGap(ctx, orgId, row.target_id, { done_when: restore.done_when });

    case 'REORDER_FOLDER':
      return dataroom.updateFolder(ctx, orgId, row.target_id, { sort_key: restore.sort_key });
    case 'SET_FOLDER_STAGE':
      return dataroom.updateFolder(ctx, orgId, row.target_id, { stage: restore.stage });

    default:
      throw new ActionError('not_reversible',
        `${action.label} cannot be undone automatically.`, 409);
  }
}

// ──────────────────────────────────────────────────────────────── catalogue ──

/**
 * What the advisor is allowed to do, for anyone who wants to know.
 *
 * Including the list of what it cannot touch. A user deciding whether to trust
 * this feature should be able to read the boundary rather than be told there is
 * one.
 */
export function catalogue(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  return ok({
    actions: ACTION_KINDS.map((kind) => {
      const a = ACTIONS[kind];
      return {
        kind, label: a.label, target: a.target,
        writes: a.writes, reversible: a.writes.length > 0,
      };
    }),
    never_touches: FORBIDDEN_TARGETS,
    ttl_days: PROPOSAL_TTL_DAYS,
    max_batch: MAX_BATCH,
    rule: 'The advisor proposes; you decide. It cannot write or change a figure — not through an '
        + 'action, and not by writing one into prose. Numbers change only where they always have: on '
        + 'the confirmation screen, with the document they came from beside them.',
  });
}

export { ActionError };
