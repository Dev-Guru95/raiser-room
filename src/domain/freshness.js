/**
 * Freshness — what is still current, and what quietly stopped being true.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO IDEAS THIS MODULE IS BUILT ON
 *
 * **1. Staleness is not binary, and treating it as binary makes it useless.**
 *
 * A corrected label and a revenue figure moving thirty per cent both "change
 * the artifact". If both raise the same red flag, people stop looking at red
 * flags — the same failure the conflict detector was designed around, arriving
 * from a different direction. So staleness is graded by what actually moved:
 * a figure changing is not the same as a figure gaining better evidence, and
 * neither is the same as new material the document could have used.
 *
 * **2. The urgent case is the one somebody else is holding.**
 *
 * A stale draft is housekeeping. A deck in an investor's inbox quoting a number
 * the company has since corrected, with nobody told, is a trust problem with a
 * clock on it — and it is the situation this product exists to make impossible
 * to drift into. So `released_at` changes the grade, not just the wording.
 */

export class FreshnessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * What changed underneath an artifact.
 *
 * Ordered worst first. Each carries what it means and whether it makes the
 * document *wrong* as opposed to merely *improvable*, because those warrant
 * different behaviour and a user can tell the difference even if a flag cannot.
 */
export const STALENESS_REASONS = Object.freeze([
  {
    id: 'VALUE_CHANGED', wrong: true,
    means: 'A figure in this document has since been corrected. What the document says is no longer '
         + 'what your records say.',
  },
  {
    id: 'DISPUTED', wrong: true,
    means: 'A figure in this document is now the subject of an unresolved contradiction between two of '
         + 'your own records.',
  },
  {
    id: 'SOURCE_REPLACED', wrong: false,
    means: 'A figure is unchanged but now traces to a different source document. The appendix in this '
         + 'copy points at the old one.',
  },
  {
    id: 'PROVENANCE_IMPROVED', wrong: false,
    means: 'A figure is unchanged but has since been confirmed against a document. This copy '
         + 'understates the evidence behind it.',
  },
  {
    id: 'NEW_MATERIAL', wrong: false,
    means: 'Figures exist now that this document could have used. It is incomplete rather than wrong.',
  },
]);

const reasonById = new Map(STALENESS_REASONS.map((r) => [r.id, r]));
export const stalenessReason = (id) => reasonById.get(id) ?? null;

/**
 * Severity, which is a function of what changed AND who is holding it.
 *
 * URGENT exists only for released documents resting on something now wrong.
 * Nothing else earns it, because a grade that everything reaches is a grade
 * that means nothing.
 */
export const SEVERITIES = Object.freeze(['URGENT', 'REVIEW', 'MINOR', 'CURRENT']);

export function severityOf({ reasons = [], released = false } = {}) {
  if (!reasons.length) return 'CURRENT';
  const wrong = reasons.some((r) => stalenessReason(r.reason)?.wrong);
  if (wrong) return released ? 'URGENT' : 'REVIEW';
  return 'MINOR';
}

// ──────────────────────────────────────────────── supersession chains ──

/**
 * Follow a fact forward to whatever replaced it.
 *
 * Facts are immutable and corrections write a new row, so the id an artifact
 * recorded at generation time always still exists — it just may no longer be
 * the current statement. The guard against cycles is not paranoia: a
 * supersession loop would hang the request that asked whether a deck was
 * current, which is a bad way to find out about a data problem.
 */
export function resolveChain(factId, factsById, { maxHops = 50 } = {}) {
  let current = factsById.get(factId) ?? null;
  if (!current) return { current: null, hops: 0, broken: true };

  const seen = new Set([factId]);
  let hops = 0;

  while (current?.superseded_by) {
    if (hops >= maxHops) return { current, hops, broken: true, reason: 'chain_too_long' };
    if (seen.has(current.superseded_by)) return { current, hops, broken: true, reason: 'cycle' };

    const next = factsById.get(current.superseded_by);
    // A chain pointing at a row that is not there is a data problem, and
    // reporting the last good fact is better than reporting nothing.
    if (!next) return { current, hops, broken: true, reason: 'dangling' };

    seen.add(current.superseded_by);
    current = next;
    hops++;
  }

  return { current, hops, broken: false };
}

