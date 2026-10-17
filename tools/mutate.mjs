/**
 * Mutation testing.
 *
 * A passing test suite proves the code does something. It does not prove the
 * tests would notice if the code did something else. This script breaks each
 * load-bearing rule on purpose and checks the suite fails — and names which
 * tests caught it, so a rule guarded by exactly one assertion is visible.
 *
 *   node tools/mutate.mjs
 *
 * A mutation that survives is a rule nothing is actually protecting. Treat it
 * as a missing test, not as a curiosity.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    // The first version of this mutation changed the hard-coded source to
    // `candidate.source ?? 'USER_CONFIRMED'`, and it survived — correctly. The
    // guard below throws first, so that line was unreachable: an equivalent
    // mutant, not a missing test. The guard is the rule, so the guard is what
    // gets broken.
    name: 'the extractor is allowed to declare its own provenance',
    file: 'src/domain/extraction.js',
    from: "    if (candidate[field] !== undefined && candidate[field] !== null) {",
    to: "    if (false) {",
  },
  {
    name: 'a candidate may be shown without the text it was read from',
    file: 'src/domain/extraction.js',
    from: "  if (locator.length < 3) {",
    to: "  if (false) {",
  },
  {
    name: 'bulk confirm accepts figures nobody has seen',
    file: 'src/domain/extraction.js',
    from: "  const unseen = pending.filter((c) => !c.viewed_at);",
    to: "  const unseen = [];",
  },
  {
    name: 'high confidence skips review',
    file: 'src/domain/extraction.js',
    from: "  const unseen = pending.filter((c) => !c.viewed_at);",
    to: "  const unseen = pending.filter((c) => !c.viewed_at && (c.confidence ?? 0) < 0.9);",
  },
  {
    name: 'extractability is measured in total rather than per page',
    file: 'src/domain/extraction.js',
    from: "    const perPage = pages && pages > 0 ? Number(textCharacters) / Number(pages) : Number(textCharacters);",
    to: "    const perPage = Number(textCharacters);",
  },
  {
    name: 'a malformed candidate is dropped silently instead of reported',
    file: 'src/api/extraction.js',
    from: "      rejected.push({ candidate: raw?.fact_key ?? '(no key)', code: err.code, problem: err.message });",
    to: "      // dropped",
  },
  {
    name: 'percentage tolerance is absolute only',
    file: 'src/domain/conflicts.js',
    from: "  percent: { relative: 0.005, absolute: 0.5 },      // both must hold",
    to: "  percent: { absolute: 0.5 },",
  },
  {
    name: 'a currency mismatch is treated as an ordinary value difference',
    file: 'src/domain/conflicts.js',
    from: "  if (a.unit && b.unit && a.unit !== b.unit) {",
    to: "  if (false) {",
  },
  {
    name: 'conflicts are detected against unconfirmed extractions too',
    file: 'src/api/extraction.js',
    from: "  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));",
    to: "  const facts = ctx.db.find('fact', { org_id: orgId });",
  },
  {
    name: 'a conflict can be resolved without saying why',
    file: 'src/domain/conflicts.js',
    from: "  if (text.length < 10) {",
    to: "  if (false) {",
  },
  {
    name: 'an unresolved HIGH conflict no longer blocks generation',
    file: 'src/domain/conflicts.js',
    from: "  return conflicts.filter((c) => !c.resolved_at && c.severity === 'HIGH');",
    to: "  return [];",
  },
  {
    name: 'the conflict list omits where each figure was read from',
    file: 'src/domain/conflicts.js',
    from: "  const locator = side.locator ? ` — ${side.locator}` : '';",
    to: "  const locator = '';",
  },
  {
    name: 'a range is interpreted as its midpoint',
    file: 'src/domain/transfer-sheet.js',
    from: "  if (/\\d\\s*(?:-|–|to|\\/|and)\\s*\\d/i.test(String(raw).replace(/[\\s,$£€]/g, ''))) {",
    to: "  if (false) {",
  },
  {
    name: 'a blank box is read as zero',
    file: 'src/domain/transfer-sheet.js',
    from: "const isBlank = (raw) => raw === null || raw === undefined || BLANK.has(String(raw).trim().toLowerCase());",
    to: "const isBlank = (raw) => raw === null || raw === undefined;",
  },
  {
    name: 'imported workbook figures are marked as confirmed',
    file: 'src/api/onramp.js',
    from: "        source: 'USER_ENTERED',            // they wrote it; nothing was parsed",
    to: "        source: 'USER_CONFIRMED',",
  },
  {
    name: 'confirming a figure severs the link to its document',
    file: 'src/domain/facts.js',
    from: "export const DOCUMENT_BACKED_SOURCES = Object.freeze(['DOCUMENT_EXTRACTED', 'USER_CONFIRMED']);",
    to: "export const DOCUMENT_BACKED_SOURCES = Object.freeze(['DOCUMENT_EXTRACTED']);",
  },
  {
    name: 'an unconfirmed extraction counts as a usable fact',
    file: 'src/domain/facts.js',
    from: "export const USABLE_SOURCES = Object.freeze(['USER_ENTERED', 'USER_CONFIRMED', 'CALCULATED']);",
    to: "export const USABLE_SOURCES = Object.freeze(['USER_ENTERED', 'USER_CONFIRMED', 'CALCULATED', 'DOCUMENT_EXTRACTED']);",
  },
  {
    name: 'a timing claim is made from a single data point',
    file: 'src/domain/timing.js',
    from: "export const MIN_SAMPLE = 20;",
    to: "export const MIN_SAMPLE = 1;",
  },
  {
    name: 'a missing timing sample counts as zero days',
    file: 'src/domain/timing.js',
    from: "    .filter((v) => v !== null && v !== undefined && v !== '')",
    to: "",
  },
  {
    name: 'the two clocks are averaged together',
    file: 'src/domain/timing.js',
    from: "  if (clocks.size > 1) {",
    to: "  if (false) {",
  },
  {
    name: 'a milestone reached twice moves the first recorded time',
    file: 'src/api/timing.js',
    from: "    if (ctx.db.findOne('timing_event', { org_id: orgId, milestone: key })) return null;",
    to: "    ctx.db.find('timing_event', { org_id: orgId, milestone: key }).forEach((e) => ctx.db.remove('timing_event', e.id));",
  },
  // ── Phase 4 — the advisor ────────────────────────────────────────────────
  {
    name: 'a claim may be made with no citation at all',
    file: 'src/domain/advisor.js',
    from: "      if (!cites.length) {",
    to: "      if (false) {",
  },
  {
    name: 'a citation to something never retrieved is accepted',
    file: 'src/domain/advisor.js',
    from: "      if (resolved.unknown.length) {",
    to: "      if (false) {",
  },
  {
    name: 'the advisor may write a number from nowhere',
    file: 'src/domain/advisor.js',
    from: "      const loose = unaccountedNumerals(text, resolved);",
    to: "      const loose = [];",
  },
  {
    name: 'a number is accepted on magnitude, ignoring the precision written',
    file: 'src/domain/advisor.js',
    from: "  return Math.abs(actual - written.value) <= written.quantum / 2;",
    to: "  return Math.abs(actual - written.value) <= Math.max(written.quantum, Math.abs(actual) * 0.2);",
  },
  {
    name: 'forbidden claims are no longer screened out of answers',
    file: 'src/domain/advisor.js',
    from: "        if (rule.pattern.test(text)) {",
    to: "        if (false) {",
  },
  {
    name: 'refused questions reach the model anyway',
    file: 'src/domain/advisor.js',
    from: "    if (rule.patterns.some((p) => p.test(text))) {",
    to: "    if (false) {",
  },
  {
    name: 'an overdue record is cited without disclosing it',
    file: 'src/domain/advisor.js',
    from: "  if (overdue.length && !draft.staleness_acknowledged) {",
    to: "  if (false) {",
  },
  {
    name: 'an unverifiable answer is shown with a warning instead of withheld',
    file: 'src/api/advisor.js',
    from: "    answer_text: 'The advisor produced an answer that could not be verified against your records and the '",
    to: "    answer_text: renderAnswer(draft ?? { sections: [] }, { context, cites: [], overdue: [] }) || 'The advisor produced an answer that could not be verified against your records and the '",
  },
  {
    name: 'retrieval returns records it cannot explain',
    file: 'src/knowledge/retrieve.js',
    from: "    if (score >= MIN_SCORE && why.length > 0) {",
    to: "    if (score > 0) {",
  },
  {
    name: 'an unconfirmed extraction can be quoted back as established',
    file: 'src/api/advisor.js',
    from: "  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }))",
    to: "  const facts = (ctx.db.find('fact', { org_id: orgId }))",
  },
  {
    name: 'a question the corpus does not cover gets answered anyway',
    file: 'src/api/advisor.js',
    from: "  if (context.knowledge_empty) {",
    to: "  if (false) {",
  },
  {
    name: 'the corpus may speak for what investors require',
    file: 'src/knowledge/corpus.js',
    from: "      'A cap table is complete when three things agree without explanation: the table itself, the statutory '",
    to: "      'Investors require a cap table that reconciles. A cap table is complete when three things agree without explanation: the table itself, the statutory '",
  },
  {
    name: 'the corpus may carry an invented benchmark',
    file: 'src/knowledge/corpus.js',
    from: "      'A normalisation bridge runs from reported profit to underlying earnings, one adjustment per line, and '",
    to: "      'Most companies take about 6 weeks to build one. A normalisation bridge runs from reported profit to underlying earnings, one adjustment per line, and '",
  },
  // ── Phase 5 — artifact generation ────────────────────────────────────────
  {
    name: 'an absent cohort cell prints as zero again',
    file: 'src/render/charts.js',
    from: "      const v = toNumber(raw);\n      const x = labelW + cellW * j;\n      if (v === null) {",
    to: "      const v = Number(raw);\n      const x = labelW + cellW * j;\n      if (!Number.isFinite(v)) {",
  },
  {
    name: 'toNumber turns absence into zero',
    file: 'src/render/theme.js',
    from: "  if (value === null || value === undefined || value === '') return null;",
    to: "  if (value === null || value === undefined || value === '') return 0;",
  },
  {
    name: 'a missing required fact no longer blocks generation',
    file: 'src/domain/artifacts.js',
    from: "  const missing = (spec.requires ?? []).filter((k) => !present.has(k));",
    to: "  const missing = [];",
  },
  {
    name: 'unresolved contradictions no longer block generation',
    file: 'src/domain/artifacts.js',
    from: "  if (unresolvedHighConflicts.length) {",
    to: "  if (false) {",
  },
  {
    name: 'an external claim may be rendered without a citation',
    file: 'src/domain/artifacts.js',
    from: "  if (externalClaimBlockers.length) {",
    to: "  if (false) {",
  },
  {
    name: 'a stale market figure is accepted',
    file: 'src/domain/evidence.js',
    from: "  if (age.state === 'STALE') {",
    to: "  if (false) {",
  },
  {
    name: 'an external claim need not be confirmed by a human',
    file: 'src/domain/evidence.js',
    from: "  if (claim.fact?.source !== 'USER_CONFIRMED') {",
    to: "  if (false) {",
  },
  {
    name: 'a market figure may be sourced to an internal document',
    file: 'src/domain/evidence.js',
    from: "  if (claim.provenance_class !== 'EXTERNAL') {",
    to: "  if (false) {",
  },
  {
    name: 'a citation no longer needs a verbatim quote',
    file: 'src/domain/evidence.js',
    from: "  if (quote.length < MIN_QUOTE_CHARS) {",
    to: "  if (false) {",
  },
  {
    name: 'a low-resolution image is allowed through',
    file: 'src/domain/assets.js',
    from: "  if (dpi < floor) {",
    to: "  if (false) {",
  },
  {
    name: 'an image of unknown size is assumed adequate',
    file: 'src/domain/assets.js',
    from: "  if (!Number.isFinite(Number(asset.pixel_width))) {",
    to: "  if (false) {",
  },
  {
    name: 'a table shows an absent value as zero',
    file: 'src/render/tables.js',
    from: "    if (n === null) return `<span class=\"absent\">${escapeText(raw)}</span>`;",
    to: "    if (n === null) return '<span class=\"tnum\">0</span>';",
  },
  {
    name: 'figure precision is decided per cell rather than per column',
    file: 'src/render/tables.js',
    from: "    decimalsByKey[col.key] = compactDecimalsFor(rows.map((r) => r[col.key]));",
    to: "    decimalsByKey[col.key] = undefined;",
  },
  {
    name: 'a chart with no data draws an empty frame',
    file: 'src/render/charts.js',
    from: "  if (!categories.length || !series.length) {\n    return insufficientData('No data to chart yet.', { width, height });\n  }",
    to: "  if (false) {\n    return insufficientData('No data to chart yet.', { width, height });\n  }",
  },
  {
    name: 'the series palette no longer alternates luminance',
    file: 'src/render/theme.js',
    from: "  { hex: '#17202A', grey: 0.11, name: 'ink' },",
    to: "  { hex: '#8A4DF5', grey: 0.40, name: 'near-blade' },",
  },
  {
    name: 'label colour is picked without regard to luminance',
    file: 'src/render/charts.js',
    from: "  return L > 0.30 ? INK.primary : '#FFFFFF';",
    to: "  return '#FFFFFF';",
  },
  // ── Phase 6 — the operating cadence ──────────────────────────────────────
  {
    name: 'a locked forecast can be edited after the fact',
    file: 'src/domain/cadence.js',
    from: "  if (forecast.state === 'LOCKED' || forecast.state === 'SUPERSEDED') {",
    to: "  if (false) {",
  },
  {
    name: 'a superseded forecast is dropped from the record',
    file: 'src/api/cadence.js',
    from: "    .filter((f) => f.state === 'LOCKED' || f.state === 'SUPERSEDED');",
    to: "    .filter((f) => f.state === 'LOCKED');",
  },
  {
    name: 'a forecast can be revised without saying why',
    file: 'src/api/cadence.js',
    from: "  if (text.length < 10) {\n    throw new CadenceError('reason_required',",
    to: "  if (false) {\n    throw new CadenceError('reason_required',",
  },
  {
    name: 'a forecast can be locked with no stated basis',
    file: 'src/domain/cadence.js',
    from: "  if (!String(forecast.basis ?? '').trim()) {",
    to: "  if (false) {",
  },
  {
    name: 'materiality is measured against the outcome instead of the plan',
    file: 'src/domain/cadence.js',
    from: "  const ratio = Math.abs(a - f) / base;",
    to: "  const ratio = Math.abs(a - f) / Math.max(Math.abs(a), 1);",
  },
  {
    name: 'a period with no actual yet scores as a total miss',
    file: 'src/domain/cadence.js',
    from: "    if (!actual || actual.value_numeric === null || actual.value_numeric === undefined) {",
    to: "    if (false) {",
  },
  {
    name: 'an unexplained material variance still satisfies the criterion',
    file: 'src/domain/cadence.js',
    from: "complete.length >= CYCLES_NEEDED && needing.length === explained.length,",
    to: "complete.length >= CYCLES_NEEDED,",
  },
  {
    name: 'a locked forecast nobody measured counts as a cycle',
    file: 'src/api/cadence.js',
    from: "      complete: variances.length > 0,",
    to: "      complete: true,",
  },
  {
    name: 'two cycles are enough for the criterion',
    file: 'src/domain/cadence.js',
    from: "export const CYCLES_NEEDED = 3;",
    to: "export const CYCLES_NEEDED = 2;",
  },
  {
    name: 'a one-word variance explanation is accepted',
    file: 'src/api/cadence.js',
    from: "  if (text.length < 15) {",
    to: "  if (false) {",
  },
  {
    name: 'runway is computed from a zero burn',
    file: 'src/domain/cadence.js',
    from: "  if (!Number.isFinite(cash) || !Number.isFinite(burn) || burn <= 0) return null;",
    to: "  if (!Number.isFinite(cash) || !Number.isFinite(burn)) return null;",
  },
  {
    name: 'a derived figure loses its formula',
    file: 'src/domain/cadence.js',
    from: "    formula: `(${latest.label} ÷ ${monthsCovered} months) × 12`,",
    to: "    formula: null,",
  },
  // ── Phase 7 — staleness propagation ──────────────────────────────────────
  {
    name: 'every change raises the same flag',
    file: 'src/domain/freshness.js',
    from: "  const wrong = reasons.some((r) => stalenessReason(r.reason)?.wrong);\n  if (wrong) return released ? 'URGENT' : 'REVIEW';\n  return 'MINOR';",
    to: "  return released ? 'URGENT' : 'REVIEW';",
  },
  {
    name: 'a released document is treated like a draft',
    file: 'src/domain/freshness.js',
    from: "  const released = !!artifact.released_at;",
    to: "  const released = false;",
  },
  {
    name: 'a corrected figure no longer marks the artifact stale',
    file: 'src/domain/freshness.js',
    from: "    if (!sameValue(original, current)) {",
    to: "    if (false) {",
  },
  {
    name: 'a disputed figure is ignored',
    file: 'src/api/freshness.js',
    from: "      if (String(ref).startsWith('fact:')) disputed.add(String(ref).slice(5));",
    to: "      if (false) disputed.add(String(ref).slice(5));",
  },
  {
    name: 'new material is judged against every fact the company holds',
    file: 'src/api/freshness.js',
    from: "    const relevant = new Set([...(spec?.requires ?? []), ...(spec?.uses ?? [])]\n      .filter((k) => usableKeys.has(k))",
    to: "    const relevant = new Set([...usableKeys]\n      .filter(() => true)",
  },
  {
    name: 'an unconfirmed extraction counts as missing material',
    file: 'src/api/freshness.js',
    from: "  const usable = usableFacts(allFacts);",
    to: "  const usable = allFacts;",
  },
  {
    name: 'stale_since moves every time the check runs',
    file: 'src/api/freshness.js',
    from: "        stale_since: isStale ? (a.stale_since ?? now) : null,",
    to: "        stale_since: isStale ? now : null,",
  },
  {
    name: 'releasing does not need to say who it went to',
    file: 'src/api/freshness.js',
    from: "  if (text.length < 3) {",
    to: "  if (false) {",
  },
  {
    name: 'regenerating overwrites the released version',
    file: 'src/api/freshness.js',
    from: "  ctx.db.update('artifact', artifactId, {\n    state: 'SUPERSEDED', superseded_by: result.body.artifact.id,\n  });",
    to: "  ctx.db.remove('artifact', artifactId);",
  },
  {
    name: 'a blocked regeneration still supersedes the previous version',
    file: 'src/api/freshness.js',
    from: "  if (result.body.blocked) {",
    to: "  if (false) {",
  },
  {
    name: 'a supersession cycle is followed forever',
    file: 'src/domain/freshness.js',
    from: "    if (seen.has(current.superseded_by)) return { current, hops, broken: true, reason: 'cycle' };",
    to: "    if (false) return { current, hops, broken: true, reason: 'cycle' };",
  },
  {
    name: 'a constitution goes stale on a clock like everything else',
    file: 'src/domain/freshness.js',
    from: "  if (policy.staleAfterDays === null) {",
    to: "  if (false) {",
  },
  {
    name: 'documents jump straight from fresh to stale',
    file: 'src/domain/freshness.js',
    from: "  if (days > policy.staleAfterDays * 0.75) return { state: 'AGEING', days, policy };",
    to: "",
  },
  {
    name: 'a correction is reported as a brand new figure',
    file: 'src/api/freshness.js',
    from: "  const added = newFacts.filter((f) => !allFacts.some((p) => p.superseded_by === f.id));",
    to: "  const added = newFacts;",
  },
  // ── Phase 8 — live sharing ───────────────────────────────────────────────
  {
    // The first attempt at this mutation injected the token into a field that
    // a later key in the same object literal overwrote — an equivalent mutant,
    // not a missing test. Anchored where the hash is actually produced.
    name: 'the raw token is stored instead of its hash',
    file: 'src/domain/sharing.js',
    from: "    token_hash: hashToken(raw),",
    to: "    token_hash: raw,",
  },
  {
    name: 'a revoked link keeps working',
    file: 'src/domain/sharing.js',
    from: "  if (share.revoked_at) {",
    to: "  if (false) {",
  },
  {
    name: 'an expired link keeps working',
    file: 'src/domain/sharing.js',
    from: "  if (!now || String(now).localeCompare(String(share.expires_at)) > 0) {",
    to: "  if (false) {",
  },
  {
    name: 'an unknown token reveals that the company exists',
    file: 'src/domain/sharing.js',
    from: "    return { allowed: false, code: 'not_found', status: 404, says: 'This link is not valid.' };",
    to: "    return { allowed: true, code: 'ok', status: 200 };",
  },
  {
    name: 'a short or malformed token reaches the database',
    file: 'src/domain/sharing.js',
    from: "  return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(raw);",
    to: "  return true;",
  },
  {
    name: 'a pinned share silently follows the latest version',
    file: 'src/api/sharing.js',
    // Anchored on the single helper both the page and the document go through.
    // While this logic was written out twice, this anchor matched both copies,
    // broke whichever came first, and reported a tick for a rule that was still
    // intact on the other path.
    from: "  if (!artifact || share.share_mode !== 'FOLLOW_LATEST') return artifact;",
    to: "  if (!artifact) return artifact;",
  },
  {
    name: 'links are issued without an expiry',
    file: 'src/domain/sharing.js',
    from: "  return new Date(Date.parse(now) + days * 86_400_000).toISOString();",
    to: "  return '9999-12-31T00:00:00.000Z';",
  },
  {
    name: 'an expiry can be set years out',
    file: 'src/domain/sharing.js',
    from: "    if (at > maxAt) {",
    to: "    if (false) {",
  },
  {
    name: 'a room link ignores the stage and shows everything',
    file: 'src/api/sharing.js',
    from: "  const visible = visibleFolders(room.folders, share, visibleAtStage);",
    to: "  const visible = room.folders;",
  },
  {
    name: 'a room link lists items with no document behind them',
    file: 'src/api/sharing.js',
    from: "        .filter((i) => i.state === 'PRESENT')",
    to: "",
  },
  {
    name: 'a room link can be issued without naming a stage',
    file: 'src/api/sharing.js',
    from: "    if (!STAGES.includes(stage)) {",
    to: "    if (false) {",
  },
  {
    name: 'a link need not name its recipient',
    file: 'src/api/sharing.js',
    from: "  if (recipient.length < 2) {",
    to: "  if (false) {",
  },
  {
    name: 'sharing no longer counts as releasing',
    file: 'src/api/sharing.js',
    from: "  if (artifactId) {\n    const artifact = ctx.db.get('artifact', artifactId);",
    to: "  if (false) {\n    const artifact = ctx.db.get('artifact', artifactId);",
  },
  {
    name: 'an unanswered question is offered as precedent',
    file: 'src/domain/sharing.js',
    from: "    if (!p.answer) continue;                       // only answered ones are useful",
    to: "    if (false) continue;",
  },
  {
    name: 'a contradictory answer passes unflagged',
    file: 'src/domain/sharing.js',
    from: "    return shared / Math.max(draft.size, 1) < 0.5;",
    to: "    return false;",
  },
  {
    name: 'question matching stops stemming and misses rephrasings',
    file: 'src/domain/sharing.js',
    from: "    if (stem.endsWith('e') && stem.length >= 5) stem = stem.slice(0, -1);",
    to: "",
  },
  {
    name: 'a view is logged without recording which version was served',
    file: 'src/api/sharing.js',
    from: "    org_id: share.org_id, share_id: share.id, artifact_id: artifact?.id ?? null,",
    to: "    org_id: share.org_id, share_id: share.id, artifact_id: null,",
  },
  // ── Phase 9 — brand ──────────────────────────────────────────────────────
  {
    // The failure this whole module exists to prevent: a founder's pale accent
    // applied literally, producing labels nobody can read.
    name: 'a supplied accent is used for small text without being darkened',
    file: 'src/domain/brand.js',
    from: "      accent_text: forText.hex,     // small text",
    to: "      accent_text: accent,",
  },
  {
    name: 'the ladder walks HSL lightness again instead of luminance',
    file: 'src/domain/brand.js',
    from: "    const hex = atLuminance(base.h + HUE_STEP * i, sat, target);",
    to: "    const hex = toHex(hslToRgb({ h: base.h + HUE_STEP * i, s: sat, l: target }));",
  },
  {
    name: 'palette targets are taken in order rather than furthest-first',
    file: 'src/domain/brand.js',
    from: "      if (Math.abs(remaining[j] - previous) > Math.abs(remaining[pick] - previous)) pick = j;",
    to: "      if (false) pick = j;",
  },
  {
    name: 'a desaturated brand derives a palette of greys',
    file: 'src/domain/brand.js',
    from: "  const sat = saturation ?? Math.max(base.s, 0.35);",
    to: "  const sat = saturation ?? base.s;",
  },
  {
    // Replaced the mutation for a fixed-saturation fallback in `deriveBrand`.
    // That branch was unreachable — see the property test — so breaking it
    // changed nothing and the mutation correctly survived. The rule it was
    // standing in for is the ladder's alternation, which this breaks instead.
    name: 'the palette ladder stops alternating and drifts',
    file: 'src/domain/brand.js',
    from: "const LUMINANCE_LADDER = Object.freeze([0.18, 0.03, 0.42, 0.08, 0.58, 0.14, 0.32, 0.05]);",
    to: "const LUMINANCE_LADDER = Object.freeze([0.18, 0.19, 0.20, 0.21, 0.22, 0.23, 0.24, 0.25]);",
  },
  {
    name: 'greyscale separation is measured over all pairs, not adjacent ones',
    file: 'src/domain/brand.js',
    from: "  for (let i = 1; i < greys.length; i++) min = Math.min(min, Math.abs(greys[i] - greys[i - 1]));",
    to: "  for (let i = 0; i < greys.length; i++) for (let j = i + 1; j < greys.length; j++) min = Math.min(min, Math.abs(greys[j] - greys[i]));",
  },
  {
    name: 'a near-white accent is accepted',
    file: 'src/domain/brand.js',
    from: "    if (lum > 0.92) {",
    to: "    if (false) {",
  },
  {
    name: 'a dark page is accepted and half-converted',
    file: 'src/domain/brand.js',
    from: "    } else if (relativeLuminance(toHex(page)) < 0.5) {",
    to: "    } else if (false) {",
  },
  {
    name: 'a typeface is embedded without a licence acknowledgement',
    file: 'src/domain/brand.js',
    from: "  if (input.typeface && !input.typeface_licence_ack) {",
    to: "  if (false) {",
  },
  {
    name: 'the wash stays our purple behind a client\'s colours',
    file: 'src/domain/brand.js',
    from: "  const wash = atLuminance(accentHsl.h, Math.min(accentHsl.s, 0.45), WASH_LUMINANCE);",
    to: "  const wash = '#F7F5FF';",
  },
  {
    name: 'an adjustment is made without being reported',
    file: 'src/domain/brand.js',
    from: "  if (forText.adjusted) {",
    to: "  if (false) {",
  },
  {
    // Without the restore, a document that threw halfway through leaves one
    // organisation's colours set for whatever renders next.
    name: 'the palette scope does not restore after a render',
    file: 'src/render/theme.js',
    from: "    depth -= 1;\n    active = depth === 0 ? null : previous;",
    to: "    depth -= 1;",
  },
  {
    name: 'nesting two different brands is silently allowed',
    file: 'src/render/theme.js',
    from: "  if (depth > 0 && active && active.accent !== brand.accent) {",
    to: "  if (false) {",
  },
  {
    name: 'a black-and-white render picks up the brand colours',
    file: 'src/render/theme.js',
    from: "  if (mono) return SERIES_MONO[i % SERIES_MONO.length].hex;",
    to: "  if (mono && !active) return SERIES_MONO[i % SERIES_MONO.length].hex;",
  },
  {
    name: 'charts ignore the active palette and stay on ours',
    file: 'src/render/theme.js',
    from: "  const palette = active?.palette?.length ? active.palette : SERIES.map((s) => s.hex);",
    to: "  const palette = SERIES.map((s) => s.hex);",
  },
  {
    name: 'the stylesheet ignores the brand it was handed',
    file: 'src/render/document.js',
    from: "  const accent = t.accent ?? BRAND.blade;",
    to: "  const accent = BRAND.blade;",
  },
  {
    // The regression this caught: an org that never set a brand had its proofed
    // series palette replaced by a derivation of the standard accent.
    name: 'an org with no brand gets a derived standard instead of no override',
    file: 'src/api/brand.js',
    from: "  if (!row) return null;",
    to: "  if (!row) return standardBrand().tokens;",
  },
  {
    name: 'stored tokens are re-derived at render time',
    file: 'src/api/brand.js',
    from: "  const tokens = derived?.tokens ?? derived;",
    to: "  const tokens = deriveBrand(parseJson(row.supplied, {})).tokens;",
  },
  {
    name: 'a logo is checked at a narrow placement rather than its widest',
    file: 'src/api/brand.js',
    from: "  const problems = placementProblems(asset, { widthMm: 48 })",
    to: "  const problems = placementProblems(asset, { widthMm: 8 })",
  },
  {
    name: 'an asset id from another organisation is confirmed with a 403',
    file: 'src/api/brand.js',
    from: "    throw new BrandError('logo_not_found', 'no such asset', 404);",
    to: "    throw new BrandError('logo_not_found', 'not yours', 403);",
  },
  {
    name: 'any editor can restyle every document the company sends',
    file: 'src/api/brand.js',
    from: "  authorise(membershipOf(ctx, orgId), 'own');\n  // Setting a brand is a write.",
    to: "  authorise(membershipOf(ctx, orgId), 'write');\n  // Setting a brand is a write.",
  },
  {
    name: 'request fields are stored as supplied instead of being filtered',
    file: 'src/api/brand.js',
    from: "    if (input[field] !== undefined) out[field] = input[field];",
    to: "    out[field] = input[field];\n    Object.assign(out, input);",
  },
  {
    name: 'reset writes the standard into the profile instead of removing it',
    file: 'src/api/brand.js',
    from: "    ctx.db.remove('brand_profile', existing.id);",
    to: "    ctx.db.update('brand_profile', existing.id, { supplied: JSON.stringify({ accent: RAISEROOM_STANDARD.accent }) });",
  },
  {
    name: 'preview quietly saves what it previewed',
    file: 'src/api/brand.js',
    from: "  const derived = deriveBrand(supplied);\n  return ok({\n    ok: true,",
    to: "  const derived = deriveBrand(supplied);\n  ctx.db.insert('brand_profile', { org_id: orgId, supplied: JSON.stringify(supplied), derived: JSON.stringify(derived), adjustments: '[]', logo_asset_id: null, typeface: null, typeface_licence_ack: 0, created_by: ctx.auth.userId, created_at: ctx.now() });\n  return ok({\n    ok: true,",
  },
  {
    name: 'the report never says the standard reads better',
    file: 'src/api/brand.js',
    from: "  if (ratio !== null && ratio < CONTRAST_FLOOR.bodyText) {",
    to: "  if (false) {",
  },
  // ── found while visually proofing Phase 9 ────────────────────────────────
  {
    // Both reached rendered PDFs. Neither was caught by anything structural,
    // because in both cases the figure was correct — it was just written badly.
    name: 'a table column prints a raw, unformatted number',
    file: 'src/render/tables.js',
    from: "  if (typeof raw === 'number') {",
    to: "  if (false) {",
  },
  {
    name: 'the financial summary stops formatting mixed units per row',
    file: 'src/render/blocks.js',
    from: "            unit: f.unit ?? null,",
    to: "            unit: null,",
  },
  {
    name: 'a currency axis forces one precision across every scale it crosses',
    file: 'src/render/charts.js',
    from: "    const tickDecimals = unit === 'percent' || !compact\n      ? decimals\n      : compactDecimalsAt(t, scale.ticks);",
    to: "    const tickDecimals = decimals;",
  },
  {
    name: 'an axis that needs decimals loses them',
    file: 'src/render/theme.js',
    from: "  return clean.some((v) => Math.abs(Math.round(v * 10) / 10 - Math.round(v)) > 1e-9) ? 1 : 0;",
    to: "  return 0;",
  },
  {
    name: 'a fractional percentage is rounded to a whole number',
    file: 'src/render/theme.js',
    from: "    const d = decimals ?? percentDecimals([n]);",
    to: "    const d = decimals ?? 0;",
  },
  {
    name: 'percent precision is chosen per value rather than per set',
    file: 'src/render/theme.js',
    from: "  return clean.some((v) => Math.abs(Math.round(v * 10) / 10 - Math.round(v)) > 1e-9) ? 1 : 0;",
    to: "  return 1;",
  },
  {
    name: 'a percent table column loses its one-precision rule',
    file: 'src/render/tables.js',
    from: "    if (col.unit === 'percent') { decimalsByKey[col.key] = percentDecimals(rows.map((r) => r[col.key])); continue; }",
    to: "    if (false) { continue; }",
  },
  {
    name: 'chart value labels stop sharing a precision with each other',
    file: 'src/render/charts.js',
    from: "  return unit === 'percent' ? percentDecimals(clean) : compactDecimalsFor(clean);",
    to: "  return undefined;",
  },
  {
    name: 'a cohort heatmap rounds retention to whole points again',
    file: 'src/render/charts.js',
    from: "  const cellDecimals = setDecimals(flat, unit);",
    to: "  const cellDecimals = 0;",
  },
  {
    name: 'the financial summary stops sharing one precision across its percentages',
    file: 'src/render/blocks.js',
    from: "            decimals: f.unit === 'percent' ? pctDecimals : null,",
    to: "            decimals: null,",
  },
  // ── Phase 10 — the advisor acts ──────────────────────────────────────────
  {
    // THE mutation for this phase. Applying through the service layer is what
    // keeps every rule that protects a person's edit protecting this one.
    name: 'applying a proposal writes the row directly, skipping the service layer',
    file: 'src/api/actions.js',
    from: "    case 'MARK_ITEM_NOT_APPLICABLE':\n      return dataroom.markNotApplicable(ctx, orgId, row.target_id, payload.reason);",
    to: "    case 'MARK_ITEM_NOT_APPLICABLE':\n      return { body: ctx.db.update('data_room_item', row.target_id, { not_applicable: 1, na_reason: payload.reason, document_id: null }) };",
  },
  {
    name: 'a stale proposal is applied over whoever changed it',
    file: 'src/api/actions.js',
    from: "  if (moved.length) {",
    to: "  if (false) {",
  },
  {
    name: 'the precondition covers the whole row and cries stale at every edit',
    file: 'src/domain/actions.js',
    from: "  const fields = [...new Set([...action.reads, ...action.writes])];",
    to: "  const fields = Object.keys(row ?? {});",
  },
  {
    name: 'an expired proposal stays confirmable',
    file: 'src/api/actions.js',
    from: "  if (hasExpired(row, ctx.now())) {",
    to: "  if (false) {",
  },
  {
    name: 'a proposal can be confirmed twice',
    file: 'src/api/actions.js',
    from: "  if (row.state !== 'PROPOSED') {\n    throw new ActionError('not_confirmable',",
    to: "  if (false) {\n    throw new ActionError('not_confirmable',",
  },
  {
    name: 'a dependent action lands before the one it depends on',
    file: 'src/api/actions.js',
    from: "    if (!parent || parent.state !== 'APPLIED') {",
    to: "    if (false) {",
  },
  {
    name: 'undo overwrites a change somebody made after the action was applied',
    file: 'src/api/actions.js',
    from: "  if (changedSince.length) {",
    to: "  if (false) {",
  },
  {
    name: 'undo restores what the proposal asked for rather than what was there',
    file: 'src/domain/actions.js',
    from: "    const was = before?.[field] ?? null;\n    restore[field] = was;",
    to: "    restore[field] = null;",
  },
  {
    name: 'a payload may set fields the action never declared',
    file: 'src/domain/actions.js',
    from: "    if (!allowed.has(key)) {",
    to: "    if (false) {",
  },
  {
    name: 'an action outside the catalogue is accepted',
    file: 'src/domain/actions.js',
    from: "  if (!action) {\n    // Named rather than generic.",
    to: "  if (false) {\n    // Named rather than generic.",
  },
  {
    name: 'a proposed action needs no stated reason',
    file: 'src/domain/actions.js',
    from: "  if (rationale.length < 15) {",
    to: "  if (false) {",
  },
  {
    name: 'the advisor writes a figure into prose',
    file: 'src/api/actions.js',
    from: "      }).map((p) => ({ ...p, problem: p.problem })));",
    to: "      }).map((p) => ({ ...p, problem: p.problem })).filter(() => false));",
  },
  {
    // Narrowed deliberately. Since prose refuses EVERY numeral, widening the
    // cited context no longer changes whether a sentence is refused — it changes
    // which half of the report a figure lands in, and therefore whether the user
    // is offered a one-click insert or a form for something they already have.
    name: 'a figure the advisor never looked at is reported as one the company holds',
    file: 'src/api/actions.js',
    from: "  const factIds = refs.filter((r) => String(r).startsWith('fact:')).map((r) => String(r).slice(5));",
    to: "  const factIds = ctx.db.find('fact', { org_id: orgId }).map((f) => f.id);",
  },
  {
    name: 'a person may type a figure into prose',
    file: 'src/api/prose.js',
    from: "  const unaccounted = unaccountedNumerals(withoutFactRefs(text), context);",
    to: "  const unaccounted = [];",
  },
  {
    name: 'a fact reference that resolves to nothing is written anyway',
    file: 'src/api/prose.js',
    from: "    if (!byKey.has(key)) {",
    to: "    if (false) {",
  },
  {
    name: 'prose is overwritten instead of superseded',
    file: 'src/api/prose.js',
    from: "  if (current) ctx.db.update('prose_block', current.id, { superseded_by: row.id });",
    to: "  // overwritten",
  },
  {
    name: 'advisor-drafted prose is recorded as having no human author',
    file: 'src/api/actions.js',
    from: "        source: 'ADVISOR_DRAFTED_USER_APPROVED',",
    to: "        source: 'USER_WRITTEN',",
  },
  {
    name: 'a target in another organisation is acted on',
    file: 'src/api/actions.js',
    from: "      if (!row || (row.org_id && row.org_id !== orgId && row.id !== orgId)) {",
    to: "      if (!row) {",
  },
  {
    name: 'a batch of any size is accepted',
    file: 'src/api/actions.js',
    from: "  if (list.length > MAX_BATCH) {",
    to: "  if (false) {",
  },
  {
    name: 'a rejected proposal is forgotten rather than kept',
    file: 'src/api/actions.js',
    from: "  const updated = ctx.db.update('action_proposal', row.id, {\n    state: 'REJECTED', rejected_at: ctx.now(), rejected_by: ctx.auth.userId,",
    // The first version of this re-inserted the row, which preserved everything
    // the test checks — an equivalent mutant, correctly surviving. This one
    // actually destroys it.
    to: "  ctx.db.remove('action_proposal', row.id);\n  const updated = ({\n    ...row, state: 'REJECTED', rejected_at: ctx.now(), rejected_by: ctx.auth.userId,",
  },
  {
    name: 'the diff shown is built from the proposal rather than the current row',
    file: 'src/api/actions.js',
    from: "    change: action ? describeChange(action, payload, current ? snapshot(action, current) : before) : null,",
    to: "    change: action ? describeChange(action, payload, before) : null,",
  },
  {
    name: 'a duplicate folder name is allowed in one room',
    file: 'src/api/dataroom.js',
    from: "  if (siblings.some((n) => n.name.toLowerCase() === name.toLowerCase())) {",
    to: "  if (false) {",
  },
  {
    name: 'folder sort keys stop being padded, so 10 sorts before 9',
    file: 'src/api/dataroom.js',
    from: "  return String(next).padStart(2, '0');",
    to: "  return String(next);",
  },
  {
    name: 'compact precision is decided across scales rather than within one',
    file: 'src/render/theme.js',
    from: "  const atScale = values\n    .map(toNumber).filter((v) => v !== null).map(Math.abs)\n    .filter((v) => scaleOf(v) === scale);",
    to: "  const atScale = values.map(toNumber).filter((v) => v !== null).map(Math.abs);",
  },
  {
    name: 'the smallest figure in a scale decides its precision instead of the largest',
    file: 'src/render/theme.js',
    from: "  return Math.max(...atScale) / scale < 100 ? 1 : 0;",
    to: "  return Math.min(...atScale) / scale < 100 ? 1 : 0;",
  },
  {
    name: 'bar labels force one precision across every scale on the chart',
    file: 'src/render/charts.js',
    from: "          decimals: unit === 'percent' ? labelDecimals : compactDecimalsAt(v, flat),",
    to: "          decimals: labelDecimals,",
  },
  // ── the fact library and the repair path ─────────────────────────────────
  {
    // The rule the whole writing surface rests on. A literal that matches a
    // fact is still a typed figure: correct the fact and the sentence does not
    // follow it.
    name: 'a typed figure is allowed when a fact happens to hold that value',
    file: 'src/api/prose.js',
    from: "  const refused = [...new Set([...unaccounted, ...literals])];",
    to: "  const refused = [...new Set([...unaccounted])];",
  },
  {
    name: 'propose and confirm go back to applying different prose rules',
    file: 'src/api/actions.js',
    from: "      problems.push(...prose.checkProse(ctx, orgId, proposed.payload?.text ?? '', {",
    to: "      problems.push(...[].concat(ctx, orgId, proposed) && []); if (false) problems.push(...prose.checkProse(ctx, orgId, proposed.payload?.text ?? '', {",
  },
  {
    name: 'a repair offers no existing fact, so every figure looks new',
    file: 'src/api/factlib.js',
    from: "      .filter((f) => rendersValue(parsed, Number(f.value_numeric)))",
    to: "      .filter(() => false)",
  },
  {
    name: 'a percentage is matched against a figure in dollars',
    file: 'src/api/factlib.js',
    from: "      .filter((f) => (unit === 'percent' ? f.unit === 'percent' : f.unit !== 'percent' || !unit))",
    to: "      .filter(() => true)",
  },
  {
    name: 'a drafted fact is recorded as confirmed rather than entered',
    file: 'src/api/factlib.js',
    from: "        source: 'USER_ENTERED',\n        needs: unit ? [] : ['unit'],",
    to: "        source: 'USER_CONFIRMED',\n        needs: unit ? [] : ['unit'],",
  },
  {
    name: 'a unit is guessed for a figure whose notation did not state one',
    file: 'src/domain/factkeys.js',
    from: "  return null;\n}\n\n/**\n * The words around a figure, as a starting label.",
    to: "  return 'USD';\n}\n\n/**\n * The words around a figure, as a starting label.",
  },
  {
    name: 'a suggested key reuses one already in use',
    file: 'src/domain/factkeys.js',
    from: "  const taken = new Set(existing);",
    to: "  const taken = new Set();",
  },
  {
    name: 'every suggested key lands in the same group',
    file: 'src/domain/factkeys.js',
    from: "  const head = group ?? suggestGroup(label) ?? 'financials';",
    to: "  const head = 'financials';",
  },
  {
    name: 'a key keeps the noise words, so it reads as a sentence',
    file: 'src/domain/factkeys.js',
    from: "    .filter((w) => !NOISE.has(w));",
    to: "    .filter(() => true);",
  },
  {
    name: 'a label keeps the verb that led into the figure',
    file: 'src/domain/factkeys.js',
    from: "  while (picked.length && (TRAILING.test(picked[picked.length - 1]))) picked.pop();",
    to: "  // kept",
  },
  {
    name: 'recordAndInsert replaces every occurrence, not just the first',
    file: 'src/api/factlib.js',
    from: "  const repaired = body.replace(numeral, `{{fact:${factKey}}}`);",
    to: "  const repaired = body.split(numeral).join(`{{fact:${factKey}}}`);",
  },
  {
    name: 'recordAndInsert writes a fact row instead of going through the fact service',
    file: 'src/api/factlib.js',
    from: "    created = createFact(ctx, orgId, {",
    to: "    created = ({ body: { fact: ctx.db.insert('fact', { org_id: orgId, superseded_by: null, created_at: ctx.now(), ...(input.fact ?? {}), source: 'USER_ENTERED' }) } }).body.fact && createFact(ctx, orgId, {",
  },
  {
    name: 'autocomplete offers facts nobody has confirmed',
    file: 'src/api/factlib.js',
    from: "  const usable = usableFacts(ctx.db.find('fact', { org_id: orgId })\n    .filter((f) => !f.superseded_by)",
    to: "  const usable = (ctx.db.find('fact', { org_id: orgId })\n    .filter((f) => !f.superseded_by)",
  },
  {
    name: 'autocomplete matches only the key, so a writer must know it',
    file: 'src/api/factlib.js',
    from: "  if (label.startsWith(q)) return 3;",
    to: "  if (false) return 3;",
  },
  {
    name: 'library search matches any word rather than all of them',
    file: 'src/api/factlib.js',
    from: "  return q.split(/\\s+/).every((word) => haystack.includes(word));",
    to: "  return q.split(/\\s+/).some((word) => haystack.includes(word));",
  },
  {
    name: 'unconfirmed facts are no longer surfaced for confirmation',
    file: 'src/api/factlib.js',
    from: "  const awaiting = all.filter((f) => !usable.has(f.id));",
    to: "  const awaiting = [];",
  },
  {
    name: 'a writer with no facts is shown an empty list and no way forward',
    file: 'src/api/factlib.js',
    from: "    empty_state: count === 0",
    to: "    empty_state: false && count === 0",
  },
  // ── Phase 11 — localisation ──────────────────────────────────────────────
  {
    // The rule this entire phase exists for.
    name: 'a lost reference is restored from nothing rather than refused',
    file: 'src/domain/translation.js',
    from: "    if (count === 0) {",
    to: "    if (false) {",
  },
  {
    name: 'a duplicated reference passes',
    file: 'src/domain/translation.js',
    from: "    } else if (count > 1) {",
    to: "    } else if (false) {",
  },
  {
    name: 'an altered reference passes, pointing at a different figure',
    file: 'src/domain/translation.js',
    from: "    if (index >= refs.length || !Number.isInteger(index)) {",
    to: "    if (false) {",
  },
  {
    name: 'a figure invented during translation is kept',
    file: 'src/domain/translation.js',
    from: "  if (invented.length) {",
    to: "  if (false) {",
  },
  {
    name: 'a reformatted number is reported as an invented one',
    file: 'src/domain/translation.js',
    from: "const normaliseDigits = (token) => String(token).replace(/[^\\d]/g, '');",
    to: "const normaliseDigits = (token) => String(token);",
  },
  {
    name: 'fact references are sent to the translator unmasked',
    file: 'src/api/localisation.js',
    from: "  const { masked, refs } = mask(block.body);",
    to: "  const { refs } = mask(block.body); const masked = block.body;",
  },
  {
    name: 'a machine translation is usable without anyone reading it',
    file: 'src/api/localisation.js',
    from: "export const USABLE_TRANSLATION_STATES = Object.freeze(['HUMAN_APPROVED']);",
    to: "export const USABLE_TRANSLATION_STATES = Object.freeze(['HUMAN_APPROVED', 'MACHINE_TRANSLATED']);",
  },
  {
    name: 'a translation is approved even though the English moved on',
    file: 'src/api/localisation.js',
    from: "  if (hashOf(block.body) !== row.source_hash) {",
    to: "  if (false) {",
  },
  {
    name: 'a stale translation keeps being rendered',
    file: 'src/api/localisation.js',
    from: "        && t.source_hash === hashOf(block.body));",
    to: "      );",
  },
  {
    name: 'a disclaimer is sent to a translation model',
    file: 'src/api/localisation.js',
    from: "  if (!isTranslatable(kind)) {",
    to: "  if (false) {",
  },
  {
    name: 'a person may drop a reference when translating by hand',
    file: 'src/api/localisation.js',
    from: "  if (missing.length) {",
    to: "  if (false) {",
  },
  {
    name: 'a superseded passage is translated anyway',
    file: 'src/api/localisation.js',
    from: "  if (block.superseded_by) {",
    to: "  if (false) {",
  },
  {
    name: 'a right-to-left locale is accepted and half rendered',
    file: 'src/domain/locale.js',
    from: "  if (RTL.test(code)) return 'rtl';",
    to: "  if (false) return 'rtl';",
  },
  {
    name: 'a non-Latin script is accepted and renders as empty boxes',
    file: 'src/domain/locale.js',
    from: "  if (NON_LATIN.test(code)) return 'non_latin';",
    to: "  if (false) return 'non_latin';",
  },
  {
    name: 'an unsupported locale is accepted silently',
    file: 'src/domain/locale.js',
    from: "  if (!locale) {\n    const refusal = localeRefusal(code);",
    to: "  if (false) {\n    const refusal = localeRefusal(code);",
  },
  {
    name: 'negatives stop being bracketed outside English',
    file: 'src/domain/locale.js',
    from: "const wrapSign = (body, n, sign) => (n < 0 ? `(${body})` : (sign && n > 0 ? `+${body}` : body));",
    to: "const wrapSign = (body, n, sign) => (sign && n > 0 ? `+${body}` : body);",
  },
  {
    name: 'the scale suffix goes after the currency symbol',
    file: 'src/domain/locale.js',
    from: "    const body = isCurrency ? placeCurrency(code, unit, `${digits}${suffix}`) : `${digits}${suffix}`;",
    to: "    const body = isCurrency ? `${placeCurrency(code, unit, digits)}${suffix}` : `${digits}${suffix}`;",
  },
  {
    name: 'the currency symbol is always placed first, as in English',
    file: 'src/domain/locale.js',
    from: "  return currencyAt < numberAt",
    to: "  return true",
  },
  {
    name: 'the locale scope does not restore after a render',
    file: 'src/render/theme.js',
    from: "    localeDepth -= 1;\n    activeLocale = localeDepth === 0 ? null : previous;",
    to: "    localeDepth -= 1;",
  },
  {
    name: 'nesting two locales is silently allowed',
    file: 'src/render/theme.js',
    from: "  if (localeDepth > 0 && activeLocale && activeLocale !== code) {",
    to: "  if (false) {",
  },
  {
    name: 'figures ignore the locale in force',
    file: 'src/render/theme.js',
    from: "  if (activeLocale) {\n    return formatNumberIn(value, activeLocale, { unit, compact, decimals, sign });\n  }",
    to: "  if (false) {\n    return formatNumberIn(value, activeLocale, { unit, compact, decimals, sign });\n  }",
  },
  {
    name: 'document furniture ignores the locale and stays English',
    file: 'src/render/blocks.js',
    from: "const L = (key, values = {}) => s(key, currentLocale() ?? 'en-GB', values);",
    to: "const L = (key, values = {}) => s(key, 'en-GB', values);",
  },
  {
    // Breaking the service field is equivalent while every supported locale is
    // complete, so the mechanism behind it is what gets broken.
    name: 'an unfinished locale reports no missing strings',
    file: 'src/i18n/strings.js',
    from: "  return STRING_KEYS.filter((key) => !STRINGS[key][locale]);",
    to: "  return [];",
  },
  {
    name: 'a missing string key prints itself into the document',
    file: 'src/i18n/strings.js',
    from: "    throw new Error(`no string for key \"${key}\"`);",
    to: "    return { text: key, fell_back: true, key };",
  },
  // ── Phase 12 — tiers, billing and portfolio ──────────────────────────────
  {
    // The promise the whole phase rests on.
    // The first version of this read `Object.freeze([].length ? [] : [` — which
    // evaluates to the original array, so it changed nothing and survived
    // correctly. Removing an entry is the real break.
    name: 'exporting drops off the never-gated list',
    file: 'src/domain/billing.js',
    from: "  'EXPORT_EVERYTHING',    // and taking it away",
    to: "",
  },
  {
    name: 'a lapsed subscription takes the export away',
    file: 'src/api/export.js',
    from: "  authorise(membershipOf(ctx, orgId), 'read');\n\n  const org = ctx.db.get('organisation', orgId);",
    to: "  authorise(membershipOf(ctx, orgId), 'read');\n  { const s = ctx.db.findOne('subscription', { org_id: orgId }); if (s && s.state === 'EXPIRED') throw new AccessError('subscription_expired', 402); }\n\n  const org = ctx.db.get('organisation', orgId);",
  },
  {
    name: 'a past-due card cuts the customer off mid-raise',
    file: 'src/domain/billing.js',
    from: "export const WORKING_STATES = Object.freeze(['ACTIVE', 'PAST_DUE']);",
    to: "export const WORKING_STATES = Object.freeze(['ACTIVE']);",
  },
  {
    name: 'a billing refusal stops saying what has not been taken away',
    file: 'src/api/billing.js',
    from: "    still_yours: whatIsLost(),\n  });\n}",
    to: "  });\n}",
  },
  {
    name: 'the export lists its tables instead of discovering them',
    file: 'src/api/export.js',
    from: "    .filter((table) => db.columns(table).includes('org_id'))",
    to: "    .filter((table) => ['fact', 'document'].includes(table))",
  },
  {
    name: 'the export hands over live access tokens',
    file: 'src/api/export.js',
    from: "  const field = WITHHELD[table];",
    to: "  const field = null;",
  },
  {
    name: 'the export stops resolving its references',
    file: 'src/api/export.js',
    from: "      confirmed_from: f.source_doc_id",
    to: "      confirmed_from: false && f.source_doc_id",
  },
  {
    name: 'the workbook credit can be applied twice',
    file: 'db/schema.sql',
    from: "CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_redemption ON credit_application (redemption_id);",
    to: "CREATE INDEX IF NOT EXISTS ux_credit_redemption ON credit_application (redemption_id);",
  },
  {
    name: 'a credit is recorded even when the provider refused it',
    file: 'src/api/billing.js',
    from: "    throw new BillingError('credit_not_applied',",
    to: "    providerResult = null; if (false) throw new BillingError('credit_not_applied',",
  },
  {
    name: 'the credit goes against a monthly subscription',
    file: 'src/domain/billing.js',
    from: "  if (subscription.term !== 'ANNUAL') {",
    to: "  if (false) {",
  },
  {
    name: 'money is formatted through a float',
    file: 'src/domain/billing.js',
    from: "  if (!Number.isInteger(n)) {",
    to: "  if (false) {",
  },
  {
    name: 'an unverified webhook is believed',
    file: 'src/api/billing.js',
    from: "  if (!verified.ok) {",
    to: "  if (false) {",
  },
  {
    name: 'signatures are compared with a plain equality check',
    file: 'src/billing/interface.js',
    from: "  const same = timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));",
    to: "  const same = expected === given;",
  },
  {
    name: 'a retried webhook is applied again',
    file: 'src/api/billing.js',
    from: "  if (seen) {",
    to: "  if (false) {",
  },
  {
    name: 'a late cancellation undoes the renewal that superseded it',
    file: 'src/domain/billing.js',
    from: "  if (String(event.occurred_at) < String(subscription.last_event_at)) {",
    to: "  if (false) {",
  },
  {
    name: 'an unmapped event type is treated as a cancellation',
    file: 'src/domain/billing.js',
    from: "export const stateForEvent = (type) => EVENT_STATES[type] ?? null;",
    to: "export const stateForEvent = (type) => EVENT_STATES[type] ?? 'CANCELLED';",
  },
  {
    name: 'a webhook without an event id is accepted',
    file: 'src/api/billing.js',
    from: "  if (!eventRef) {",
    to: "  if (false) {",
  },
  {
    name: 'the webhook payload is reshaped rather than stored verbatim',
    file: 'src/api/billing.js',
    from: "    payload: String(rawBody),",
    to: "    payload: JSON.stringify({ type: event.type }),",
  },
  {
    name: 'a full plan removes a member instead of refusing a new one',
    file: 'src/domain/billing.js',
    from: "  if (currentMembers < plan.seats) {",
    to: "  if (true) {",
  },
  {
    name: 'a trial never ends',
    file: 'src/domain/billing.js',
    from: "    in_trial: String(now) < endsAt,",
    to: "    in_trial: true,",
  },
  {
    name: 'a stored subscription is ignored in favour of the trial',
    file: 'src/api/billing.js',
    from: "  const row = ctx.db.findOne('subscription', { org_id: orgId });\n  if (row) return row;",
    to: "  const row = null;",
  },
  {
    name: 'a holder can add a company to its own portfolio',
    file: 'src/api/portfolio.js',
    from: "function doInviteHolder(ctx, orgId, input = {}) {\n  authorise(membershipOf(ctx, orgId), 'own');",
    to: "function doInviteHolder(ctx, orgId, input = {}) {",
  },
  {
    name: 'a revoked link keeps showing the company',
    file: 'src/api/portfolio.js',
    from: "  const links = ctx.db.find('portfolio_link', { holder_org_id: holderOrgId, state: 'ACTIVE' });",
    to: "  const links = ctx.db.find('portfolio_link', { holder_org_id: holderOrgId }).filter((l) => l.state !== 'NEVER');",
  },
  {
    name: 'a portfolio entry carries every field regardless of the agreed scope',
    file: 'src/api/portfolio.js',
    from: "      if (allowed.has(key)) shared[key] = value;",
    to: "      shared[key] = value;",
  },
  // A mutation that added `facts` to `companySummary` was removed from here: the
  // consent filter in `portfolio()` strips any field nobody agreed to, so the
  // leak never reaches the response and the mutation was equivalent. That is
  // defence in depth working. The filter itself is broken by the mutation below,
  // which is the one that matters.
  {
    name: 'the portfolio is available without the plan that includes it',
    file: 'src/api/portfolio.js',
    from: "  requireEntitlement(ctx, holderOrgId, 'PORTFOLIO');",
    to: "  // ungated",
  },
  {
    // A consent nobody can inspect is not consent.
    name: 'a company is told "summary access" instead of the actual field list',
    file: 'src/api/portfolio.js',
    from: "    they_will_see: SHARED_FIELDS[scope],",
    to: "    they_will_see: `${scope} access`,",
  },
  // ── valuation readiness ──────────────────────────────────────────────────
  {
    // The line the whole feature is built around not crossing.
    name: 'the pack drops its statement that it contains no estimate',
    file: 'src/domain/valuation.js',
    from: "    no_estimate: 'This pack contains no estimate of what the company is worth, and will not. It '",
    to: "    no_estimate: '',\n    unused_no_estimate: 'This pack contains no estimate of what the company is worth, and will not. It '",
  },
  {
    name: 'an area is evidenced without the figure that demonstrates it',
    file: 'src/domain/valuation.js',
    from: "  const state = missingRequired.length\n    ? (anyEvidence ? 'PARTIAL' : 'NOT_STARTED')\n    : 'EVIDENCED';",
    to: "  const state = 'EVIDENCED';",
  },
  {
    name: 'an optional figure gates an area again, so optional is not optional',
    file: 'src/domain/valuation.js',
    from: "    ? (anyEvidence ? 'PARTIAL' : 'NOT_STARTED')\n    : 'EVIDENCED';",
    to: "    ? (anyEvidence ? 'PARTIAL' : 'NOT_STARTED')\n    : (presentOptional.length ? 'EVIDENCED' : 'PARTIAL');",
  },
  {
    name: 'an unconfirmed extraction counts as evidence in the pack',
    file: 'src/api/valuation.js',
    from: "  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));\n  const readiness = valuationReadiness(facts);",
    to: "  const facts = ctx.db.find('fact', { org_id: orgId });\n  const readiness = valuationReadiness(facts);",
  },
  {
    name: 'a missing multiple is reported as a non-positive one',
    file: 'src/domain/valuation.js',
    from: "  const m = multiple === null || multiple === undefined || multiple === ''\n    ? null\n    : Number(multiple);",
    to: "  const m = Number(multiple);",
  },
  {
    name: 'a multiple can be applied to an unconfirmed figure',
    file: 'src/domain/valuation.js',
    from: "  } else if (base.source === 'DOCUMENT_EXTRACTED') {",
    to: "  } else if (false) {",
  },
  {
    name: 'a typo of three extra digits reaches a document',
    file: 'src/domain/valuation.js',
    from: "  } else if (m > MAX_MULTIPLE) {",
    to: "  } else if (false) {",
  },
  {
    name: 'the result is labelled a valuation rather than an assumption',
    file: 'src/domain/valuation.js',
    from: "    label: `${trimMultiple(m)}× ${base.label} — your assumption`,",
    to: "    label: `Valuation at ${trimMultiple(m)}× ${base.label}`,",
  },
  {
    name: 'the assumption is filed beside the audited figures',
    file: 'src/api/valuation.js',
    from: "    fact_key: `assumption.${baseKey}.x${String(input.multiple).replace('.', '_')}`,",
    to: "    fact_key: `${baseKey}.valuation`,",
  },
  {
    name: 'the calculated figure loses the formula that makes it auditable',
    file: 'src/api/valuation.js',
    from: "    source: 'CALCULATED',\n    formula: result.formula,",
    to: "    source: 'USER_ENTERED',\n    formula: result.formula,",
  },
  {
    name: 'previewing an assumption stores it',
    file: 'src/api/valuation.js',
    from: "  const result = applyAssumption({ multiple: input.multiple, base });\n  return ok({ ok: true, ...result, stored: false });",
    to: "  const result = applyAssumption({ multiple: input.multiple, base });\n  calculateOnAssumption(ctx, orgId, input);\n  return ok({ ok: true, ...result, stored: false });",
  },
  {
    name: 'a chart heading is separated from its chart by a page break',
    file: 'src/render/blocks.js',
    from: "  .chart-group{ break-inside:avoid; page-break-inside:avoid; }",
    to: "  .chart-group{ }",
  },
  {
    name: 'a column named "index" comes back',
    file: 'db/schema.sql',
    from: '  sort_key    TEXT NOT NULL,             -- WAS `index`. Never reintroduce that name.',
    to: '  "index"     TEXT NOT NULL,',
  },
  // ──────────────────────────────────────────────────── the web layer ──
  //
  // These are the rules that have no home below the HTTP layer, so there is
  // nowhere else they could be tested from. Each one here was a real bug in
  // somebody's product.

  {
    name: 'a session token is stored in a readable form',
    file: 'src/web/security.js',
    from: 'export const hashToken = (raw) => createHash(\'sha256\').update(String(raw), \'utf8\').digest(\'hex\');',
    to: 'export const hashToken = (raw) => String(raw);',
  },
  {
    name: 'the scrypt work factor drops to something brute-forceable',
    file: 'src/web/security.js',
    from: 'export const SCRYPT = Object.freeze({ N: 32_768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });',
    to: 'export const SCRYPT = Object.freeze({ N: 1_024, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });',
  },
  {
    name: 'an empty CSRF token matches an empty expectation',
    file: 'src/web/security.js',
    from: '  if (a.length === 0 || a.length !== b.length) return false;',
    to: '  if (a.length !== b.length) return false;',
  },
  {
    name: 'a cross-origin form post is accepted',
    file: 'src/web/server.js',
    from: '        if (!originAllowed({ origin: req.headers.origin, host: url.host, secure })) {',
    to: '        if (false) {',
  },
  {
    name: 'the CSRF check is skipped',
    file: 'src/web/server.js',
    from: '        if (route.auth !== false && !csrfValid(body.csrf, session?.csrf_token)) {',
    to: '        if (false) {',
  },
  {
    name: 'a signed-out visitor reaches a page that needs a session',
    file: 'src/web/server.js',
    from: '      if (route.auth !== false && !user) {',
    to: '      if (false) {',
  },
  {
    name: 'an expired session is honoured rather than cleaned up',
    file: 'src/web/auth.js',
    from: '  if (String(ctx.now()) >= String(row.expires_at)) {',
    to: '  if (false) {',
  },
  {
    name: 'changing a password leaves other sessions signed in',
    file: 'src/web/auth.js',
    from: '  const ended = signOutEverywhere(ctx, userId).body.signed_out;',
    to: '  const ended = 0;',
  },
  {
    name: 'a font path can escape the font directory',
    file: 'src/web/server.js',
    from: "    if (name !== normalize(name) || name.includes('/') || !name.endsWith('.ttf')) {",
    to: '    if (false) {',
    equivalent:
      'nothing can reach it. `new URL(req.url, …)` collapses every `..` segment before the pathname '
      + 'is read, so a traversal never arrives with the `..` intact — `/assets/fonts/../../package.json` '
      + 'is received as `/package.json` and never enters this branch at all. What remains after that — '
      + 'a subdirectory, a percent-encoded dot, a non-font extension — resolves to a path that does '
      + 'not exist, so `existsSync` refuses it one line later with the same 404. `test/web.test.js` '
      + 'sends all of these down a raw socket rather than through fetch, which is the only way to put '
      + 'the bytes on the wire unnormalised, and they are still refused. The guard stays: it is what '
      + 'holds the day somebody adds a fonts subdirectory, or a future Node changes how pathnames are '
      + 'parsed, and it costs one comparison.',
  },
  {
    name: 'user content reaches a page unescaped',
    file: 'src/web/html.js',
    from: "  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')",
    to: "  .replace(/&/g, '&amp;')",
  },
  {
    name: 'a non-member gets 403 instead of 404, confirming the company exists',
    file: 'src/web/routes/shell.js',
    from: '        status: 404,',
    to: '        status: 403,',
  },
  {
    name: 'the next parameter can send a signed-in user off-site',
    file: 'src/web/routes/auth.js',
    from: "  if (!next.startsWith('/') || next.startsWith('//')) return '/';",
    to: "  if (!next) return '/';",
  },
  {
    name: 'a figure renders with no provenance at all',
    file: 'src/web/html.js',
    from: "    ${origin ? `<span class=\"figure-source\">${h(origin)}</span>` : ''}",
    to: '    ${\'\'}',
  },
  {
    name: 'a refusal shows its machine code instead of the sentence',
    file: 'src/web/wording.js',
    from: '  if (err?.detail) return err.detail;',
    to: '  if (false) return err.detail;',
  },
  {
    name: 'the generic wording wins over the sentence the rule author wrote',
    file: 'src/web/wording.js',
    from: '  if (message && message !== code && /\\s/.test(message)) return message;\n\n  if (code && REFUSAL_SENTENCES[code]) return REFUSAL_SENTENCES[code];',
    to: '  if (code && REFUSAL_SENTENCES[code]) return REFUSAL_SENTENCES[code];\n\n  if (message && message !== code && /\\s/.test(message)) return message;',
  },

  // ──────────────────────────────────── what the pages must keep saying ──

  {
    name: 'the illustrative notice is left off a generated page',
    file: 'src/api/artifacts.js',
    from: '      notice: context.illustrative ? ILLUSTRATIVE_NOTICE : null,',
    to: '      notice: null,',
  },
  {
    name: 'a real company’s document gets the illustrative notice',
    file: 'src/api/artifacts.js',
    from: '    illustrative: facts.some((f) => f.fact_key === ILLUSTRATIVE_MARKER_KEY),',
    to: '    illustrative: true,',
  },
  {
    name: 'the revoke reason is shown to the person it was withdrawn from',
    file: 'src/domain/sharing.js',
    from: "      says: 'Access to this material has been withdrawn by the company. If you were expecting it, '\n          + 'ask them for a new link.',",
    to: "      says: 'Access to this material has been withdrawn by the company. If you were expecting it, '\n          + `ask them for a new link. Reason given: ${share.revoke_reason}`,",
  },
  {
    name: 'a room link will render any document the company has generated',
    file: 'src/api/sharing.js',
    from: "  if (share.subject_kind !== 'ARTIFACT' || !share.artifact_id) {",
    to: '  if (false) {',
  },
  {
    name: 'a candidate state filter names a state that does not exist',
    file: 'src/web/routes/work.js',
    from: '        .filter((c) => !isDecided(c.state));',
    to: "        .filter((c) => c.state === 'PENDING');",
  },
  {
    name: 'the workbook credit banner shows whether or not it was applied',
    file: 'src/web/routes/plan.js',
    from: '          + (credit && !credit.applied',
    to: '          + (credit',
  },
  {
    name: 'a document upload is recorded against storage that is not there',
    file: 'src/web/routes/work.js',
    from: '      if (!storage) {',
    to: '      if (false) {',
  },
  {
    name: 'the demonstration seeds a database that already holds a company',
    file: 'src/web/demo.js',
    from: '  if (existing > 0) {',
    to: '  if (false) {',
  },
  {
    name: 'the worked example loads into a production deployment',
    file: 'src/web/boot.js',
    from: '  if (demo && production) {',
    to: '  if (false) {',
  },
  {
    name: 'the seed stops writing its prose, so two phases render empty',
    file: 'src/api/seed.js',
    from: "    written.push(prose.writeProse(ctx, orgId, slot, paragraphs.join('\\n\\n')).body.prose);",
    to: '    written.push(slot);',
  },
  // ── usage analytics ──────────────────────────────────────────────────────
  //
  // The feature most likely to erode the product's promise about
  // cross-organisation data, so the guards are mutated rather than trusted.
  {
    name: 'an organisation that objected to analytics is counted anyway',
    file: 'src/api/usage.js',
    from: '    if (!analyticsOn(org)) return false;',
    to: '    if (false) return false;',
  },
  {
    // Anchored in the domain rather than at the guard in `record`, because
    // mutating the guard only produces a row with a null cohort, which the NOT
    // NULL constraint rejects and the swallow hides — the mutation would be
    // "caught" by the schema rather than by anything that understands why the
    // worked example must not be counted.
    name: 'the worked example is counted as if it were a customer',
    file: 'src/domain/usage.js',
    from: '  if (demonstration) return null;',
    to: '  if (false) return null;',
  },
  {
    name: 'adoption is counted again every time, so first use means nothing',
    file: 'src/api/usage.js',
    from: '  if (tried.has(capability)) return false;',
    to: '  if (false) return false;',
  },
  {
    name: 'retention deletes the oldest day still inside the window',
    file: 'src/api/usage.js',
    from: '    .filter((row) => row.day < cutoff);',
    to: '    .filter((row) => row.day <= cutoff);',
  },
  {
    name: 'a refusal is timed as though it were the work, flattering the mean',
    file: 'src/api/usage.js',
    from: "    if (row.outcome === 'DONE') {",
    to: '    if (true) {',
  },
  // ── password reset and email ──────────────────────────────────────────────
  {
    // The one that would be a disclosure rather than a bug. A reset form that
    // answers differently for an address that has an account is an account
    // enumerator, and this product has customers in confidential processes.
    name: 'the reset form admits whether an address has an account',
    file: 'src/web/auth.js',
    from: "  if (!user) return answer;",
    to: "  if (!user) throw new AuthError('no_account', 'No account with that address.', 404);",
  },
  {
    name: 'a used reset link can be used again',
    file: 'src/web/security.js',
    from: "  if (row.used_at) {",
    to: "  if (false) {",
  },
  {
    name: 'an expired reset link is accepted',
    file: 'src/web/security.js',
    from: "  if (String(nowIso) >= String(row.expires_at)) {",
    to: "  if (false) {",
  },
  {
    name: 'setting a password does not spend the link',
    file: 'src/web/auth.js',
    from: `  ctx.db.update('password_reset', reset.id, { used_at: ctx.now() });
  ctx.db.update('user_account', user.id, {`,
    to: "  ctx.db.update('user_account', user.id, {",
  },
  {
    // The raw token is the secret. A stored copy of a live reset link is a
    // stored copy of the ability to take somebody's account.
    name: 'a reset token is stored in the clear',
    file: 'src/web/security.js',
    from: `export function mintResetToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, token_hash: hashToken(token) };`,
    to: `export function mintResetToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, token_hash: token };`,
  },
  {
    name: 'a reset leaves every other session signed in',
    file: 'src/web/auth.js',
    from: "  const ended = signOutEverywhere(ctx, user.id).body.signed_out;",
    to: "  const ended = 0;",
  },
  {
    // A token nobody can ever receive, minted by a deployment with no provider.
    name: 'a reset token is minted with no way to deliver it',
    file: 'src/web/auth.js',
    from: "  if (!ctx.emailer) {",
    to: "  if (false) {",
  },
  {
    name: 'the reset request route is not rate limited',
    file: 'src/web/throttle.js',
    from: "  'password-reset': Object.freeze({ attempts: 10, windowMs: 60 * 60_000 }),",
    to: "",
  },
  {
    // A newline in a header turns the rest of a subject into a second header,
    // and `Bcc:` is the one that matters.
    name: 'a newline in a recipient or subject reaches the provider',
    file: 'src/email/interface.js',
    from: "  if (/[\\r\\n]/.test(String(to)) || /[\\r\\n]/.test(String(subject))) {",
    to: "  if (false) {",
  },
  {
    name: 'a message may be sent with no plain-text body',
    file: 'src/email/interface.js',
    from: "  if (!text || !String(text).trim()) {",
    to: "  if (false) {",
  },
  // ── the legal pages ───────────────────────────────────────────────────────
  {
    // The failure this rule exists for: a policy going live with the sections
    // written to the company rather than to the reader.
    name: 'a document still carrying working notes is published',
    file: 'src/domain/legal.js',
    from: "    if (lower.includes(marker)) {",
    to: "    if (false) {",
  },
  {
    // A privacy policy published with [email provider] in its sub-processor
    // table is a public admission that nobody checked it.
    name: 'a document with an unfilled sub-processor name is published',
    file: 'src/domain/legal.js',
    from: "    if (lower.includes(placeholder.toLowerCase())) {",
    to: "    if (false) {",
  },
  {
    name: 'an empty file is served as a blank policy',
    file: 'src/domain/legal.js',
    from: "  if (!body.trim()) {",
    to: "  if (false) {",
  },
  {
    name: 'a refused document is served anyway',
    file: 'src/web/legal.js',
    from: "  if (!publishable) {",
    to: "  if (false) {",
  },
  {
    // Escaping happens BEFORE rendering. Reverse it and a clause containing
    // an angle bracket is eaten by the browser, silently.
    name: 'a legal document is rendered before it is escaped',
    file: 'src/domain/legal.js',
    from: "    out.push(`<p>${inline(esc(paragraph.join(' ')))}</p>`);",
    to: "    out.push(`<p>${inline(paragraph.join(' '))}</p>`);",
  },
];

/**
 * Restore whatever is currently mutated, whatever happens.
 *
 * This run is long enough that it gets interrupted — a timeout, a Ctrl-C, a
 * closed terminal. `finally` does not run when the process is signalled, and
 * one interrupted run left `usableFacts` stripped out of the advisor and
 * committed nothing to say so. The working tree then had a live bug in one of
 * the product's load-bearing rules, and the NEXT mutation run reported it as
 * the test that caught two unrelated mutations.
 *
 * So the restore is registered as soon as a file is touched and fires on the
 * way out by any route.
 */
