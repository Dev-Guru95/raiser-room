/**
 * Phase 4 — the advisor service.
 *
 * The valuable part of this file is `buildContext`. An advisor that answers
 * "what should I do next?" from general knowledge is worth nothing, because the
 * user can get that anywhere. An advisor that answers it from this company's
 * own gap register, in the published fix order, citing the criterion behind
 * each item and the figures they confirmed themselves, is answering a question
 * nothing else can answer.
 *
 * So the context is assembled from the organisation's actual state, and the
 * validator then makes that context the only world the answer may draw on.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import { criterionByRef } from '../domain/criteria.js';
import { score, bandMeaning } from '../domain/assessment.js';
import { sortGaps } from '../domain/gaps.js';
import {
  screenQuestion, validateDraft, renderAnswer, AdvisorError, REFUSALS,
} from '../domain/advisor.js';
import { buildKnowledgeContext } from '../knowledge/retrieve.js';
import { CORPUS_VERSION, knowledgeHealth, SOURCES } from '../knowledge/corpus.js';
import { assertAdvisor } from '../advisor/interface.js';
import { requireEntitlement } from './billing.js';
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

const MAX_QUESTION = 2_000;
const MAX_FACTS_IN_CONTEXT = 60;

// ─────────────────────────────────────────────────────────── context ──

/**
 * Assemble the entire permitted world for one answer.
 *
 * Note what is NOT here: anything belonging to another organisation, in any
 * form. There is no aggregate, no benchmark and no cohort, and the absence is
 * structural — this function only ever reads rows scoped to `orgId`.
 */
export function buildContext(ctx, orgId, question, { limit = 5 } = {}) {
  const asOf = ctx.now();

  // ── the organisation's own facts ──
  // Through `usableFacts`, so an extraction awaiting confirmation cannot be
  // quoted back as though it were established. The advisor must not be able to
  // repeat a figure the user has not yet looked at.
  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }))
    .sort((a, b) => a.fact_key.localeCompare(b.fact_key))
    .slice(0, MAX_FACTS_IN_CONTEXT);

  // ── the latest completed assessment, and the figures it produced ──
  const assessments = ctx.db.find('assessment', { org_id: orgId })
    .filter((a) => a.is_complete)
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const latest = assessments[0] ?? null;

  const figures = [];
  let result = null;

  if (latest) {
    result = score(JSON.parse(latest.scores), { partial: true });
    figures.push({
      ref: `assessment:${latest.id}.total`,
      label: `Your weighted readiness total (${latest.band})`,
      value: latest.total_weighted,
    });
    for (const d of result.domains ?? []) {
      figures.push({
        ref: `assessment:${latest.id}.domain.${d.domain}`,
        label: `Your score for domain ${d.domain}, ${d.name}`,
        value: d.raw,
      });
    }
    for (const [ref, value] of Object.entries(JSON.parse(latest.scores))) {
      if (value === null || value === undefined || value === '') continue;
      figures.push({
        ref: `assessment:${latest.id}.criterion.${ref}`,
        label: `Your score for criterion ${ref}`,
        value: Number(value),
      });
    }
  }

  // ── open gaps, in fix order ──
  const openGaps = sortGaps(ctx.db.find('gap', { org_id: orgId }).filter((g) => !g.closed_at));

  // ── retrieval, steered by what they are actually working on ──
  const knowledge = buildKnowledgeContext(question, {
    criterionRefs: openGaps.map((g) => g.criterion_ref),
    gapCategories: openGaps.map((g) => g.category),
  }, { limit, asOf });

  return {
    facts,
    records: knowledge.records,
    figures,
    gaps: openGaps,
    asOf,
    assessment: latest
      ? {
        id: latest.id, band: latest.band, band_means: bandMeaning(latest.band),
        total_weighted: latest.total_weighted, capped: !!latest.capped,
        completed_at: latest.completed_at,
      }
      : null,
    knowledge_empty: knowledge.empty,
    overdue_records: knowledge.overdue,
    corpus_version: CORPUS_VERSION,
  };
}

