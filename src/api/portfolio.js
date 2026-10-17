/**
 * Phase 12 — the portfolio view.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY ROUTE BETWEEN TWO ORGANISATIONS IN THE PRODUCT
 *
 * Everything else is sealed: every query is scoped by `org_id`, a non-member
 * gets a 404 rather than a 403, and there is no aggregate anywhere. That is a
 * promise the product makes repeatedly, so a feature that crosses the boundary
 * has to be built as the exception that proves it rather than the hole that
 * ends it.
 *
 * Four rules, and each one is a thing in the code:
 *
 * **1. The company grants it, not the holder.** An accelerator cannot add a
 * company to its portfolio. The company invites the accelerator. A list somebody
 * can assemble about other people without their involvement is surveillance,
 * whatever it is called in the menu.
 *
 * **2. What is shared is a named, fixed field set.** Not "summary access" — a
 * list the company can read before they agree, and which `whatTheyWillSee`
 * returns verbatim. A consent nobody can inspect is not consent.
 *
 * **3. It never reaches facts or documents.** An accelerator sees how a company
 * is progressing; it does not see their accounts, their contracts or their cap
 * table. If a company wants that, they add those people as members in the
 * ordinary way, with the ordinary audit trail. There is deliberately no scope
 * here that grants it, because a second path to a company's figures is the thing
 * that eventually leaks them.
 *
 * **4. There is no aggregate, ever.** No median, no cohort, no benchmark, no
 * "companies like yours". Not because it is hard, but because the moment it
 * exists, every company in the portfolio is being told about every other one —
 * and the product's central claim about cross-organisation data becomes
 * marketing copy. `test/portfolio.test.js` asserts that the response carries no
 * field computed from more than one company.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import { score } from '../domain/assessment.js';
import { sortGaps } from '../domain/gaps.js';
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

export const PORTFOLIO_SCOPES = Object.freeze(['SUMMARY', 'PROGRESS']);

/**
 * Exactly what a holder sees, by scope.
 *
 * Shown to the company BEFORE they agree, and returned by `whatTheyWillSee` so
 * an interface can render it as a list rather than a reassurance. Every field
 * here is about progress; none of them is a figure from the business.
 */
export const SHARED_FIELDS = Object.freeze({
  SUMMARY: Object.freeze([
    { field: 'name', means: 'Your company name' },
    { field: 'path', means: 'Whether you are preparing to raise or to sell' },
    { field: 'readiness_band', means: 'Your readiness band — READY, NEARLY, NOT_YET or EARLY' },
    { field: 'last_assessed', means: 'When you last completed an assessment' },
    { field: 'room_completeness', means: 'What proportion of the required data room is filled' },
  ]),
  PROGRESS: Object.freeze([
    { field: 'name', means: 'Your company name' },
    { field: 'path', means: 'Whether you are preparing to raise or to sell' },
    { field: 'readiness_band', means: 'Your readiness band' },
    { field: 'readiness_score', means: 'Your total readiness score out of 200' },
    { field: 'domain_scores', means: 'Your score in each of the eight domains' },
    { field: 'last_assessed', means: 'When you last completed an assessment' },
    { field: 'room_completeness', means: 'What proportion of the required data room is filled' },
    { field: 'open_gaps', means: 'How many gaps are open, and what kind — not what they say' },
    { field: 'blockers', means: 'How many of them are blockers' },
  ]),
});

/**
 * What is never shared, at any scope.
 *
 * Listed so a company can see the boundary rather than infer it, and so that
 * adding to it is a deliberate act with a test to break.
 */
export const NEVER_SHARED = Object.freeze([
  'Any figure from your accounts, or any fact you have recorded',
  'Any document you have uploaded',
  'Your cap table, contracts or customer names',
  'Anything you have written, drafted or generated',
  'Who you have shared a data room with, or what they asked',
  'Your forecasts, or how they compared with your actuals',
]);

// ──────────────────────────────────────────────────── the company's side ──

/** What a holder would see, before agreeing to anything. */
export function whatTheyWillSee(ctx, orgId, { scope = 'SUMMARY' } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  if (!PORTFOLIO_SCOPES.includes(scope)) {
    throw new AccessError('invalid_scope', 400, { allowed: PORTFOLIO_SCOPES });
  }
  return ok({
    scope,
    they_will_see: SHARED_FIELDS[scope],
    they_will_never_see: NEVER_SHARED,
    note: 'This is the whole list. It is read-only, it is yours to revoke at any moment, and revoking '
        + 'takes effect immediately.',
  });
}