const sameValue = (a, b) => {
  if (!a || !b) return false;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return num(a.value_numeric) === num(b.value_numeric)
    && (a.value_text ?? null) === (b.value_text ?? null)
    && (a.value_date ?? null) === (b.value_date ?? null)
    && (a.unit ?? null) === (b.unit ?? null);
};

const CONFIDENCE = Object.freeze({ USER_ENTERED: 1, DOCUMENT_EXTRACTED: 0, USER_CONFIRMED: 2, CALCULATED: 1 });

/**
 * Assess one artifact against the current state of the facts it rests on.
 *
 * @param {object} artifact   with fact_refs
 * @param {Map} factsById
 * @param {object} [opts]     { disputedFactIds, availableKeys, asOf }
 */
export function artifactStaleness(artifact, factsById, {
  disputedFactIds = new Set(), candidateKeys = new Set(), asOf = null,
} = {}) {
  const refs = Array.isArray(artifact.fact_refs)
    ? artifact.fact_refs
    : JSON.parse(artifact.fact_refs ?? '[]');

  const reasons = [];
  const usedKeys = new Set();
  let brokenChains = 0;

  for (const id of refs) {
    const original = factsById.get(id);
    if (!original) { brokenChains++; continue; }
    usedKeys.add(original.fact_key);

    if (disputedFactIds.has(id)) {
      reasons.push({
        reason: 'DISPUTED', fact_id: id, fact_key: original.fact_key, label: original.label,
      });
    }

    const { current, broken } = resolveChain(id, factsById);
    if (broken) brokenChains++;
    if (!current || current.id === id) continue;

    if (!sameValue(original, current)) {
      reasons.push({
        reason: 'VALUE_CHANGED', fact_id: id, fact_key: original.fact_key, label: original.label,
        was: displayValue(original), now: displayValue(current), current_fact_id: current.id,
      });
      continue;
    }

    // Same value. The change was to how well it is evidenced, or to where it
    // came from — worth telling someone, not worth alarming them.
    if ((CONFIDENCE[current.source] ?? 0) > (CONFIDENCE[original.source] ?? 0)) {
      reasons.push({
        reason: 'PROVENANCE_IMPROVED', fact_id: id, fact_key: original.fact_key, label: original.label,
        was: original.source, now: current.source, current_fact_id: current.id,
      });
    } else if ((current.source_doc_id ?? null) !== (original.source_doc_id ?? null)) {
      reasons.push({
        reason: 'SOURCE_REPLACED', fact_id: id, fact_key: original.fact_key, label: original.label,
        current_fact_id: current.id,
      });
    }
  }

  // Material the artifact could have used but did not. Reported once, as a
  // count — listing forty new facts on a deck that needs none of them is noise.
  const newKeys = [...candidateKeys].filter((k) => !usedKeys.has(k));
  if (newKeys.length) {
    reasons.push({ reason: 'NEW_MATERIAL', keys: newKeys.slice(0, 10), count: newKeys.length });
  }

  const released = !!artifact.released_at;
  const severity = severityOf({ reasons, released });

  return {
    artifact_id: artifact.id,
    severity,
    released,
    reasons: reasons.map((r) => ({ ...r, means: stalenessReason(r.reason)?.means ?? null })),
    wrong: reasons.some((r) => stalenessReason(r.reason)?.wrong),
    broken_chains: brokenChains,
    checked_at: asOf,
    // The sentence a user reads. It says what to do, because "stale" on its own
    // prompts nothing.
    advice: adviceFor(severity, released, reasons),
  };
}

function displayValue(fact) {
  if (fact.value_numeric !== null && fact.value_numeric !== undefined) return Number(fact.value_numeric);
  return fact.value_text ?? fact.value_date ?? null;
}

function adviceFor(severity, released, reasons) {
  if (severity === 'CURRENT') return null;
  if (severity === 'URGENT') {
    const changed = reasons.filter((r) => r.reason === 'VALUE_CHANGED').length;
    return `This document has been sent out and ${changed === 1 ? 'a figure in it has' : `${changed} figures in it have`} `
         + 'since changed. Regenerate it and tell whoever is holding the old copy. A counterparty who '
         + 'finds the difference themselves will wonder what else moved.';
  }
  if (severity === 'REVIEW') {
    return 'A figure behind this document has changed. Regenerate before sending it anywhere.';
  }
  return 'Nothing in this document is wrong. Regenerating would improve what the appendix can show.';
}

