/**
 * The workbook onramp.
 *
 * A reader of *Before They Ask* has already done four sessions of real work:
 * scored 32 criteria, written a gap register, built a normalisation bridge,
 * quantified customer concentration, named their key-person dependencies.
 *
 * None of that should be retyped. This turns the completed workbook into a
 * scored assessment, a populated gap register and a set of confirmed facts —
 * so the app opens with the company already in it, and the $147 credit is the
 * smaller half of what carries across.
 *
 * PROVENANCE: every imported fact is USER_ENTERED. The user wrote it in the
 * workbook and transcribed it here. It is not DOCUMENT_EXTRACTED — nothing was
 * parsed — and it is not USER_CONFIRMED, which is reserved for confirming an
 * extraction. Getting this wrong would put a confidence on these figures that
 * they have not earned.
 */

import { authorise, AccessError } from '../domain/access.js';
import { ALL_REFS, criterionByRef } from '../domain/criteria.js';
import { score } from '../domain/assessment.js';
import { deriveGaps } from '../domain/gaps.js';
import { WORKSHEET_FACT_MAP } from '../domain/transfer-sheet.js';
import { recordMilestone } from './timing.js';

const ok = (body, status = 200) => ({ status, body });

/** $147, in minor units. The credit is labelled, never expressed as a percentage. */
export const WORKBOOK_CREDIT_MINOR = 14_700;
export const WORKBOOK_CREDIT_CURRENCY = 'USD';

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * Worksheet → fact mapping.
 *
 * Derived from `src/domain/transfer-sheet.js`, which is the single place the
 * mapping lives. It used to be written out here as well, which meant the PDF
 * form and the importer each held their own copy of the same table — and a
 * divergence between them would not have failed, it would have quietly filed
 * one figure under another figure's key.
 *
 * Only worksheets whose answers are durable company facts are imported. The
 * score summary becomes an assessment and the gap register becomes gaps;
 * neither is a "fact" about the business.
 */
const WORKSHEET_FACTS = WORKSHEET_FACT_MAP;

/**
 * Redeem a workbook purchase into an organisation.
 *
 * @param {object} input
 *   receipt_ref    the verified purchase reference (verification happens upstream)
 *   scores         worksheet 1 — criterion ref -> 0..5
 *   normalisation  worksheet 3
 *   concentration  worksheet 4
 *   key_people     worksheet 5 — [{ person, holds, deputy }]
 *   assumptions    worksheet 9
 */