// ───────────────────────────────────────────────────────────── threads ──

export function createThread(ctx, orgId, { title } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const name = String(title ?? '').trim() || 'Untitled';
  if (name.length > 160) throw new AccessError('invalid_title', 400);

  const thread = ctx.db.insert('advisor_thread', {
    org_id: orgId, title: name, created_by: ctx.auth.userId, closed_at: null, created_at: ctx.now(),
  });
  audit(ctx, orgId, 'advisor.thread_created', 'advisor_thread', thread.id, { title: name });
  return ok({ thread }, 201);
}

export function listThreads(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const threads = ctx.db.find('advisor_thread', { org_id: orgId })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return ok({
    threads: threads.map((t) => ({
      ...t, messages: ctx.db.count('advisor_message', { thread_id: t.id }),
    })),
  });
}

export function getThread(ctx, orgId, threadId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const thread = assertBelongsToOrg(ctx.db.get('advisor_thread', threadId), orgId);
  const messages = ctx.db.find('advisor_message', { thread_id: threadId })
    .sort((a, b) => a.seq - b.seq)
    .map(present);
  return ok({ thread, messages });
}

/**
 * Every answer keeps its workings.
 *
 * The draft, the citations, the model identity and the corpus edition are all
 * stored, so "why did the app tell me that, and was it right at the time?" is
 * answerable later by somebody who was not there — after the model has been
 * replaced and the corpus revised.
 */
function present(row) {
  return {
    id: row.id, seq: row.seq, question: row.question, answer: row.answer_text,
    refused: !!row.refused, refusal_code: row.refusal_code,
    rejected_reason: row.rejected_reason,
    citations: row.citations ? JSON.parse(row.citations) : [],
    answered_by: { id: row.advisor_id, version: row.advisor_version },
    knowledge_version: row.knowledge_version,
    asked_by: row.asked_by, created_at: row.created_at,
  };
}

// ─────────────────────────────────────────────────────────── the turn ──

/**
 * Ask the advisor a question.
 *
 * Order of operations, each step chosen for a reason:
 *
 *   1. Screen the question. A refusal is deterministic and costs no model call,
 *      so it cannot later be softened on cost grounds.
 *   2. Build the context from the organisation's own state.
 *   3. Call the advisor with that context and nothing else.
 *   4. Validate. A draft that fails is REJECTED and retried once with the
 *      problems fed back; a second failure is reported as a failure.
 *   5. Render ourselves, so citations cannot be formatted away.
 */
export async function ask(ctx, orgId, threadId, question, advisor, options = {}) {
  // A screened or uncovered question comes back as a 200 carrying a refusal, so
  // the counter has to read the body rather than wait for a throw. The refusal
  // rate is the number this capability is instrumented for: it is how you find
  // out whether the advisor is declining things people reasonably expect it to
  // answer, which no amount of volume data would show.
  return usage.aroundAsync(ctx, orgId, 'ADVISOR_ASKED',
    () => doAsk(ctx, orgId, threadId, question, advisor, options),
    { refusedWhen: (result) => result.body.refused === true });
}