// ───────────────────────────────────────────── document freshness ──

/**
 * How quickly a document goes out of date, by what it is.
 *
 * A flat interval is the lazy version and it is actively misleading: it would
 * flag the articles of association every quarter while treating management
 * accounts from February as fine in October. A constitution does not age. A
 * monthly account ages in weeks.
 *
 * `staleAfterDays: null` means it does not age on a clock. Those documents go
 * out of date when something happens — a share issue, a contract renewal — and
 * claiming a date for that would be inventing one.
 */
export const FRESHNESS_POLICY = Object.freeze({
  ACCOUNTS: { staleAfterDays: 45, why: 'Management accounts are produced monthly; a set older than six weeks suggests the rhythm has slipped.' },
  MODEL: { staleAfterDays: 120, why: 'A model more than four months old usually predates the last quarter’s actuals.' },
  CAP_TABLE: { staleAfterDays: 180, why: 'A cap table ages on events rather than on a clock, but six months without a refresh is worth a check.' },
  DECK: { staleAfterDays: 120, why: 'A deck older than four months usually quotes figures that have moved.' },
  CONTRACT: { staleAfterDays: null, why: 'A contract does not age. It changes status when its term, notice or renewal date arrives.' },
  CONSTITUTIONAL: { staleAfterDays: null, why: 'Constitutional documents do not go out of date with time.' },
  OTHER: { staleAfterDays: 365, why: 'A general review interval for anything not otherwise classified.' },
});

/** Data-room folders whose contents do not age on a clock. */
const TIMELESS_FOLDERS = Object.freeze(['02', '09']);

export function policyFor(doc = {}, { folderKey = null } = {}) {
  if (folderKey && TIMELESS_FOLDERS.includes(String(folderKey))) {
    return { kind: 'CONSTITUTIONAL', ...FRESHNESS_POLICY.CONSTITUTIONAL };
  }
  const kind = FRESHNESS_POLICY[doc.kind] ? doc.kind : 'OTHER';
  return { kind, ...FRESHNESS_POLICY[kind] };
}

/**
 * @returns {{state: 'FRESH'|'AGEING'|'STALE'|'TIMELESS', days: number|null}}
 */
export function documentFreshness(doc = {}, asOf, { folderKey = null } = {}) {
  const policy = policyFor(doc, { folderKey });
  const from = Date.parse(doc.uploaded_at ?? doc.created_at);
  if (!Number.isFinite(from)) return { state: 'UNKNOWN', days: null, policy };

  if (policy.staleAfterDays === null) {
    return { state: 'TIMELESS', days: null, policy };
  }

  const days = Math.floor((Date.parse(asOf) - from) / 86_400_000);
  if (days > policy.staleAfterDays) return { state: 'STALE', days, policy };
  if (days > policy.staleAfterDays * 0.75) return { state: 'AGEING', days, policy };
  return { state: 'FRESH', days, policy };
}

// ─────────────────────────────────────────────────── regeneration ──

/**
 * What would actually change if this artifact were regenerated.
 *
 * Shown before regenerating, because "I regenerated and now I do not know what
 * is different" is a worse position than the stale document. Every figure that
 * moves is named, with both values.
 */
export function regenerationDiff(artifact, factsById) {
  const refs = Array.isArray(artifact.fact_refs)
    ? artifact.fact_refs
    : JSON.parse(artifact.fact_refs ?? '[]');

  const changes = [];
  for (const id of refs) {
    const original = factsById.get(id);
    if (!original) continue;
    const { current } = resolveChain(id, factsById);
    if (!current || current.id === id) continue;

    changes.push({
      fact_key: original.fact_key,
      label: original.label,
      was: displayValue(original),
      now: displayValue(current),
      unit: current.unit ?? original.unit,
      value_moved: !sameValue(original, current),
      was_source: original.source,
      now_source: current.source,
    });
  }

  return {
    changes,
    figures_moving: changes.filter((c) => c.value_moved).length,
    provenance_only: changes.filter((c) => !c.value_moved).length,
    // Stated so nobody has to infer it. Regeneration makes a new version; the
    // released copy stays exactly as it was sent.
    note: 'Regenerating writes a new version. Any copy already sent out stays as it was — this product '
        + 'does not rewrite a document somebody else is holding.',
  };
}
