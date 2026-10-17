/**
 * Prose written into generated documents.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY PROSE IS NOT JUST TEXT
 *
 * Every generated document carries the same claim: *every figure in this
 * document is a reference into your fact store; nothing was typed*. Charts and
 * tables honour that structurally — they resolve fact references and cannot do
 * anything else.
 *
 * Prose is the hole in that. A paragraph is free text, and free text can contain
 * "revenue grew to $4.2m". The moment one does, the document's central claim is
 * false, and it is false in the least detectable way: a true sentence, in the
 * right tone, in a document that otherwise cannot lie.
 *
 * So the number rule applies to prose, and it applies to EVERYONE — the advisor,
 * because an advisor originating a figure is the failure this architecture
 * exists to prevent, and the user, because the claim on the document does not
 * say "except where the founder typed it".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE WAY THROUGH IS NOT AN OVERRIDE
 *
 * `{{fact:financials.revenue.ttm}}` resolves at render time to the bound value,
 * at the right precision, from the fact store. So a user who wants a figure in a
 * sentence writes the reference and gets the figure — and it stays correct when
 * the underlying fact is superseded, which a typed number does not.
 *
 * That is why there is no override. Being told "record it as a fact first" is
 * the product working, not the product obstructing: a figure worth putting in
 * front of an investor is a figure worth having provenance for, and the writer
 * who types it instead is the one who will be asked where it came from.
 */

import { authorise, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import { unaccountedNumerals, parseNumeral, rendersValue } from '../domain/advisor.js';
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

/**
 * Where prose can come from.
 *
 * Two values, and there will never be a third. There is no ADVISOR_WRITTEN,
 * exactly as `fact.source` has no AI_GENERATED: prose the advisor drafted
 * becomes ADVISOR_DRAFTED_USER_APPROVED when a named person confirms it, and
 * before that it is a proposal rather than prose.
 */
export const PROSE_SOURCES = Object.freeze(['USER_WRITTEN', 'ADVISOR_DRAFTED_USER_APPROVED']);

/** Slots a document knows how to render. */
export const PROSE_SLOTS = Object.freeze(['default', 'market', 'assumptions']);

const FACT_REF = /\{\{\s*fact:([a-z0-9_.]+)\s*\}\}/gi;

const NUMERAL = /(?:[$£€]\s?)?\d[\d,]*(?:\.\d+)?\s*(?:%|bn|billion|m\b|million|k\b|thousand)?/gi;

/**
 * Numerals that a fact DOES account for but which were written out by hand.
 *
 * These are the near misses — a writer who knew the figure and typed it. They
 * are refused like any other typed figure, and they are the easiest ones to fix,
 * because the fact to reference already exists.
 */
function typedLiterals(text, context) {
  const found = String(withoutFactRefs(text)).match(NUMERAL) ?? [];
  const out = [];
  for (const token of found) {
    const parsed = parseNumeral(token);
    if (!parsed) continue;
    const known = (context.facts ?? []).some((f) =>
      f.value_numeric !== null && f.value_numeric !== undefined
      && rendersValue(parsed, Number(f.value_numeric)));
    if (known) out.push(parsed.raw.trim());
  }
  return [...new Set(out)];
}

/**
 * Strip fact references before counting numerals.
 *
 * A reference is not a figure — it is a promise to go and get one. Leaving the
 * key in would also hand the numeral checker things like `top1` and `2025` out
 * of fact keys, which it would rightly complain about.
 */
export const withoutFactRefs = (text) => String(text ?? '').replace(FACT_REF, ' ');

/** The fact keys a passage refers to. */
export function factRefsIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(FACT_REF)) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * Check a passage against the number rule and against what the org actually has.
 *
 * Returns problems rather than throwing, so a writing surface can show them as
 * you type instead of on save.
 */