export function redeemWorkbook(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'own');

  const receipt = String(input.receipt_ref ?? '').trim();
  if (!receipt) throw new AccessError('receipt_required', 400);

  // One redemption per receipt, enforced by a unique index as well as here —
  // a credit that can be claimed twice is a credit that will be.
  if (ctx.db.findOne('workbook_redemption', { receipt_ref: receipt })) {
    throw new AccessError('receipt_already_redeemed', 409);
  }
  if (ctx.db.findOne('workbook_redemption', { org_id: orgId })) {
    throw new AccessError('organisation_already_redeemed', 409);
  }

  const now = ctx.now();
  const seeded = [];

  // ── worksheets 3, 4, 9 → facts ────────────────────────────────────────────
  for (const [worksheet, mappings] of Object.entries(WORKSHEET_FACTS)) {
    const data = input[worksheet];
    if (!data || typeof data !== 'object') continue;

    for (const m of mappings) {
      const raw = data[m.field];
      if (raw === undefined || raw === null || raw === '') continue;

      let valueNumeric = null; let valueText = null;
      if (m.numeric) {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new AccessError('invalid_worksheet_value', 400, {
            detail: `${worksheet}.${m.field} must be a number, got ${JSON.stringify(raw)}`,
          });
        }
        valueNumeric = n;
      } else {
        valueText = String(raw);
      }

      seeded.push(ctx.db.insert('fact', {
        org_id: orgId, fact_key: m.key, label: m.label,
        value_numeric: valueNumeric, value_text: valueText, value_date: null, unit: m.unit ?? null,
        period_start: null, period_end: null,
        source: 'USER_ENTERED',            // they wrote it; nothing was parsed
        source_doc_id: null, source_page: null, formula: null, input_fact_ids: null,
        confirmed_at: null, confirmed_by: null, superseded_by: null,
        created_by: ctx.auth.userId, created_at: now,
      }));
    }
  }

  // ── worksheet 5 — key-person dependency ───────────────────────────────────
  for (const [i, p] of (input.key_people ?? []).entries()) {
    const person = String(p?.person ?? '').trim();
    const holds = String(p?.holds ?? '').trim();
    if (!person || !holds) continue;
    seeded.push(ctx.db.insert('fact', {
      org_id: orgId, fact_key: `people.key_person.${i + 1}`,
      label: `Key-person dependency: ${person}`,
      value_numeric: null,
      value_text: `${person} uniquely holds: ${holds}${p.deputy ? `. Deputy: ${p.deputy}` : '. No deputy named.'}`,
      value_date: null, unit: null, period_start: null, period_end: null,
      source: 'USER_ENTERED', source_doc_id: null, source_page: null,
      formula: null, input_fact_ids: null, confirmed_at: null, confirmed_by: null,
      superseded_by: null, created_by: ctx.auth.userId, created_at: now,
    }));
  }

  // ── worksheet 1 → an assessment, and worksheet 2 → the gap register ───────
  let assessment = null; let gapsCreated = 0;
  if (input.scores && Object.keys(input.scores).length) {
    const unknown = Object.keys(input.scores).filter((r) => !ALL_REFS.includes(r));
    if (unknown.length) {
      throw new AccessError('unknown_criterion', 400, { detail: `not a criterion: ${unknown.join(', ')}` });
    }

    const result = score(input.scores, { partial: true });
    assessment = ctx.db.insert('assessment', {
      org_id: orgId, label: 'Imported from Before They Ask',
      scores: JSON.stringify(input.scores),
      total_weighted: result.total_weighted, band: result.band,
      capped: result.capped ? 1 : 0, findings: JSON.stringify(result.hard_rule_findings),
      is_complete: result.complete ? 1 : 0, scored_by: ctx.auth.userId, second_scorer: null,
      completed_at: result.complete ? now : null, created_at: now,
    });

    if (result.complete) {
      for (const g of deriveGaps(result)) {
        ctx.db.insert('gap', {
          org_id: orgId, assessment_id: assessment.id,
          criterion_ref: g.criterion_ref, domain: g.domain, score: g.score,
          category: g.category, description: g.description, done_when: g.done_when,
          owner_user_id: null, due_date: null, closed_at: null, closed_by: null, created_at: now,
        });
        gapsCreated++;
      }
    }
  }

  const redemption = ctx.db.insert('workbook_redemption', {
    org_id: orgId, receipt_ref: receipt,
    credit_minor: WORKBOOK_CREDIT_MINOR, credit_currency: WORKBOOK_CREDIT_CURRENCY,
    facts_seeded: seeded.length, redeemed_by: ctx.auth.userId, redeemed_at: now, created_at: now,
  });

  recordMilestone(ctx, orgId, 'WORKBOOK_REDEEMED', now);
  if (assessment?.is_complete) recordMilestone(ctx, orgId, 'FIRST_ASSESSMENT_COMPLETE', now);
  audit(ctx, orgId, 'workbook.redeemed', 'organisation', orgId, {
    receipt_ref: receipt, facts: seeded.length, gaps: gapsCreated,
    credit_minor: WORKBOOK_CREDIT_MINOR,
  });

  return ok({
    redemption: {
      id: redemption.id,
      credit: { minor: WORKBOOK_CREDIT_MINOR, currency: WORKBOOK_CREDIT_CURRENCY, display: '$147.00' },
      // Phrased for the UI. A labelled credit, never a percentage — the user
      // should see what they already paid for, not a discount they were given.
      credit_label: 'Credit for Before They Ask — applied to your first annual subscription',
    },
    seeded: {
      facts: seeded.length,
      assessment_id: assessment?.id ?? null,
      band: assessment?.band ?? null,
      gaps: gapsCreated,
    },
    carried_over: summarise(seeded, assessment, gapsCreated),
  }, 201);
}

/** What the user is told they brought with them. */
function summarise(facts, assessment, gaps) {
  const out = [];
  if (assessment) {
    out.push(assessment.is_complete
      ? `Your readiness score and band, imported from the workbook — ${assessment.band}.`
      : 'Your partial readiness scores, imported from the workbook.');
  }
  if (gaps) out.push(`${gaps} gaps, already in fix order with their categories set.`);
  const keys = new Set(facts.map((f) => f.fact_key.split('.')[0]));
  if (keys.has('financials')) out.push('Your normalisation bridge — reported profit and underlying earnings.');
  if (keys.has('commercial')) out.push('Your customer concentration, including the two-year trend.');
  if (keys.has('people')) out.push('Your key-person dependency register.');
  if (keys.has('plan')) out.push('Your three load-bearing assumptions.');
  return out;
}

/** Credit status for an organisation. Billing itself lands in Phase 8. */
export function creditStatus(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const r = ctx.db.findOne('workbook_redemption', { org_id: orgId });
  if (!r) {
    return ok({
      credit: null,
      eligible: true,
      note: 'Bought the workbook? Redeem it to carry your work across and credit $147 against an annual subscription.',
    });
  }
  return ok({
    credit: {
      minor: r.credit_minor, currency: r.credit_currency, display: '$147.00',
      label: 'Credit for Before They Ask',
      redeemed_at: r.redeemed_at,
    },
    eligible: false,
    facts_seeded: r.facts_seeded,
  });
}
