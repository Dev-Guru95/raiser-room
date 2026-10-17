/**
 * Phase 1 — the readiness assessment service.
 *
 * This is the first sellable surface: it digitises Before They Ask, and it is
 * what converts a workbook reader into a subscriber.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { DOMAINS, SCALE, KNOWLEDGE_SOURCE, criterionByRef } from '../domain/criteria.js';
import { score, bandMeaning, BANDS, HARD_RULES, AssessmentError } from '../domain/assessment.js';
import { deriveGaps, sortGaps, overCapacityOwners, unownedGaps, overdueGaps, GAP_CATEGORIES, OWNER_CAPACITY } from '../domain/gaps.js';
import { recordMilestone } from './timing.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

/** Bands that are worth timing. BLOCKED is a state, not progress. */
const BAND_MILESTONE = Object.freeze({
  NOT_YET: 'BAND_NOT_YET', NEARLY: 'BAND_NEARLY', READY: 'BAND_READY',
});

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * The criteria catalogue, with its provenance attached.
 *
 * Guidance is served from a versioned, citable record — never recalled by a
 * model. A user can always see where a judgement came from and when it was
 * last reviewed.
 */
export function getCatalogue() {
  return ok({
    source: KNOWLEDGE_SOURCE,
    scale: SCALE,
    bands: BANDS,
    hard_rules: HARD_RULES,
    domains: DOMAINS.map((d) => ({
      domain: d.n, name: d.name, weight: d.weight, question: d.question,
      criteria: d.criteria,
    })),
  });
}

export function createAssessment(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const now = ctx.now();
  const row = ctx.db.insert('assessment', {
    org_id: orgId,
    label: input.label ? String(input.label).slice(0, 80) : 'Assessment',
    scores: JSON.stringify({}),
    total_weighted: null, band: null, capped: 0, findings: null, is_complete: 0,
    scored_by: ctx.auth.userId, second_scorer: null, completed_at: null, created_at: now,
  });
  audit(ctx, orgId, 'assessment.created', 'assessment', row.id, { label: row.label });
  return ok({ assessment: present(row) }, 201);
}

/**
 * Record scores. Partial by design — an assessment takes four sessions across
 * two to three weeks, and the gap between sessions is where people discover
 * that the thing they confidently scored a 4 is actually a 1.
 */
export function scoreAssessment(ctx, orgId, assessmentId, scores) {
  return usage.around(ctx, orgId, 'ASSESSMENT_SCORED', () => doScoreAssessment(ctx, orgId, assessmentId, scores));
}

function doScoreAssessment(ctx, orgId, assessmentId, scores) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('assessment', assessmentId), orgId);
  if (row.completed_at) throw new AccessError('already_completed', 409);

  const merged = { ...JSON.parse(row.scores), ...(scores ?? {}) };
  const result = score(merged, { partial: true });          // throws on bad input

  const updated = ctx.db.update('assessment', assessmentId, {
    scores: JSON.stringify(merged),
    total_weighted: result.total_weighted,
    band: result.band,
    capped: result.capped ? 1 : 0,
    findings: JSON.stringify(result.hard_rule_findings),
    is_complete: result.complete ? 1 : 0,
  });

  audit(ctx, orgId, 'assessment.scored', 'assessment', assessmentId, {
    criteria: Object.keys(scores ?? {}).length, band: result.band,
  });
  return ok({ assessment: present(updated), result: decorate(result) });
}

/**
 * Complete the assessment and generate the gap register.
 * Refuses an incomplete assessment: a band from partial scores is a number
 * people will act on, and it would be wrong.
 */
export function completeAssessment(ctx, orgId, assessmentId) {
  return usage.around(ctx, orgId, 'ASSESSMENT_COMPLETED', () => doCompleteAssessment(ctx, orgId, assessmentId));
}