const JOURNAL = 'tools/.mutate-inflight.json';

let inFlight = null;

function restoreInFlight() {
  if (!inFlight) return;
  writeFileSync(inFlight.file, inFlight.original);
  inFlight = null;
  if (existsSync(JOURNAL)) rmSync(JOURNAL);
}

/**
 * Recover a mutation a previous run could not clean up.
 *
 * The signal handlers below cover an interrupt or a timeout that signals the
 * process. They cover nothing at all against SIGKILL — which is what a harness
 * timeout actually sends, and which cannot be caught by anything. The second
 * interrupted run of this script left a mutation applied for exactly that
 * reason, after the signal handlers had been added to prevent it.
 *
 * So the original is written to disk BEFORE the file is touched. A later run
 * finds it and puts it back, which is the only approach that survives a kill
 * the process never hears about.
 */
function recoverFromJournal() {
  if (!existsSync(JOURNAL)) return false;
  let entry;
  try {
    entry = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  } catch {
    rmSync(JOURNAL);
    return false;
  }
  if (entry?.file && typeof entry.original === 'string') {
    const current = existsSync(entry.file) ? readFileSync(entry.file, 'utf8') : null;
    if (current !== entry.original) {
      writeFileSync(entry.file, entry.original);
      console.error(`Recovered ${entry.file} — a previous run was killed with a mutation applied.\n`);
      rmSync(JOURNAL);
      return true;
    }
  }
  rmSync(JOURNAL);
  return false;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreInFlight();
    console.error(`\n${signal} — the mutated file was restored before exiting.`);
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  restoreInFlight();
  console.error(err);
  process.exit(1);
});
process.on('exit', restoreInFlight);