async function doAsk(ctx, orgId, threadId, question, advisor, { retries = 1 } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  // Asking is a write — it stores an answer. Reading the thread you already
  // have is not gated.
  requireEntitlement(ctx, orgId, 'ADVISOR');
  assertAdvisor(advisor);
  const thread = assertBelongsToOrg(ctx.db.get('advisor_thread', threadId), orgId);
  if (thread.closed_at) throw new AccessError('thread_closed', 409);

  const text = String(question ?? '').trim();
  if (!text) throw new AdvisorError('question_required', 'a question is required');
  if (text.length > MAX_QUESTION) throw new AdvisorError('question_too_long', `questions are limited to ${MAX_QUESTION} characters`);

  const seq = ctx.db.count('advisor_message', { thread_id: threadId }) + 1;

  // ── 1 · screen ──
  const screen = screenQuestion(text);
  if (screen.refused) {
    const row = write(ctx, orgId, threadId, seq, text, {
      answer_text: screen.says, refused: 1, refusal_code: screen.code,
      advisor_id: advisor.id, advisor_version: advisor.version,
    });
    audit(ctx, orgId, 'advisor.refused', 'advisor_message', row.id, { code: screen.code });
    return ok({ message: present(row), refused: true, code: screen.code }, 200);
  }

  // ── 2 · context ──
  const context = buildContext(ctx, orgId, text);

  if (context.knowledge_empty) {
    // An honest outcome, and an important one. A question the corpus does not
    // cover gets "there is nothing recorded on this", never an answer the model
    // assembled from its own recollection — which would be indistinguishable
    // from a good answer and is the failure this architecture exists to prevent.
    const says =
      'There is nothing in the knowledge base covering that, so there is no sourced answer to give. '
      + 'Everything the advisor says is drawn from a dated, versioned record, and it does not fall back on '
      + 'what a model happens to remember — an unsourced answer here would look exactly like a sourced one. '
      + 'Try naming the criterion you are working on, or ask about what you are preparing rather than about '
      + 'the market.';
    const row = write(ctx, orgId, threadId, seq, text, {
      answer_text: says, refused: 1, refusal_code: 'not_covered',
      advisor_id: advisor.id, advisor_version: advisor.version,
    });
    audit(ctx, orgId, 'advisor.not_covered', 'advisor_message', row.id, { question_length: text.length });
    return ok({ message: present(row), refused: true, code: 'not_covered' }, 200);
  }

  // ── 3 and 4 · answer, validate, retry once ──
  const history = ctx.db.find('advisor_message', { thread_id: threadId })
    .sort((a, b) => a.seq - b.seq)
    .map((m) => ({ question: m.question, answer: m.answer_text }));

  let attempt = 0;
  let problems = null;

  while (attempt <= retries) {
    let draft;
    try {
      draft = await advisor.answer({ question: text, context, history, problems });
    } catch (err) {
      throw new AdvisorError('advisor_failed', `the advisor could not answer: ${err?.message ?? err}`, 502);
    }

    if (draft?.cannot_answer) {
      const says = `The advisor could not answer that from your records and the knowledge base: `
                 + `${draft.cannot_answer.why}`;
      const row = write(ctx, orgId, threadId, seq, text, {
        answer_text: says, refused: 1, refusal_code: 'cannot_answer',
        advisor_id: advisor.id, advisor_version: advisor.version,
      });
      return ok({ message: present(row), refused: true, code: 'cannot_answer' }, 200);
    }

    const validation = validateDraft(draft, context, { asOf: context.asOf });

    if (validation.ok) {
      const answer = renderAnswer(draft, validation);
      const row = write(ctx, orgId, threadId, seq, text, {
        answer_text: answer, draft: JSON.stringify(draft),
        citations: JSON.stringify(validation.cites),
        advisor_id: advisor.id, advisor_version: advisor.version,
      });
      audit(ctx, orgId, 'advisor.answered', 'advisor_message', row.id, {
        claims: validation.claims, citations: validation.cites.length,
        attempts: attempt + 1, knowledge_version: CORPUS_VERSION,
      });
      return ok({
        message: present(row),
        answer,
        citations: validation.cites,
        attempts: attempt + 1,
        context_used: summariseContext(context),
      }, 201);
    }

    problems = validation.problems;
    attempt++;
  }

  // Both attempts failed. The answer is withheld — not shown with a warning.
  // An answer containing an invented figure still contains the figure, and the
  // figure is what gets pasted into a deck.
  const reason = problems.map((p) => p.problem).join('; ');
  const row = write(ctx, orgId, threadId, seq, text, {
    answer_text: 'The advisor produced an answer that could not be verified against your records and the '
               + 'knowledge base, so it has not been shown. Nothing has been added to your records. '
               + 'This is working as intended: an unverifiable answer is withheld rather than shown with a '
               + 'warning on it.',
    refused: 1, refusal_code: 'failed_validation', rejected_reason: reason,
    advisor_id: advisor.id, advisor_version: advisor.version,
  });
  audit(ctx, orgId, 'advisor.draft_rejected', 'advisor_message', row.id, {
    attempts: attempt, problems: problems.map((p) => p.code),
  });

  return ok({
    message: present(row), refused: true, code: 'failed_validation', problems,
  }, 200);
}