export function checkProse(ctx, orgId, body, { cited = null } = {}) {
  const problems = [];
  const text = String(body ?? '');

  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const byKey = new Map(facts.map((f) => [f.fact_key, f]));

  for (const key of factRefsIn(text)) {
    if (!byKey.has(key)) {
      // A reference to a fact that is not there renders as nothing, which is a
      // sentence with a hole in it arriving at an investor.
      problems.push({
        code: 'unknown_fact_reference',
        problem: `There is no confirmed fact called "${key}", so that reference would render as a `
               + 'blank. Record and confirm the figure first.',
        fact_key: key,
      });
    }
  }

  // STRICTER THAN THE ADVISOR'S RULE, DELIBERATELY.
  //
  // An advisor's chat answer may write a figure it cited: a reply is a snapshot
  // of a conversation on a date, and quoting a fact into it is quoting, not
  // originating.
  //
  // A document is not a snapshot. It regenerates, and it is read months later by
  // someone deciding whether to wire money. A literal "$4.2m" that happens to
  // match today's revenue is still a typed figure: correct the fact to 4.3m and
  // the charts move while the sentence does not, which is the contradiction this
  // whole architecture exists to prevent — now in the one place a reader is most
  // likely to believe without checking.
  //
  // So in prose, matching a fact is not enough. The numeral has to BE the
  // reference. Nothing is lost by that: the checker below hands every refused
  // figure to `factlib`, which matches it against the facts already held and
  // offers the replacement, so the common case is one click rather than any
  // work at all.
  const context = cited ?? { facts, figures: [], criteria: [], records: [] };
  const unaccounted = unaccountedNumerals(withoutFactRefs(text), context);
  const literals = typedLiterals(text, context);
  const refused = [...new Set([...unaccounted, ...literals])];

  if (refused.length) {
    problems.push({
      code: 'unaccounted_numerals',
      problem: `${refused.length === 1 ? 'A figure' : 'Figures'} here (${refused.join(', ')}) `
             + 'would be typed into the document rather than resolved from a fact. Every document this '
             + 'product generates says that none of its figures were typed — so write '
             + '{{fact:your.key}} instead, and it will render the confirmed value and keep rendering '
             + 'the right one after the fact is corrected, which a typed number does not.',
      numerals: refused,
      // Separated so an interface can say "you already have this" for the second
      // group rather than treating both the same.
      unknown: unaccounted,
      typed_but_known: literals,
    });
  }

  return problems;
}

/**
 * Write prose into a slot.
 *
 * Immutable with supersession, as facts are. Editing a paragraph writes a new
 * row and points the old one at it, so "what did this deck say in March" stays
 * answerable after the deck has been rewritten twice.
 */
export function writeProse(ctx, orgId, slot, body, options = {}) {
  return usage.around(ctx, orgId, 'PROSE_WRITTEN', () => doWriteProse(ctx, orgId, slot, body, options));
}

function doWriteProse(ctx, orgId, slot, body, options = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const slotName = String(slot ?? '').trim();
  if (!slotName) throw new AccessError('slot_required', 400);

  const text = String(body ?? '').trim();
  if (!text) throw new AccessError('empty_prose', 400, { detail: 'There is nothing to write.' });

  const source = options.source ?? 'USER_WRITTEN';
  if (!PROSE_SOURCES.includes(source)) {
    throw new AccessError('invalid_prose_source', 400, { allowed: PROSE_SOURCES });
  }

  const problems = checkProse(ctx, orgId, text, { cited: options.cited ?? null });
  if (problems.length) {
    throw new AccessError('prose_rejected', 400, { problems });
  }

  const current = currentFor(ctx, orgId, slotName);
  const row = ctx.db.insert('prose_block', {
    org_id: orgId, slot: slotName, body: text, source,
    cites: options.cites ? JSON.stringify(options.cites) : null,
    // Always a human. For advisor-drafted prose this is whoever confirmed it,
    // because that is the person who put it in the document.
    author_id: ctx.auth.userId,
    proposal_id: options.proposal_id ?? null,
    superseded_by: null, created_at: ctx.now(),
  });
  if (current) ctx.db.update('prose_block', current.id, { superseded_by: row.id });

  audit(ctx, orgId, 'prose.written', 'prose_block', row.id, {
    slot: slotName, source, supersedes: current?.id ?? null,
    fact_refs: factRefsIn(text),
  });
  return ok({ prose: present(row), supersedes: current?.id ?? null }, 201);
}

const currentFor = (ctx, orgId, slot) =>
  ctx.db.find('prose_block', { org_id: orgId, slot }).find((p) => !p.superseded_by) ?? null;

const present = (row) => ({
  id: row.id, slot: row.slot, body: row.body, source: row.source,
  cites: row.cites ? JSON.parse(row.cites) : null,
  author_id: row.author_id, proposal_id: row.proposal_id,
  fact_refs: factRefsIn(row.body),
  created_at: row.created_at,
});

/** Current prose for every slot, in the shape artifact generation expects. */
export function proseForGeneration(ctx, orgId) {
  const rows = ctx.db.find('prose_block', { org_id: orgId }).filter((p) => !p.superseded_by);
  const out = {};
  for (const row of rows) {
    // A slot holds paragraphs; blank lines separate them, as anyone writing in
    // a text box expects.
    out[row.slot] = row.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  return out;
}

export function listProse(ctx, orgId, { slot = null, includeSuperseded = false } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const rows = ctx.db.find('prose_block', { org_id: orgId })
    .filter((p) => (slot ? p.slot === slot : true))
    .filter((p) => includeSuperseded || !p.superseded_by)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return ok({ prose: rows.map(present), total: rows.length });
}

/** Preview the check without writing, for a live editor. */
export function previewProse(ctx, orgId, body) {
  authorise(membershipOf(ctx, orgId), 'read');
  const problems = checkProse(ctx, orgId, body);
  return ok({
    ok: problems.length === 0,
    problems,
    fact_refs: factRefsIn(body),
  });
}