/**
 * Invite a holder to see this company.
 *
 * Called by the COMPANY. There is no call anywhere that lets a holder add a
 * company to its own portfolio.
 */
export function inviteHolder(ctx, orgId, input = {}) {
  return usage.around(ctx, orgId, 'PORTFOLIO_INVITED', () => doInviteHolder(ctx, orgId, input));
}

function doInviteHolder(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'own');

  const holderOrgId = String(input.holder_org_id ?? '').trim();
  if (!holderOrgId) throw new AccessError('holder_required', 400);
  if (holderOrgId === orgId) {
    throw new AccessError('cannot_hold_self', 400, {
      detail: 'A company does not need to be in its own portfolio.',
    });
  }
  if (!ctx.db.get('organisation', holderOrgId)) {
    // 404, as everywhere else. A 403 would confirm an organisation id exists.
    throw new AccessError('not_found', 404);
  }

  const scope = input.scope ?? 'SUMMARY';
  if (!PORTFOLIO_SCOPES.includes(scope)) {
    throw new AccessError('invalid_scope', 400, { allowed: PORTFOLIO_SCOPES });
  }

  const existing = ctx.db.find('portfolio_link', { org_id: orgId, holder_org_id: holderOrgId })
    .find((l) => l.state !== 'REVOKED');
  if (existing) {
    throw new AccessError('already_linked', 409, {
      detail: 'This organisation already sees your company.', state: existing.state,
    });
  }

  const row = ctx.db.insert('portfolio_link', {
    org_id: orgId, holder_org_id: holderOrgId,
    label: input.label ?? null,
    // ACTIVE on creation: the company granting it IS the consent, and a second
    // acceptance step by the holder would only add a way for the grant to sit
    // half-finished.
    state: 'ACTIVE', scope,
    invited_by: ctx.auth.userId,
    accepted_by: ctx.auth.userId, accepted_at: ctx.now(),
    revoked_by: null, revoked_at: null, revoked_reason: null,
    created_at: ctx.now(),
  });

  audit(ctx, orgId, 'portfolio.holder_invited', 'portfolio_link', row.id, {
    holder_org_id: holderOrgId, scope,
  });
  return ok({ link: present(row), they_will_see: SHARED_FIELDS[scope] }, 201);
}

/** Who can see this company, from the company's side. */
export function whoCanSeeUs(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const links = ctx.db.find('portfolio_link', { org_id: orgId })
    .filter((l) => l.state !== 'REVOKED');
  return ok({
    holders: links.map((l) => ({
      ...present(l),
      holder_name: ctx.db.get('organisation', l.holder_org_id)?.name ?? null,
      they_see: SHARED_FIELDS[l.scope] ?? [],
    })),
    total: links.length,
    they_will_never_see: NEVER_SHARED,
  });
}

/**
 * Stop someone seeing this company.
 *
 * Immediate, needs no reason, and cannot be refused by the holder. A consent
 * that is awkward to withdraw is not one somebody would have given.
 */
export function revokeHolder(ctx, orgId, linkId, { reason = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'own');
  const link = assertBelongsToOrg(ctx.db.get('portfolio_link', linkId), orgId);
  if (link.state === 'REVOKED') {
    throw new AccessError('already_revoked', 409);
  }

  const updated = ctx.db.update('portfolio_link', linkId, {
    state: 'REVOKED', revoked_by: ctx.auth.userId, revoked_at: ctx.now(),
    revoked_reason: reason ? String(reason).trim() : null,
  });
  audit(ctx, orgId, 'portfolio.holder_revoked', 'portfolio_link', linkId,
    { holder_org_id: link.holder_org_id, reason: reason ?? null });

  return ok({
    link: present(updated),
    note: 'Done, and effective immediately. They can no longer see anything about your company.',
  });
}

// ──────────────────────────────────────────────────── the holder's side ──

/**
 * The companies that have invited this holder.
 *
 * One entry per company, each built from that company's own data alone. There is
 * no statistic across them here and there is no function in this file that could
 * produce one.
 */