recoverFromJournal();

/**
 * The suite must be green BEFORE anything is mutated.
 *
 * A pre-existing failure makes every mutation look caught, by the failing test,
 * and the run reports a reassuring number that means nothing. Checking once
 * costs one suite run out of a hundred and twenty.
 */
try {
  execSync('npm test 2>&1', { encoding: 'utf8', stdio: 'pipe' });
} catch (err) {
  const failing = [...String(err.stdout ?? '').matchAll(/^not ok \d+ - (.+)$/gm)]
    .map((x) => x[1]).filter((n) => !n.endsWith('.test.js'));
  console.error('The suite is already failing, so mutation results would be meaningless.\n');
  for (const name of failing.slice(0, 10)) console.error(`  · ${name}`);
  console.error('\nFix the tree first. If a previous run was interrupted, a mutation may still be '
    + 'applied on disk.');
  process.exit(1);
}

/**
 * Run a subset.
 *
 *   node tools/mutate.mjs --file src/api/factlib.js   # only mutations in that file
 *   node tools/mutate.mjs --match autocomplete        # only mutations whose name matches
 *
 * A full pass runs every mutation against the whole suite — at roughly 25
 * seconds a suite and a few hundred mutations, two to three hours. That is the
 * right cost before a handover and the wrong cost after changing three files,
 * and paying it every time is how a check stops being run at all. The filters
 * make the common case a minute, and `--file` on each file you touched is the
 * habit worth having.
 *
 * Run it with nothing else going on. Two suites competing for the same cores
 * roughly triples the wall clock, and an interactive `npm test` during a run
 * reports failures from whichever mutation happens to be applied — which looks
 * exactly like a broken tree and wastes an hour.
 *
 * A filtered run reports what it skipped, so a passing subset is never mistaken
 * for a passing suite.
 */
