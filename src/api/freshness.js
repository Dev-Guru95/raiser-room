/**
 * Phase 7 — is any of this still true?
 *
 * The dependency graph was already there: every artifact records the exact fact
 * ids it was built from. Nobody had walked it. This phase walks it, grades what
 * it finds, and makes regeneration a decision rather than a leap.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import {
  artifactStaleness, regenerationDiff, documentFreshness, policyFor,
  severityOf, SEVERITIES, STALENESS_REASONS, FRESHNESS_POLICY, FreshnessError,
} from '../domain/freshness.js';
import { artifactSpec } from '../domain/artifacts.js';
import { generate } from './artifacts.js';
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

/** Everything the staleness rules need, read once. */
function snapshot(ctx, orgId) {
  const allFacts = ctx.db.find('fact', { org_id: orgId });
  const factsById = new Map(allFacts.map((f) => [f.id, f]));

  const disputed = new Set();
  for (const c of ctx.db.find('conflict', { org_id: orgId })) {
    if (c.resolved_at) continue;
    for (const ref of [c.left_ref, c.right_ref]) {
      if (String(ref).startsWith('fact:')) disputed.add(String(ref).slice(5));
    }
  }

  // Keys that exist now and are usable. An unconfirmed extraction is not
  // material a document is missing.
  const usable = usableFacts(allFacts);
  const usableKeys = new Set(usable.map((f) => f.fact_key));

  // When each key first became usable. NEW_MATERIAL has to mean *new*, which
  // means comparing against when the document was generated — see the filter in
  // `artifactHealth` for what went wrong without this.
  const firstUsableAt = new Map();
  for (const f of usable) {
    const at = f.created_at ?? null;
    if (!at) continue;
    const existing = firstUsableAt.get(f.fact_key);
    if (!existing || String(at) < String(existing)) firstUsableAt.set(f.fact_key, at);
  }

  return { factsById, disputed, usableKeys, firstUsableAt };
}

// ──────────────────────────────────────────────────── artifact health ──

/**
 * Every generated artifact, with what has moved underneath it.
 *
 * Persists `stale_since` and the graded reasons as a side effect, so Phase 8
 * has something to notify from and so "when did this stop being true" has an
 * answer rather than a recomputation.
 */
export function artifactHealth(ctx, orgId, { persist = true } = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const now = ctx.now();
  const { factsById, disputed, usableKeys, firstUsableAt } = snapshot(ctx, orgId);

  const artifacts = ctx.db.find('artifact', { org_id: orgId })
    .filter((a) => a.state === 'GENERATED' || a.state === 'STALE');

  const assessed = artifacts.map((a) => {
    // "New material" means material THIS artifact could have used — the keys
    // its own catalogue entry declares — not every fact the company holds.
    // Scoped to the whole org, a financial summary was permanently flagged as
    // incomplete because somebody had recorded the registered name, which is
    // the crying-wolf failure this phase is supposed to avoid.
    // ── and scoped in time, too ──
    //
    // Without the time comparison, a key the renderer simply chose not to bind
    // was reported as new material the moment the document was generated. The
    // worked example came out of its own seeding with two documents already
    // flagged stale, for a figure that had been recorded before either of them
    // existed. A signal that fires on a document generated one second ago is a
    // signal nobody reads, which is how the genuinely important reasons in this
    // list — a figure corrected, a figure disputed — get ignored along with it.
    //
    // So: material this artifact could have used, which arrived AFTER it was
    // generated. A key that was available and not used was a choice, not a
    // change.
    const spec = artifactSpec(a.artifact_kind);
    const since = a.generated_at ?? a.created_at ?? null;
    const relevant = new Set([...(spec?.requires ?? []), ...(spec?.uses ?? [])]
      .filter((k) => usableKeys.has(k))
      .filter((k) => {
        if (!since) return true;
        const at = firstUsableAt.get(k);
        return at ? String(at) > String(since) : false;
      }));

    const result = artifactStaleness(a, factsById, {
      disputedFactIds: disputed, candidateKeys: relevant, asOf: now,
    });

    if (persist) {
      const isStale = result.severity !== 'CURRENT';
      ctx.db.update('artifact', a.id, {
        state: isStale ? 'STALE' : 'GENERATED',
        // First detection wins. Re-running the check must not keep moving the
        // date forward, or "stale since" would always read as today and the
        // one useful thing it tells you — how long this has been wrong — would
        // be lost.
        stale_since: isStale ? (a.stale_since ?? now) : null,
        staleness: isStale ? JSON.stringify(result.reasons) : null,
      });
    }

    return {
      id: a.id, kind: a.artifact_kind, title: a.title,
      generated_at: a.generated_at, released_at: a.released_at,
      stale_since: a.stale_since ?? (result.severity !== 'CURRENT' ? now : null),
      ...result,
    };
  });

  const order = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
  assessed.sort((a, b) => (order[a.severity] - order[b.severity])
    || String(a.generated_at).localeCompare(String(b.generated_at)));

  const urgent = assessed.filter((a) => a.severity === 'URGENT');

  return ok({
    artifacts: assessed,
    summary: {
      total: assessed.length,
      urgent: urgent.length,
      review: assessed.filter((a) => a.severity === 'REVIEW').length,
      minor: assessed.filter((a) => a.severity === 'MINOR').length,
      current: assessed.filter((a) => a.severity === 'CURRENT').length,
    },
    // The one line that matters, said first.
    headline: urgent.length
      ? `${urgent.length} document${urgent.length === 1 ? '' : 's'} you have already sent out `
        + `${urgent.length === 1 ? 'rests' : 'rest'} on a figure that has since changed.`
      : null,
    reasons: STALENESS_REASONS,
  });
}

