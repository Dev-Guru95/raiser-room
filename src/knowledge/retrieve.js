/**
 * Retrieval over the knowledge corpus.
 *
 * Deliberately a scoring function over tags, titles and criterion refs rather
 * than an embedding search. Three reasons, in order of importance:
 *
 *   1. It is inspectable. Every result carries `why` — the actual terms that
 *      matched — so a user asking why the advisor cited a particular record
 *      gets an answer, and so does an auditor.
 *
 *   2. It is deterministic. The same question returns the same records today
 *      and in two years, which means an answer stored in the message log can be
 *      explained later. An embedding index silently changes what it returns
 *      when it is rebuilt.
 *
 *   3. The corpus is small and hand-curated. Vector search earns its keep over
 *      a corpus nobody can read; this one is meant to be read.
 *
 * If the corpus ever grows past the point where this works, the thing to keep
 * is `why` on every result — not the algorithm.
 */

import { RECORDS, recordById, reviewStatus } from './corpus.js';
import { criterionByRef } from '../domain/criteria.js';

/** Words carrying no retrieval signal. Short and boring on purpose. */
const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that', 'what', 'how', 'why',
  'when', 'should', 'would', 'could', 'have', 'has', 'had', 'our', 'about', 'from', 'into', 'their',
  'they', 'them', 'does', 'did', 'can', 'any', 'all', 'get', 'got', 'need', 'want', 'who', 'which',
  'there', 'here', 'been', 'being', 'was', 'were', 'will', 'just', 'like', 'make', 'made', 'use',
]);

const words = (s) => (String(s ?? '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

/** Criterion references written in a question: "2.3", "criterion 7.1". */
export function criterionRefsIn(text) {
  const refs = (String(text ?? '').match(/\b[1-8]\.[1-4]\b/g) ?? []);
  return [...new Set(refs)].filter((r) => criterionByRef(r));
}

/**
 * Weights. Stated as data so the ranking can be argued with rather than
 * reverse-engineered from a sort comparator.
 */
export const WEIGHTS = Object.freeze({
  criterion_ref_in_question: 10,   // they named it; nothing beats that
  criterion_ref_in_context: 4,     // their own open gap points at it
  tag_exact: 3,
  title_word: 2,
  tested_word: 2,
  body_word: 0.5,
  gap_category: 2,
});

/**
 * The relevance floor.
 *
 * Set just above a single tag hit so one real signal is enough, and incidental
 * body-word overlap alone is not. See the comment at the point it is applied —
 * this number decides whether the advisor believes it has anything to say.
 */
export const MIN_SCORE = 2;

/**
 * Rank the corpus against a question and the organisation's own state.
 *
 * @param {string} question
 * @param {object} [context]  { criterionRefs, gapCategories } — what the org is
 *                            actually working on, so "what next?" retrieves the
 *                            records behind their own open gaps rather than
 *                            generic material.
 * @param {object} [opts]     { limit, asOf }
 * @returns {object[]} records with `score` and `why`
 */
export function retrieve(question, context = {}, { limit = 5, asOf = null } = {}) {
  const qWords = new Set(words(question));
  const qRefs = new Set(criterionRefsIn(question));
  const ctxRefs = new Set(context.criterionRefs ?? []);
  const ctxCategories = new Set((context.gapCategories ?? []).map((c) => String(c).toLowerCase()));

  const scored = [];

  for (const record of RECORDS) {
    let score = 0;
    const why = [];

    for (const ref of record.applies_to ?? []) {
      if (qRefs.has(ref)) {
        score += WEIGHTS.criterion_ref_in_question;
        why.push(`you named criterion ${ref}`);
      } else if (ctxRefs.has(ref)) {
        score += WEIGHTS.criterion_ref_in_context;
        why.push(`criterion ${ref} is open in your gap register`);
      }
    }

    const tagHits = (record.tags ?? []).filter((t) => {
      const parts = t.toLowerCase().split(/\s+/);
      return parts.every((p) => qWords.has(p)) || qWords.has(t.toLowerCase());
    });
    if (tagHits.length) {
      score += tagHits.length * WEIGHTS.tag_exact;
      why.push(`matches ${tagHits.map((t) => `"${t}"`).join(', ')}`);
    }

    const titleHits = words(record.title).filter((w) => qWords.has(w));
    if (titleHits.length) {
      score += titleHits.length * WEIGHTS.title_word;
      why.push(`title mentions ${titleHits.join(', ')}`);
    }

    const testedHits = words(record.tested).filter((w) => qWords.has(w));
    if (testedHits.length) score += testedHits.length * WEIGHTS.tested_word;

    const bodyHits = new Set(words(record.body).filter((w) => qWords.has(w)));
    if (bodyHits.size) score += Math.min(bodyHits.size, 8) * WEIGHTS.body_word;

    if (record.kind === 'SEQUENCING' && ctxCategories.size) {
      score += WEIGHTS.gap_category;
      why.push('you have open gaps, and this covers what order to do them in');
    }

    // A record is returned only if retrieval can say WHY, in a sentence a user
    // would accept.
    //
    // Scattered body-word overlap produces a score without a reason: asked what
    // the weather was doing, this returned a record on owner capacity, because
    // the word "look" appears in it. Score 0.5, `why` empty. Returning it would
    // have been worse than returning nothing, because a non-empty context is
    // what tells the advisor it has material to answer from — so an incidental
    // word match becomes licence to produce an answer about a subject the
    // corpus does not cover.
    //
    // Requiring a stateable reason is therefore a correctness rule, not a
    // presentation one. If it cannot be explained, it is not a match.
    if (score >= MIN_SCORE && why.length > 0) {
      scored.push({
        ...record,
        score: Math.round(score * 100) / 100,
        why,
        review: asOf ? reviewStatus(record, asOf) : null,
      });
    }
  }

  // Ties broken by id so the order is stable — an answer stored today must be
  // explicable by rerunning retrieval tomorrow.
  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/**
 * Assemble the records an advisor turn is allowed to use.
 *
 * This is the whole permitted world for one answer. Anything the model says
 * that is not traceable to this set, or to the organisation's own facts, is
 * rejected by the validator — so this function defines the boundary rather than
 * merely suggesting it.
 */
export function buildKnowledgeContext(question, context = {}, opts = {}) {
  const records = retrieve(question, context, opts);
  const asOf = opts.asOf ?? null;

  return {
    records,
    overdue: records.filter((r) => r.review?.state === 'OVERDUE').map((r) => r.id),
    // Returned even when empty, and the caller must handle it. A question the
    // corpus does not cover is a real outcome: the honest answer is that there
    // is nothing recorded on it, not an answer assembled from the model's own
    // recollection.
    empty: records.length === 0,
    asOf,
  };
}

export { recordById };