export function portfolio(ctx, holderOrgId) {
  authorise(membershipOf(ctx, holderOrgId), 'read');
  requireEntitlement(ctx, holderOrgId, 'PORTFOLIO');

  const links = ctx.db.find('portfolio_link', { holder_org_id: holderOrgId, state: 'ACTIVE' });

  const companies = links.map((link) => {
    const fields = SHARED_FIELDS[link.scope] ?? SHARED_FIELDS.SUMMARY;
    const allowed = new Set(fields.map((f) => f.field));
    const full = companySummary(ctx, link.org_id);

    // Filtered to the consented field set rather than trimmed afterwards: a
    // field that was never put in the object cannot leak through a later change
    // to how this is serialised.
    const shared = {};
    for (const [key, value] of Object.entries(full)) {
      if (allowed.has(key)) shared[key] = value;
    }

    return {
      org_id: link.org_id,
      label: link.label,
      scope: link.scope,
      since: link.accepted_at,
      ...shared,
    };
  });

  audit(ctx, holderOrgId, 'portfolio.viewed', 'organisation', holderOrgId,
    { companies: companies.length });

  return ok({
    companies,
    total: companies.length,
    // Stated in the response, because the absence of a benchmark is a feature
    // somebody paid for and would otherwise read as an omission.
    no_benchmark: 'There is no comparison, median or ranking across these companies, and there will '
                + 'not be. Each one agreed to show you their own progress; none of them agreed to '
                + 'become a data point in somebody else\'s benchmark.',
    they_never_see: NEVER_SHARED,
  });
}

/**
 * One company's progress, from its own data.
 *
 * Takes one `orgId` and reads nothing else. A function that could see two
 * companies at once is a function that could compare them.
 */
function companySummary(ctx, orgId) {
  const org = ctx.db.get('organisation', orgId);

  const assessments = ctx.db.find('assessment', { org_id: orgId })
    .filter((a) => a.is_complete)
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const latest = assessments[0] ?? null;
  const scored = latest ? score(JSON.parse(latest.scores), { partial: true }) : null;

  const items = ctx.db.find('data_room_item', { org_id: orgId }).filter((i) => i.required);
  const documents = new Map(ctx.db.find('document', { org_id: orgId }).map((d) => [d.id, d]));
  const satisfied = items.filter((i) =>
    i.not_applicable || (i.document_id && documents.get(i.document_id)?.uploaded_at)).length;

  const openGaps = sortGaps(ctx.db.find('gap', { org_id: orgId }).filter((g) => !g.closed_at));

  return {
    name: org?.name ?? null,
    path: org?.path ?? null,
    readiness_band: scored?.band ?? null,
    readiness_score: scored?.total_weighted ?? null,
    domain_scores: scored?.domains?.map((d) => ({ domain: d.domain, score: d.weighted })) ?? null,
    last_assessed: latest?.completed_at ?? null,
    room_completeness: items.length
      ? Math.round((satisfied / items.length) * 100)
      : null,
    // A count and a category. Never the text — a gap says what is wrong with a
    // company in the company's own words, and that is theirs.
    open_gaps: openGaps.length,
    blockers: openGaps.filter((g) => g.category === 'BLOCKER').length,
  };
}

const present = (row) => ({
  id: row.id,
  org_id: row.org_id,
  holder_org_id: row.holder_org_id,
  label: row.label,
  state: row.state,
  scope: row.scope,
  since: row.accepted_at,
  revoked_at: row.revoked_at,
  revoked_reason: row.revoked_reason,
});

/**
 * A reminder of the boundary, for a holder's settings screen.
 *
 * Holders ask for benchmarks. This is the answer, written once, so that it is
 * the same answer every time and does not erode into "not yet".
 */
export function portfolioPolicy(ctx, holderOrgId) {
  authorise(membershipOf(ctx, holderOrgId), 'read');
  return ok({
    what_you_see: PORTFOLIO_SCOPES.map((scope) => ({ scope, fields: SHARED_FIELDS[scope] })),
    what_you_never_see: NEVER_SHARED,
    benchmarks: 'Not available, and not planned. Comparing these companies to each other would mean '
              + 'using each one\'s data to tell the others something, which is the one thing this '
              + 'product promises never to do. The companies you hold agreed to show you their own '
              + 'progress on that basis.',
    revocation: 'Any company can stop sharing at any moment, without telling you first.',
  });
}