const argv = process.argv.slice(2);
const argFor = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyFile = argFor('--file');
const onlyMatch = argFor('--match');

const selected = MUTATIONS.filter((m) =>
  (!onlyFile || m.file === onlyFile || m.file.includes(onlyFile))
  && (!onlyMatch || m.name.toLowerCase().includes(onlyMatch.toLowerCase())));

if (!selected.length) {
  console.error('No mutations matched that filter.');
  process.exit(1);
}

const filtered = selected.length !== MUTATIONS.length;
if (filtered) {
  console.log(`Running ${selected.length} of ${MUTATIONS.length} mutations.`);
}

/**
 * How long the suite may take under one mutation before it is called hung.
 *
 * The suite runs in well under a minute. Five is generous enough that a slow
 * machine is never mistaken for a hang, and short enough that a hang does not
 * cost an afternoon.
 */
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;

const results = [];

for (const m of selected) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ ...m, outcome: 'STALE', detail: 'anchor not found — this mutation needs updating' });
    continue;
  }

  inFlight = { file: m.file, original };
  // Journalled before the write, so the original survives a kill this process
  // never gets to hear about.
  writeFileSync(JOURNAL, JSON.stringify(inFlight));
  writeFileSync(m.file, original.replace(m.from, m.to));
  let output = '';
  let failed = false;
  let hung = false;
  try {
    // ───────────────────────────────────────────────────────────────────────
    // A TIMEOUT, AND WHY IT IS NOT OPTIONAL
    //
    // A mutation can make the suite hang rather than fail — a route that
    // loops, or a test that leaks a listening socket and never lets its
    // process exit. Without a timeout the harness waits for ever, which is bad
    // enough; but `execSync` throwing on a timeout is indistinguishable from
    // it throwing on a failing test, so a hung suite was being reported as a
    // CAUGHT mutation. That is the worst outcome this tool can produce: a
    // reassuring tick for a rule nothing actually protects.
    //
    // So the timeout is explicit, generous against a suite that takes well
    // under a minute, and its outcome is reported as its own thing.
    // ───────────────────────────────────────────────────────────────────────
    // WHY THE REPORTER IS FORCED
    //
    // The test names below are scraped from TAP. Node's runner picks the
    // `spec` reporter by default — on Node 24 even when stdout is a pipe, as
    // it is here — and spec prints no `not ok N - name` lines at all. The
    // scrape then finds nothing, every mutation reports `caught by 0 tests`,
    // and the single-test warning this tool exists to raise never fires.
    //
    // It goes in NODE_OPTIONS rather than on the command line because
    // `npm test -- --test-reporter=tap` appends the flag after the file
    // pattern, where the runner takes it for another pattern and ignores it.
    execSync('npm test 2>&1', {
      encoding: 'utf8', stdio: 'pipe', timeout: SUITE_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --test-reporter=tap`.trim(),
      },
    });
  } catch (err) {
    // `err.signal` is set when the child was killed for exceeding the timeout.
    hung = err.killed === true || err.signal === 'SIGKILL';
    failed = !hung;
    output = String(err.stdout ?? '');
  } finally {
    restoreInFlight();
  }

  const caught = [...output.matchAll(/^not ok \d+ - (.+)$/gm)]
    .map((x) => x[1])
    .filter((n) => !n.endsWith('.test.js'));

  // ───────────────────────────────────────────────────────────────────────────
  // A MUTATION DECLARED EQUIVALENT
  //
  // Some rules are genuinely unreachable from outside, because something else
  // already stops the input from getting there. Breaking such a rule changes
  // nothing observable, so no test can catch it and no test should be contorted
  // into pretending to.
  //
  // Those are declared with `equivalent: '<why>'` rather than deleted, for two
  // reasons. The reasoning stays next to the rule, so the next person does not
  // rediscover it. And the harness checks the claim both ways: a mutation
  // declared equivalent that a test DOES catch is a declaration that has gone
  // wrong, which is reported as loudly as a survivor — the usual cause being
  // that the rule became reachable and nobody noticed.
  const outcome = hung
    ? 'HUNG'
    : failed
      ? (m.equivalent ? 'WRONGLY_EQUIVALENT' : 'CAUGHT')
      : (m.equivalent ? 'EQUIVALENT' : 'SURVIVED');

  results.push({
    ...m,
    outcome,
    count: caught.length,
    caught: caught.slice(0, 3),
    detail: outcome === 'EQUIVALENT'
      ? `equivalent by design — ${m.equivalent}`
      : outcome === 'WRONGLY_EQUIVALENT'
        ? `declared equivalent, but ${caught.length} test(s) caught it — the declaration is out of date`
        : outcome === 'HUNG'
          ? 'the suite did not finish — this result means nothing either way, and a test that can '
            + 'hang is a bug in the test rather than in the rule'
          : undefined,
  });
}

const width = Math.max(...results.map((r) => r.name.length));
let survived = 0;
let lonely = 0;
let equivalent = 0;
let hungCount = 0;

console.log('\nMutation testing — each rule broken on purpose\n');
for (const r of results) {
  const mark = r.outcome === 'CAUGHT' ? '✓'
    : r.outcome === 'EQUIVALENT' ? '–'
      : r.outcome === 'HUNG' ? '⏱' : '✗';
  const detail = r.outcome === 'CAUGHT'
    ? `caught by ${r.count} test${r.count === 1 ? '' : 's'}`
    : (r.detail ?? 'SURVIVED — nothing is protecting this rule');
  console.log(`  ${mark} ${r.name.padEnd(width)}  ${detail}`);
  if (r.outcome === 'CAUGHT' && r.count === 1) {
    lonely++;
    console.log(`      ${' '.repeat(width)}  └ only: ${r.caught[0]}`);
  }
  if (r.outcome === 'EQUIVALENT') equivalent++;
  else if (r.outcome === 'HUNG') hungCount++;
  else if (r.outcome !== 'CAUGHT') survived++;
}

// A hung run is neither caught nor survived. Counting it as either would be a
// claim the run did not earn, so it is excluded from the denominator and
// reported on its own.
const reachable = results.length - equivalent - hungCount;
console.log(`\n${reachable - survived}/${reachable} reachable mutations caught.`);
if (equivalent) {
  console.log(`${equivalent} declared equivalent and not counted — each says why, in the mutation.`);
}
if (filtered) {
  console.log(`${MUTATIONS.length - selected.length} not run. This is a subset, not the suite.`);
}
if (lonely) console.log(`${lonely} guarded by a single test — fine, but worth knowing.`);
if (hungCount) {
  console.log(`\n${hungCount} mutation(s) hung the suite and were not judged either way. `
    + 'A test that can hang is a bug in the test — the commonest cause is a listening socket '
    + 'that is never closed, which keeps the process alive for ever.');
  process.exitCode = 1;
}
if (survived) {
  console.log('\nA surviving mutation is a missing test, not a curiosity.');
  process.exitCode = 1;
}
