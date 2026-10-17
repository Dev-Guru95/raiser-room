/**
 * The fact library, and the repair path out of a refused sentence.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FRICTION THIS REMOVES, AND THE RULE IT DOES NOT
 *
 * Writing a figure into a document is refused unless it resolves from a
 * confirmed fact. That rule stays exactly as it is. What was wrong was not the
 * refusal but what came after it: a message explaining the policy and then
 * nothing, leaving the writer to go and find a form, invent a key, and come back
 * to a sentence they have lost the thread of.
 *
 * A rule people respect is one that tells them what to do next. So every refused
 * numeral now comes back with one of two things:
 *
 *   · **You already have this.** The commonest case by far, and the one that
 *     makes the rule feel like help rather than bureaucracy. If a confirmed fact
 *     already holds 4,200,000 and the writer typed "$4.2m", the answer is not
 *     "record a fact" — it is "that is your TTM revenue; insert the reference?".
 *
 *   · **Here is the one you are about to make.** Named, with the value and unit
 *     read off how the figure was written and a label taken from the words
 *     around it, plus the exact text to put in its place. The writer confirms a
 *     draft rather than filling in a form.
 *
 * Neither path weakens anything. The fact still has to be recorded, and a figure
 * from a document still has to be confirmed against it before a document will
 * use it. What changed is that the product now does the typing.
 */

import { authorise, AccessError } from '../domain/access.js';
import { usableFacts, UNITS } from '../domain/facts.js';
import { ILLUSTRATIVE_MARKER_KEY } from '../domain/illustrative.js';
import { parseNumeral, rendersValue } from '../domain/advisor.js';
import {
  KEY_GROUPS, groupOf, groupNameOf, suggestKey, labelFromKey,
  unitFromNotation, labelFromContext,
} from '../domain/factkeys.js';
import { createFact } from './service.js';
import { checkProse, factRefsIn, withoutFactRefs } from './prose.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

const NUMERAL = /(?:[$£€]\s?)?\d[\d,]*(?:\.\d+)?\s*(?:%|bn|billion|m\b|million|k\b|thousand)?/gi;

// ────────────────────────────────────────────────────────────── the library ──

/**
 * Every fact the organisation holds, arranged so a person can find one.
 *
 * `listFacts` returns a flat array sorted by key, which is a correct answer to a
 * question nobody asks. Someone looking for "that revenue figure" wants it under
 * a heading they recognise, next to the others like it, with a note of whether it
 * is actually usable yet.
 */
export function factLibrary(ctx, orgId, { query = null, group = null, limit = 500 } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');

  const all = ctx.db.find('fact', { org_id: orgId })
    .filter((f) => !f.superseded_by)
    // The worked-example marker is a fact so that it travels with the data —
    // into the export, into the audit trail, into any copy of the database. It
    // is not a figure, and in the library it appeared as one: a referenceable
    // entry whose value was the whole illustrative-example notice, offered
    // under "write this in a sentence and the document fills it in". Nobody
    // wants that in a paragraph. It is excluded here rather than renamed,
    // because a bookkeeping fact is a bookkeeping fact whatever it is called.
    .filter((f) => f.fact_key !== ILLUSTRATIVE_MARKER_KEY);
  const usable = new Set(usableFacts(all).map((f) => f.id));
  const used = usageCounts(ctx, orgId);

  const matched = all
    .filter((f) => (group ? groupOf(f.fact_key) === group : true))
    .filter((f) => matches(f, query))
    .sort((a, b) => a.fact_key.localeCompare(b.fact_key))
    .slice(0, limit)
    .map((f) => present(f, { usable: usable.has(f.id), uses: used.get(f.fact_key) ?? 0 }));

  // Grouped for display, but the flat list is returned too — a search result is
  // a list, and forcing it into headings makes three matches look like a filing
  // system.
  const groups = KEY_GROUPS
    .map((g) => ({
      ...g,
      facts: matched.filter((f) => f.group === g.key),
    }))
    .filter((g) => g.facts.length);

  const ungrouped = matched.filter((f) => !f.group);
  if (ungrouped.length) {
    groups.push({ key: null, name: 'Other', hint: 'Facts whose key does not start with a known group.', facts: ungrouped });
  }

  const awaiting = all.filter((f) => !usable.has(f.id));

  return ok({
    facts: matched,
    groups,
    total: matched.length,
    // Surfaced rather than buried: an extraction nobody has confirmed is the
    // commonest reason a document will not generate, and the commonest reason a
    // writer is told a figure they can see on screen cannot be used.
    awaiting_confirmation: awaiting.map((f) => present(f, { usable: false, uses: 0 })),
    awaiting_count: awaiting.length,
    all_groups: KEY_GROUPS,
    units: UNITS,
  });
}