function doCompleteAssessment(ctx, orgId, assessmentId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('assessment', assessmentId), orgId);
  if (row.completed_at) throw new AccessError('already_completed', 409);

  const result = score(JSON.parse(row.scores));   // not partial — throws if incomplete
  const now = ctx.now();

  const updated = ctx.db.update('assessment', assessmentId, {
    total_weighted: result.total_weighted, band: result.band,
    capped: result.capped ? 1 : 0, findings: JSON.stringify(result.hard_rule_findings),
    is_complete: 1, completed_at: now,
  });

  // Replace any gaps still open from this assessment, keeping closed history.
  for (const g of ctx.db.find('gap', { org_id: orgId, assessment_id: assessmentId })) {
    if (!g.closed_at) ctx.db.remove('gap', g.id);
  }

  const created = [];
  for (const g of deriveGaps(result)) {
    created.push(ctx.db.insert('gap', {
      org_id: orgId, assessment_id: assessmentId,
      criterion_ref: g.criterion_ref, domain: g.domain, score: g.score,
      category: g.category, description: g.description, done_when: g.done_when,
      owner_user_id: null, due_date: null, closed_at: null, closed_by: null, created_at: now,
    }));
  }

  audit(ctx, orgId, 'assessment.completed', 'assessment', assessmentId, {
    band: result.band, total: result.total_weighted, gaps: created.length,
  });

  // Instrumentation. First occurrence wins, so a re-score months later does not
  // overwrite when the company actually first got here.
  recordMilestone(ctx, orgId, 'FIRST_ASSESSMENT_COMPLETE', now);
  if (BAND_MILESTONE[result.band]) recordMilestone(ctx, orgId, BAND_MILESTONE[result.band], now);

  return ok({
    assessment: present(updated),
    result: decorate(result),
    gaps_created: created.length,
  });
}

export function getAssessment(ctx, orgId, assessmentId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const row = assertBelongsToOrg(ctx.db.get('assessment', assessmentId), orgId);
  const result = score(JSON.parse(row.scores), { partial: true });
  return ok({ assessment: present(row), result: decorate(result) });
}

export function listAssessments(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const rows = ctx.db.find('assessment', { org_id: orgId })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return ok({
    assessments: rows.map(present),
    // Movement over time is the point for a re-score, and for Phase 8's
    // portfolio view. Surface it rather than making callers compute it.
    trajectory: rows.filter((r) => r.completed_at).map((r) => ({
      assessment_id: r.id, at: r.completed_at, total: r.total_weighted, band: r.band,
    })),
  });
}

/**
 * Blind second scoring.
 *
 * Not to check arithmetic — to check generosity. Differences of two or more
 * points on a criterion are where the real conversation is, and they almost
 * always reveal that one person scored the intention and the other the evidence.
 */
export function compareScorers(ctx, orgId, assessmentId, otherAssessmentId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const a = assertBelongsToOrg(ctx.db.get('assessment', assessmentId), orgId);
  const b = assertBelongsToOrg(ctx.db.get('assessment', otherAssessmentId), orgId);

  const sa = JSON.parse(a.scores); const sb = JSON.parse(b.scores);
  const divergences = [];
  for (const ref of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (sa[ref] === undefined || sb[ref] === undefined) continue;
    const delta = Math.abs(sa[ref] - sb[ref]);
    if (delta >= 2) {
      divergences.push({
        criterion_ref: ref, text: criterionByRef(ref)?.text,
        a: sa[ref], b: sb[ref], delta,
      });
    }
  }
  divergences.sort((x, y) => y.delta - x.delta || x.criterion_ref.localeCompare(y.criterion_ref));
  return ok({
    divergences,
    note: divergences.length
      ? 'Discuss these before accepting either score. A two-point gap usually means one of you scored the intention and the other the evidence.'
      : 'No material divergence. Either the evidence is clear, or you scored together — which defeats the purpose.',
  });
}

// ──────────────────────────────────────────────────────────── gap register ──

export function listGaps(ctx, orgId, { includeClosed = false } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const all = ctx.db.find('gap', { org_id: orgId });
  const open = all.filter((g) => !g.closed_at);
  const shown = includeClosed ? all : open;

  return ok({
    gaps: sortGaps(shown),
    open: open.length,
    closed: all.length - open.length,
    warnings: {
      over_capacity: overCapacityOwners(open),
      unowned: unownedGaps(open).map((g) => g.criterion_ref),
      overdue: overdueGaps(open, ctx.now()).map((g) => g.criterion_ref),
    },
    owner_capacity: OWNER_CAPACITY,
  });
}