/**
 * Mark an artifact as released.
 *
 * The act that changes what staleness means for it. Recorded with a note
 * because "sent to whom" is the first thing anyone asks when a figure later
 * moves, and reconstructing it from memory six weeks on does not work.
 */
export function markReleased(ctx, orgId, artifactId, options = {}) {
  return usage.around(ctx, orgId, 'ARTIFACT_RELEASED', () => doMarkReleased(ctx, orgId, artifactId, options));
}

function doMarkReleased(ctx, orgId, artifactId, { note = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const artifact = assertBelongsToOrg(ctx.db.get('artifact', artifactId), orgId);

  if (artifact.state === 'BLOCKED') {
    throw new FreshnessError('not_generated', 'a blocked artifact was never produced, so it cannot have been sent', 409);
  }
  if (artifact.released_at) throw new FreshnessError('already_released', 'this artifact is already marked as sent', 409);

  const text = String(note ?? '').trim();
  if (text.length < 3) {
    throw new FreshnessError('note_required',
      'Say who this went to. When a figure in it changes later, the first question is who is holding '
      + 'the old copy, and that is a bad moment to be reconstructing it from memory.');
  }

  const updated = ctx.db.update('artifact', artifactId, { released_at: ctx.now(), released_note: text });
  audit(ctx, orgId, 'artifact.released', 'artifact', artifactId, { note: text, kind: artifact.artifact_kind });
  return ok({ artifact: present(updated) });
}

// ─────────────────────────────────────────────────────── regeneration ──

/** What would change, without changing anything. */
export function previewRegeneration(ctx, orgId, artifactId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const artifact = assertBelongsToOrg(ctx.db.get('artifact', artifactId), orgId);
  const { factsById } = snapshot(ctx, orgId);

  return ok({
    artifact: present(artifact),
    ...regenerationDiff(artifact, factsById),
  });
}

/**
 * Regenerate, superseding the old version.
 *
 * The old artifact is kept and marked SUPERSEDED rather than overwritten. If it
 * was released, that record is exactly what somebody outside the company is
 * holding, and destroying it would remove the only way to answer "what did they
 * actually see".
 */
export function regenerate(ctx, orgId, artifactId, options = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const previous = assertBelongsToOrg(ctx.db.get('artifact', artifactId), orgId);
  const spec = artifactSpec(previous.artifact_kind);
  if (!spec) throw new FreshnessError('unknown_artifact', `no artifact kind "${previous.artifact_kind}"`, 404);

  const { factsById } = snapshot(ctx, orgId);
  const diff = regenerationDiff(previous, factsById);

  const result = generate(ctx, orgId, previous.artifact_kind, options);
  if (result.body.blocked) {
    // Worth saying plainly: the old version is still there and still valid as a
    // record of what was sent. Nothing was lost by trying.
    return ok({
      blocked: true,
      blockers: result.body.blockers,
      previous: present(previous),
      note: 'The regeneration is blocked, so the previous version is untouched and still available.',
    }, 200);
  }

  ctx.db.update('artifact', artifactId, {
    state: 'SUPERSEDED', superseded_by: result.body.artifact.id,
  });

  audit(ctx, orgId, 'artifact.regenerated', 'artifact', result.body.artifact.id, {
    from: artifactId, kind: previous.artifact_kind,
    figures_moving: diff.figures_moving, was_released: !!previous.released_at,
  });

  return ok({
    artifact: result.body.artifact,
    html: result.body.html,
    superseded: artifactId,
    diff,
    // The nudge, where it is actually useful.
    outstanding: previous.released_at
      ? `The previous version was sent out on ${previous.released_at.slice(0, 10)} — ${previous.released_note}. `
        + `${diff.figures_moving} figure${diff.figures_moving === 1 ? '' : 's'} moved since. `
        + 'Telling them yourself is a short conversation; them finding it is a different one.'
      : null,
  }, 201);
}

function present(row) {
  return {
    id: row.id, kind: row.artifact_kind, title: row.title, state: row.state,
    generated_at: row.generated_at, released_at: row.released_at, released_note: row.released_note,
    stale_since: row.stale_since,
    staleness: row.staleness ? JSON.parse(row.staleness) : null,
    superseded_by: row.superseded_by,
  };
}

// ──────────────────────────────────────────────────── room freshness ──

/**
 * Which documents in the room have gone out of date, judged by what they are.
 */
export function roomFreshness(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const now = ctx.now();

  const nodes = ctx.db.find('data_room_node', { org_id: orgId });
  const folderByNode = new Map(nodes.map((n) => [n.id, n.sort_key]));
  const docs = ctx.db.find('document', { org_id: orgId }).filter((d) => d.uploaded_at);

  const assessed = docs.map((d) => {
    const folderKey = folderByNode.get(d.data_room_node_id) ?? null;
    const freshness = documentFreshness(d, now, { folderKey });
    return {
      document_id: d.id, filename: d.filename, kind: d.kind,
      folder: folderKey, uploaded_at: d.uploaded_at,
      ...freshness,
      policy_kind: freshness.policy.kind,
      why: freshness.policy.why,
    };
  });

  const stale = assessed.filter((d) => d.state === 'STALE');
  const ageing = assessed.filter((d) => d.state === 'AGEING');

  return ok({
    documents: assessed.sort((a, b) => (b.days ?? -1) - (a.days ?? -1)),
    summary: {
      total: assessed.length,
      stale: stale.length,
      ageing: ageing.length,
      fresh: assessed.filter((d) => d.state === 'FRESH').length,
      timeless: assessed.filter((d) => d.state === 'TIMELESS').length,
    },
    policy: FRESHNESS_POLICY,
    // Said because the obvious complaint about any freshness feature is that it
    // nags about things that do not age.
    note: 'Documents are judged by what they are. A constitution does not go out of date on a clock, '
        + 'and a contract changes status when its term arrives rather than when a timer runs out.',
  });
}

// ────────────────────────────────────────────────────── what changed ──

/**
 * A digest of what moved since a given moment.
 *
 * Derived from the records rather than kept as a separate feed. The audit log
 * already holds every mutation, and facts carry their own history — a parallel
 * change table would be a second copy of the truth, which is the thing this
 * codebase keeps refusing to build.
 */
export function changesSince(ctx, orgId, since) {
  authorise(membershipOf(ctx, orgId), 'read');
  if (!Number.isFinite(Date.parse(since))) {
    throw new FreshnessError('invalid_since', 'a start date is required');
  }

  const after = (iso) => iso && String(iso).localeCompare(String(since)) > 0;
  const allFacts = ctx.db.find('fact', { org_id: orgId });
  const factsById = new Map(allFacts.map((f) => [f.id, f]));

  const newFacts = allFacts.filter((f) => after(f.created_at) && !f.superseded_by);
  const corrections = newFacts
    .map((f) => {
      const replaced = allFacts.find((p) => p.superseded_by === f.id);
      return replaced ? { fact_key: f.fact_key, label: f.label, was: replaced.value_numeric ?? replaced.value_text, now: f.value_numeric ?? f.value_text } : null;
    })
    .filter(Boolean);

  const added = newFacts.filter((f) => !allFacts.some((p) => p.superseded_by === f.id));

  const documents = ctx.db.find('document', { org_id: orgId })
    .filter((d) => after(d.uploaded_at))
    .map((d) => ({ id: d.id, filename: d.filename, kind: d.kind }));

  const gapsClosed = ctx.db.find('gap', { org_id: orgId })
    .filter((g) => after(g.closed_at))
    .map((g) => ({ criterion_ref: g.criterion_ref, description: g.description }));

  const variances = ctx.db.find('variance', { org_id: orgId })
    .filter((v) => after(v.explained_at))
    .map((v) => ({ fact_key: v.fact_key, period_end: v.period_end, explanation: v.explanation }));

  const assessments = ctx.db.find('assessment', { org_id: orgId })
    .filter((a) => after(a.completed_at))
    .map((a) => ({ band: a.band, total_weighted: a.total_weighted, completed_at: a.completed_at }));

  return ok({
    since,
    until: ctx.now(),
    corrections,
    facts_added: added.map((f) => ({ fact_key: f.fact_key, label: f.label })),
    documents_added: documents,
    gaps_closed: gapsClosed,
    variances_explained: variances,
    assessments_completed: assessments,
    material: corrections.length > 0,
    summary: `${corrections.length} figure${corrections.length === 1 ? '' : 's'} corrected, `
           + `${added.length} added, ${documents.length} document${documents.length === 1 ? '' : 's'} uploaded, `
           + `${gapsClosed.length} gap${gapsClosed.length === 1 ? '' : 's'} closed.`,
  });
}

export { FreshnessError, severityOf };