function write(ctx, orgId, threadId, seq, question, fields) {
  return ctx.db.insert('advisor_message', {
    org_id: orgId, thread_id: threadId, seq, question,
    answer_text: null, draft: null, citations: null,
    refused: 0, refusal_code: null, rejected_reason: null,
    knowledge_version: CORPUS_VERSION,
    asked_by: ctx.auth.userId, created_at: ctx.now(),
    ...fields,
  });
}

function summariseContext(context) {
  return {
    facts: context.facts.length,
    records: context.records.map((r) => ({ id: r.id, title: r.title, why: r.why, score: r.score })),
    open_gaps: context.gaps.length,
    band: context.assessment?.band ?? null,
    corpus_version: context.corpus_version,
    overdue_records: context.overdue_records,
  };
}

// ────────────────────────────────────────────────────── transparency ──

/**
 * What the advisor would use to answer this, without answering it.
 *
 * Exposed deliberately. A user who can see the retrieval before the answer can
 * tell the difference between "the product knows about this" and "the product
 * is improvising", which is the distinction the whole design rests on.
 */
export function explainRetrieval(ctx, orgId, question) {
  authorise(membershipOf(ctx, orgId), 'read');
  const screen = screenQuestion(question);
  if (screen.refused) return ok({ refused: true, code: screen.code, says: screen.says });

  const context = buildContext(ctx, orgId, question);
  return ok({
    refused: false,
    records: context.records.map((r) => ({
      id: r.id, title: r.title, kind: r.kind, score: r.score, why: r.why,
      review: r.review, applies_to: r.applies_to,
    })),
    facts_available: context.facts.length,
    figures_available: context.figures.length,
    open_gaps: context.gaps.length,
    knowledge_empty: context.knowledge_empty,
    corpus_version: context.corpus_version,
  });
}

/** The corpus itself, with its review state. Readable by any member. */
export function knowledgeBase(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  return ok({
    ...knowledgeHealth(ctx.now()),
    sources: SOURCES,
    // Said plainly, because an advisor that refuses things should say what and why.
    boundaries: REFUSALS.map((r) => ({ code: r.code, says: r.says })),
  });
}

/**
 * The advisor's answer to "what should I do next", assembled without a model.
 *
 * Their own gap register, in the published fix order, with the criterion behind
 * each item. No generation is involved, which means no citation to check: it is
 * their data, sorted by a rule that is written down. The advisor exists for the
 * questions this cannot answer, not for this one.
 */
export function nextActions(ctx, orgId, { limit = 5 } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const open = sortGaps(ctx.db.find('gap', { org_id: orgId }).filter((g) => !g.closed_at));

  return ok({
    actions: open.slice(0, limit).map((g) => ({
      gap_id: g.id,
      criterion_ref: g.criterion_ref,
      criterion: criterionByRef(g.criterion_ref)?.text ?? null,
      category: g.category,
      description: g.description,
      done_when: g.done_when,
      owner_user_id: g.owner_user_id,
      due_date: g.due_date,
    })),
    total_open: open.length,
    basis: 'Your own gap register, in fix order. Blocking items first, then long-lead items even where they '
         + 'score better, because the time they take is not yours to compress.',
    generated: false,
  });
}

export { AdvisorError };