export function updateGap(ctx, orgId, gapId, input) {
  return usage.around(ctx, orgId, 'GAP_UPDATED', () => doUpdateGap(ctx, orgId, gapId, input));
}

function doUpdateGap(ctx, orgId, gapId, input) {
  authorise(membershipOf(ctx, orgId), 'write');
  const gap = assertBelongsToOrg(ctx.db.get('gap', gapId), orgId);
  if (gap.closed_at) throw new AccessError('gap_closed', 409);

  const updates = {};
  if (input.category !== undefined) {
    if (!GAP_CATEGORIES.includes(input.category)) throw new AccessError('invalid_category', 400);
    updates.category = input.category;
  }
  if (input.owner_user_id !== undefined) {
    const owner = input.owner_user_id;
    if (owner !== null && !ctx.db.findOne('membership', { org_id: orgId, user_id: owner })) {
      // An owner outside the organisation cannot be held to anything.
      throw new AccessError('owner_not_a_member', 400);
    }
    updates.owner_user_id = owner;
  }
  if (input.due_date !== undefined) updates.due_date = input.due_date;
  if (input.done_when !== undefined) {
    const dw = String(input.done_when).trim();
    if (!dw) throw new AccessError('done_when_required', 400);
    updates.done_when = dw;
  }
  if (!Object.keys(updates).length) throw new AccessError('nothing_to_update', 400);

  const updated = ctx.db.update('gap', gapId, updates);
  audit(ctx, orgId, 'gap.updated', 'gap', gapId, updates);

  // Advisory, not blocking: the register is still valid, it just will not run.
  const over = overCapacityOwners(ctx.db.find('gap', { org_id: orgId }).filter((g) => !g.closed_at));
  return ok({ gap: updated, warnings: { over_capacity: over } });
}

export function closeGap(ctx, orgId, gapId, input = {}) {
  return usage.around(ctx, orgId, 'GAP_CLOSED', () => doCloseGap(ctx, orgId, gapId, input));
}

function doCloseGap(ctx, orgId, gapId, { evidence } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const gap = assertBelongsToOrg(ctx.db.get('gap', gapId), orgId);
  if (gap.closed_at) throw new AccessError('gap_closed', 409);

  const now = ctx.now();
  const updated = ctx.db.update('gap', gapId, { closed_at: now, closed_by: ctx.auth.userId });
  audit(ctx, orgId, 'gap.closed', 'gap', gapId, {
    criterion_ref: gap.criterion_ref, evidence: evidence ?? null,
  });

  recordMilestone(ctx, orgId, 'FIRST_GAP_CLOSED', now);

  // Clock A and clock B, separated at the point of measurement. CHEAP gaps are
  // the company's own work; BLOCKERs routinely wait on a third party, so the
  // two are recorded as different intervals and never averaged together.
  const open = ctx.db.find('gap', { org_id: orgId }).filter((g) => !g.closed_at);
  if (!open.some((g) => g.category === 'CHEAP')) recordMilestone(ctx, orgId, 'ALL_CHEAP_GAPS_CLOSED', now);
  if (!open.some((g) => g.category === 'BLOCKER')) recordMilestone(ctx, orgId, 'ALL_BLOCKERS_CLOSED', now);

  return ok({ gap: updated });
}

// ───────────────────────────────────────────────────────────────── helpers ──

function present(row) {
  return {
    id: row.id, label: row.label, band: row.band,
    total_weighted: row.total_weighted, capped: !!row.capped,
    complete: !!row.is_complete, completed_at: row.completed_at,
    scored_by: row.scored_by, created_at: row.created_at,
    findings: row.findings ? JSON.parse(row.findings) : [],
  };
}

function decorate(result) {
  return { ...result, band_means: bandMeaning(result.band) };
}

export { AssessmentError };