function matches(fact, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = `${fact.fact_key} ${fact.label} ${fact.value_text ?? ''}`.toLowerCase();
  // Every word has to appear somewhere, so "gross margin" does not match a fact
  // that merely mentions margin.
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * How often each fact is referenced.
 *
 * Shown because a fact used in four documents is one you think twice about
 * superseding, and a fact used nowhere is a candidate for tidying.
 */
function usageCounts(ctx, orgId) {
  const counts = new Map();
  for (const block of ctx.db.find('prose_block', { org_id: orgId })) {
    if (block.superseded_by) continue;
    for (const key of factRefsIn(block.body)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const present = (f, { usable, uses }) => ({
  id: f.id,
  fact_key: f.fact_key,
  label: f.label || labelFromKey(f.fact_key),
  group: groupOf(f.fact_key),
  group_name: groupNameOf(f.fact_key),
  value_numeric: f.value_numeric,
  value_text: f.value_text,
  value_date: f.value_date,
  unit: f.unit,
  source: f.source,
  source_doc_id: f.source_doc_id,
  source_page: f.source_page,
  period_start: f.period_start,
  period_end: f.period_end,
  usable,
  // Said plainly, because "DOCUMENT_EXTRACTED" means nothing to the person who
  // uploaded the file and is wondering why their figure will not go in.
  why_not_usable: usable ? null
    : 'This was read from a document and nobody has confirmed it yet. Confirm it and it becomes '
      + 'usable everywhere.',
  uses,
  reference: `{{fact:${f.fact_key}}}`,
  created_at: f.created_at,
});

/**
 * Autocomplete for someone typing `{{fact:` into a sentence.
 *
 * Matches the key and the label, because a writer thinks "gross margin" and the
 * key is `financials.gross_margin` — requiring them to know the key would make
 * the reference syntax a thing you have to memorise.
 */
export function suggestFacts(ctx, orgId, prefix, { limit = 8 } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const usable = usableFacts(ctx.db.find('fact', { org_id: orgId })
    .filter((f) => !f.superseded_by)
    .filter((f) => f.fact_key !== ILLUSTRATIVE_MARKER_KEY));

  const q = String(prefix ?? '').trim().toLowerCase();
  const scored = usable
    .map((f) => ({ fact: f, score: matchScore(f, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.fact.fact_key.localeCompare(b.fact.fact_key))
    .slice(0, limit);

  return ok({
    suggestions: scored.map((x) => ({
      fact_key: x.fact.fact_key,
      label: x.fact.label || labelFromKey(x.fact.fact_key),
      group_name: groupNameOf(x.fact.fact_key),
      preview: previewValue(x.fact),
      insert: `{{fact:${x.fact.fact_key}}}`,
    })),
  });
}

function matchScore(fact, q) {
  if (!q) return 1;
  const key = fact.fact_key.toLowerCase();
  const label = String(fact.label ?? '').toLowerCase();
  if (key.startsWith(q)) return 4;
  if (label.startsWith(q)) return 3;
  if (key.includes(q)) return 2;
  if (label.includes(q)) return 1;
  return 0;
}

const previewValue = (f) => {
  if (f.value_numeric !== null && f.value_numeric !== undefined) {
    return f.unit === 'percent' ? `${f.value_numeric}%` : String(f.value_numeric);
  }
  return f.value_text ?? f.value_date ?? '—';
};

// ───────────────────────────────────────────────────────── the repair path ──

/**
 * Check a passage and, for anything refused, say what to do about it.
 *
 * This is what a writing surface calls as the user types. It returns the same
 * refusals `checkProse` does, plus a repair for each one — so the interface can
 * show "you already have this" or "save this and carry on" rather than a policy
 * statement.
 */
export function checkAndRepair(ctx, orgId, body) {
  authorise(membershipOf(ctx, orgId), 'read');

  const text = String(body ?? '');
  const problems = checkProse(ctx, orgId, text);
  const unaccounted = problems.find((p) => p.code === 'unaccounted_numerals')?.numerals ?? [];

  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }).filter((f) => !f.superseded_by));
  const existingKeys = ctx.db.find('fact', { org_id: orgId }).map((f) => f.fact_key);

  const repairs = unaccounted.map((token) => repairFor(ctx, { token, text, facts, existingKeys }));

  return ok({
    ok: problems.length === 0,
    problems,
    repairs,
    fact_refs: factRefsIn(text),
    // The encouraging half of the message, and it is true: most of the time the
    // figure is already there.
    summary: summarise(repairs),
  });
}

function summarise(repairs) {
  if (!repairs.length) return 'Every figure here resolves from a confirmed fact.';
  const matched = repairs.filter((r) => r.matches.length).length;
  const n = repairs.length;
  const figures = `${n} figure${n === 1 ? '' : 's'}`;
  if (matched === n) {
    return `${figures} already ${n === 1 ? 'exists' : 'exist'} in your facts — insert the reference and `
      + 'the figure stays right when the fact is updated.';
  }
  if (matched) {
    return `${matched} of ${n} figures already exist in your facts. The ${n - matched === 1 ? 'other is' : 'others are'} `
      + 'filled in ready to save.';
  }
  return `${figures} ${n === 1 ? 'is' : 'are'} not recorded yet. Each one is filled in ready to save — `
    + 'one click and the sentence keeps the figure, with the source attached.';
}

/**
 * One refused figure, and the ways out of it.
 *
 * `matches` first, because a figure the company already holds is the common case
 * and the one where the right answer is not to create anything.
 */
function repairFor(ctx, { token, text, facts, existingKeys }) {
  const parsed = parseNumeral(token);
  const unit = unitFromNotation(token);
  const label = labelFromContext(text, token) || 'Figure';

  const matches = parsed
    ? facts
      .filter((f) => f.value_numeric !== null && f.value_numeric !== undefined)
      .filter((f) => rendersValue(parsed, Number(f.value_numeric)))
      // A percentage written as "40%" should not match a dollar figure of 40.
      .filter((f) => (unit === 'percent' ? f.unit === 'percent' : f.unit !== 'percent' || !unit))
      .map((f) => ({
        fact_key: f.fact_key,
        label: f.label || labelFromKey(f.fact_key),
        value_numeric: f.value_numeric,
        unit: f.unit,
        group_name: groupNameOf(f.fact_key),
        // The replacement, computed rather than described, so the interface
        // does the edit instead of telling the user how to.
        replace_with: `{{fact:${f.fact_key}}}`,
        source: f.source,
      }))
    : [];

  return {
    numeral: token,
    parsed_value: parsed?.value ?? null,
    matches,
    // Offered whether or not something matched: the figure may genuinely be a
    // different thing that happens to share a value.
    draft: parsed
      ? {
        fact_key: suggestKey(label, { existing: existingKeys }),
        label,
        value_numeric: parsed.value,
        unit: unit ?? (parsed.isPercent ? 'percent' : null),
        // USER_ENTERED, not confirmed. A figure typed into a sentence is
        // something the writer asserts, not something a document evidences, and
        // recording it as confirmed would manufacture provenance that does not
        // exist.
        source: 'USER_ENTERED',
        needs: unit ? [] : ['unit'],
      }
      : null,
    guidance: matches.length
      ? 'You already have this figure. Insert the reference and it will stay right when the fact changes.'
      : 'Save this as a fact and the sentence keeps the figure — with a source attached, and updating '
        + 'itself when the figure does.',
  };
}

/**
 * Record a fact and repair the sentence in one go.
 *
 * The call a "save and insert" button makes. Doing it in one step is the whole
 * point: a writer who has to save a fact, find their sentence again and edit the
 * reference in by hand has been given a worse version of typing the number.
 */
export function recordAndInsert(ctx, orgId, input = {}) {
  return usage.around(ctx, orgId, 'FACT_RECORDED', () => doRecordAndInsert(ctx, orgId, input));
}

function doRecordAndInsert(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const body = String(input.body ?? '');
  const numeral = String(input.numeral ?? '');
  if (!body || !numeral) {
    throw new AccessError('nothing_to_repair', 400, {
      detail: 'Repairing a sentence needs the sentence and the figure in it.',
    });
  }
  if (!body.includes(numeral)) {
    throw new AccessError('numeral_not_in_text', 400, {
      detail: `"${numeral}" is not in that text, so there is nothing to replace.`,
    });
  }

  // Either use a fact that exists, or make one. Both routes go through the
  // ordinary fact service — there is no shortcut path that writes a fact row.
  let factKey = input.fact_key ?? null;
  let created = null;

  if (!input.use_existing) {
    const draft = input.fact ?? {};
    created = createFact(ctx, orgId, {
      fact_key: draft.fact_key,
      label: draft.label,
      value_numeric: draft.value_numeric,
      value_text: draft.value_text,
      value_date: draft.value_date,
      unit: draft.unit ?? null,
      period_start: draft.period_start ?? null,
      period_end: draft.period_end ?? null,
      // A figure a person typed is USER_ENTERED. It cannot be USER_CONFIRMED
      // here, because confirmation is a statement about a document and there is
      // no document in this flow.
      source: 'USER_ENTERED',
    }).body.fact;
    factKey = created.fact_key;
  }

  if (!factKey) throw new AccessError('no_fact', 400, { detail: 'Nothing to insert.' });

  // First occurrence only. Replacing every instance would silently rewrite a
  // second, unrelated use of the same figure elsewhere in the passage.
  const repaired = body.replace(numeral, `{{fact:${factKey}}}`);

  const remaining = checkProse(ctx, orgId, repaired);
  return ok({
    body: repaired,
    fact: created,
    fact_key: factKey,
    inserted: `{{fact:${factKey}}}`,
    ok: remaining.length === 0,
    problems: remaining,
    note: remaining.length
      ? 'That figure is sorted. There are others in this passage still to do.'
      : 'Done — every figure in this passage now resolves from a fact.',
  }, created ? 201 : 200);
}

/**
 * What the writing surface should say before anyone has made a mistake.
 *
 * The rule is much easier to accept when it arrives as an explanation of how
 * writing here works than as an error after the fact. This is the copy for that,
 * kept beside the logic so the two cannot drift apart.
 */
export function writingGuide(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const count = usableFacts(ctx.db.find('fact', { org_id: orgId }).filter((f) => !f.superseded_by)).length;

  return ok({
    headline: 'Write the sentence. Pick the figure.',
    body: 'Type `{{` wherever a number goes and choose from your facts. The document fills in the '
        + 'value when it renders, at the right precision — and if that figure is later corrected, '
        + 'every document carrying it corrects itself.',
    why: 'Every document this product generates says that none of its figures were typed. That is the '
       + 'claim an investor is relying on when they stop checking your deck against your accounts, so '
       + 'it has to be true of every figure, including the ones in sentences.',
    if_you_type_one: 'Nothing is lost. The figure is read off what you wrote, named from the words '
                   + 'around it, and offered back as a fact to save — or matched to one you already '
                   + 'have. It is one click either way.',
    facts_available: count,
    // The empty state is the one that needs the most care: a writer with no
    // facts yet should be told what to do, not shown an empty list.
    empty_state: count === 0
      ? 'You have no confirmed facts yet, so there is nothing to reference. Upload your accounts and '
        + 'confirm what the extractor finds, or record a figure by hand — either way it takes a minute '
        + 'and then every document can use it.'
      : null,
  });
}
