/**
 * Phase 5 — artifact generation.
 *
 * The gate is the interesting part. Generation is refused, with reasons, when
 * the facts contradict each other, when a required figure is missing, when an
 * external claim cannot be cited properly, or when an image would print badly.
 * Each of those would otherwise produce a document that looks finished and is
 * wrong, which is the most expensive possible output.
 */

import { randomUUID } from 'node:crypto';
import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { usableFacts } from '../domain/facts.js';
import { score } from '../domain/assessment.js';
import { sortGaps } from '../domain/gaps.js';
import { unresolvedBlockers } from '../domain/conflicts.js';
import { ILLUSTRATIVE_NOTICE, ILLUSTRATIVE_MARKER_KEY } from '../domain/illustrative.js';
import {
  ARTIFACTS, artifactSpec, artifactsForPath, generationBlockers, coverage, ArtifactError,
} from '../domain/artifacts.js';
import { claimBlockers, evidenceSummary, citationProblems } from '../domain/evidence.js';
import { placementProblems } from '../domain/assets.js';
import { FactBinder, renderBlock, blockCss } from '../render/blocks.js';
import { htmlDocument, page } from '../render/document.js';
import { PAGE, withPalette, withLocale } from '../render/theme.js';
import { brandTokens } from './brand.js';
import { proseForGeneration } from './prose.js';
import { proseForLocale } from './localisation.js';
import { requireEntitlement } from './billing.js';
import { getRoom } from './dataroom.js';
import { credibilityReport, listVariances } from './cadence.js';
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

// ────────────────────────────────────────────────────────────── catalogue ──

export function listArtifacts(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const org = ctx.db.get('organisation', orgId);
  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));

  return ok({
    path: org.path,
    artifacts: artifactsForPath(org.path).map((spec) => ({
      kind: spec.kind, title: spec.title, purpose: spec.purpose,
      path: spec.path, size: spec.size,
      coverage: coverage(spec, facts),
    })),
    total_kinds: ARTIFACTS.length,
  });
}

// ──────────────────────────────────────────────────────────── the context ──

/**
 * Assemble everything an artifact may draw on.
 *
 * Only ever reads rows scoped to this organisation, so the absence of
 * cross-company content is structural rather than promised.
 */
export function buildArtifactContext(ctx, orgId, spec, options = {}) {
  const org = ctx.db.get('organisation', orgId);
  const now = ctx.now();

  const facts = usableFacts(ctx.db.find('fact', { org_id: orgId }));
  const documents = ctx.db.find('document', { org_id: orgId });
  const documentsById = Object.fromEntries(documents.map((d) => [d.id, d]));

  const assessments = ctx.db.find('assessment', { org_id: orgId })
    .filter((a) => a.is_complete)
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const latest = assessments[0] ?? null;

  const gaps = sortGaps(ctx.db.find('gap', { org_id: orgId }).filter((g) => !g.closed_at));

  let room = null;
  try { room = getRoom(ctx, orgId).body; } catch { room = null; }

  // External claims: a fact read from an EXTERNAL document, with the citation
  // that document carries. One citation per source, so ten figures from one
  // report cannot drift apart.
  const sources = ctx.db.find('external_source', { org_id: orgId });
  const sourceByDoc = new Map(sources.filter((s) => s.document_id).map((s) => [s.document_id, s]));

  const externalClaims = facts
    .filter((f) => f.source_doc_id && documentsById[f.source_doc_id]?.provenance_class === 'EXTERNAL')
    .map((f) => {
      const src = sourceByDoc.get(f.source_doc_id);
      return {
        fact: f,
        statement: f.label,
        provenance_class: 'EXTERNAL',
        citation: src
          ? {
            publisher: src.publisher, title: src.title, published_at: src.published_at,
            url: src.url, accessed_at: src.accessed_at, source_kind: src.source_kind,
            claim_class: src.claim_class, locator: f.source_page ? `p. ${f.source_page}` : null,
            quote: f.value_text && f.value_text.length >= 20 ? f.value_text : (options.quotes?.[f.id] ?? null),
            document_id: f.source_doc_id,
          }
          : {},
      };
    });

  // The cadence record, when there is one. Read through the service so the
  // same authorisation and the same shaping apply as anywhere else.
  let cadence = null;
  try {
    cadence = {
      ...credibilityReport(ctx, orgId).body,
      variances: listVariances(ctx, orgId).body.variances,
    };
  } catch { cadence = null; }

  return {
    org,
    spec,
    now,
    cadence,
    facts,
    documentsById,
    gaps,
    room,
    externalClaims,
    // ──────────────────────────────────────────────────────────────────────
    // WHETHER THIS ORGANISATION IS THE WORKED EXAMPLE
    //
    // Read off the marker fact rather than by asking the seeding module, which
    // imports this one. Read here rather than at the render, because a renderer
    // that had to remember to ask would eventually produce one document that
    // forgot.
    //
    // It matters because a generated document leaves the building. The web
    // pages carry the notice on every page, but a document is the thing that
    // gets printed, attached and forwarded, and a reader three forwards away
    // has no way to know the figures in it are invented. A deck of invented
    // figures that looks exactly like a real one is the single most damaging
    // artefact this product could produce, so the notice goes on every page of
    // it, verbatim, and the renderer cannot opt out.
    illustrative: facts.some((f) => f.fact_key === ILLUSTRATIVE_MARKER_KEY),
    assessment: latest ? { row: latest, result: score(JSON.parse(latest.scores), { partial: true }) } : null,
    orgTree: options.orgTree ?? null,
    cohorts: options.cohorts ?? null,
    // Stored prose unless the caller supplies its own. A deck generated without
    // passing prose should still carry what the company has written, rather than
    // silently coming out with empty narrative blocks.
    //
    // In a locale, each passage falls back to English on its own, so a deck with
    // three paragraphs approved and one not is three-quarters translated rather
    // than entirely English — and the fallbacks are reported.
    ...localisedProse(ctx, orgId, options),
  };
}

/**
 * Prose for this render, and the locale it is being written in.
 *
 * A caller supplying its own prose is taken at its word and gets no locale
 * applied to it — that path is for worked examples and tests, where the text is
 * the point and translating the numbers under it would be surprising.
 */
function localisedProse(ctx, orgId, options) {
  if (options.prose) return { prose: options.prose, locale: null, prose_fallbacks: [] };
  if (!options.locale || String(options.locale).startsWith('en-GB')) {
    return { prose: proseForGeneration(ctx, orgId), locale: options.locale ?? null, prose_fallbacks: [] };
  }
  const { prose, fallbacks, locale } = proseForLocale(ctx, orgId, options.locale);
  return { prose, locale, prose_fallbacks: fallbacks };
}

// ────────────────────────────────────────────────────────────── the gate ──

/**
 * Would this generate, and if not, why not?
 * Exposed on its own so a user can see the blockers before asking for the file.
 */
export function checkGenerable(ctx, orgId, kind, options = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const spec = artifactSpec(kind);
  if (!spec) throw new ArtifactError('unknown_artifact', `no artifact kind "${kind}"`, 404);

  const context = buildArtifactContext(ctx, orgId, spec, options);
  const conflicts = unresolvedBlockers(ctx.db.find('conflict', { org_id: orgId }));

  const externalProblems = context.externalClaims
    .map((c) => ({ claim: c.statement, blockers: claimBlockers(c, context.now) }))
    .filter((x) => x.blockers.length);

  const assets = ctx.db.find('brand_asset', { org_id: orgId });
  const assetProblems = [];
  for (const asset of assets) {
    const placement = options.placements?.[asset.id] ?? defaultPlacement(asset, spec);
    if (!placement) continue;
    for (const p of placementProblems(asset, placement)) {
      if (p.code !== 'aspect_mismatch') assetProblems.push({ asset: asset.filename, ...p });
    }
  }

  const { blockers, warnings } = generationBlockers(spec, {
    facts: context.facts,
    unresolvedHighConflicts: conflicts,
    externalClaimBlockers: externalProblems,
    assetProblems,
    path: context.org.path,
  });

  return ok({
    kind, title: spec.title,
    can_generate: blockers.length === 0,
    blockers, warnings,
    coverage: coverage(spec, context.facts),
    evidence: evidenceSummary(context.externalClaims, context.now),
    missing_optional: coverage(spec, context.facts).missing_optional,
  });
}

/** Logos go on covers at a known width; everything else needs an explicit placement. */
function defaultPlacement(asset, spec) {
  if (asset.asset_role !== 'LOGO') return null;
  const size = PAGE[spec.size] ?? PAGE.slide;
  return { widthMm: Math.min(size.width * 0.18, 48) };
}

// ─────────────────────────────────────────────────────────────── generate ──

/**
 * Generate an artifact.
 *
 * Returns the HTML and the exact set of facts and citations it rests on. The
 * PDF step is a separate tool (`tools/render.mjs`) because it needs a browser;
 * everything that decides what the document SAYS happens here, where it can be
 * tested without one.
 */
export function generate(ctx, orgId, kind, options = {}) {
  // A document that is not ready comes back as a 200 with its reasons, which is
  // a refusal however it travels — and the most useful refusal in the product,
  // because it counts the times somebody wanted a document the data room could
  // not yet support.
  return usage.around(ctx, orgId, 'ARTIFACT_GENERATED',
    () => doGenerate(ctx, orgId, kind, options),
    { refusedWhen: (result) => result.body.blocked === true });
}

function doGenerate(ctx, orgId, kind, options = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  // Gated here and nowhere else: generating is a write. Reading an artifact
  // already generated, and exporting it, are not gated anywhere.
  requireEntitlement(ctx, orgId, 'GENERATE_ARTIFACTS');
  const spec = artifactSpec(kind);
  if (!spec) throw new ArtifactError('unknown_artifact', `no artifact kind "${kind}"`, 404);

  const check = checkGenerable(ctx, orgId, kind, options).body;
  if (!check.can_generate) {
    const row = ctx.db.insert('artifact', {
      org_id: orgId, artifact_kind: kind, title: spec.title, state: 'BLOCKED',
      blocked_reason: JSON.stringify(check.blockers),
      spec: null, fact_refs: null, citations: null,
      html_key: null, pdf_key: null, page_count: null,
      generated_by: ctx.auth.userId, generated_at: null, superseded_by: null,
      created_at: ctx.now(),
    });
    audit(ctx, orgId, 'artifact.blocked', 'artifact', row.id,
      { kind, codes: check.blockers.map((b) => b.code) });

    // A blocked artifact is a 200 with reasons, not an error. The user has not
    // done anything wrong; the document is not ready, and the reasons are the
    // useful part of the response.
    return ok({ artifact: present(row), blocked: true, blockers: check.blockers }, 200);
  }

  const context = buildArtifactContext(ctx, orgId, spec, options);
  const binder = new FactBinder(context.facts);
  context.binder = binder;

  // Charts are drawn to a physical width that fits the page, so a chart can
  // never grow past the bottom of a fixed-height slide.
  const dims = PAGE[spec.size] ?? PAGE.slide;
  context.chartWidthMm = Math.round((dims.width - dims.margin * 2) * 0.86);
  context.slide = spec.size === 'slide';

  // Everything that draws happens inside the brand scope: chart series, accent
  // marks and the stylesheet all resolve from the same token set, so a document
  // cannot come out with branded CSS and a RaiseRoom-purple chart in it.
  const brand = brandTokens(ctx, orgId);
  // Locale outside the palette: one wraps how figures are WRITTEN, the other
  // what colour they are drawn in, and neither knows about the other.
  const html = withLocale(context.locale, () => withPalette(brand, () => {
    const rendered = spec.blocks.map((d) => renderBlock(d, context, binder)).filter(Boolean);

    // Blocks are laid onto pages at a cover break and at every section head, so
    // a deck breaks where its structure says rather than wherever the content
    // happens to overflow.
    return htmlDocument({
      title: `${context.org.name ?? 'Company'} — ${spec.title}`,
      size: spec.size,
      extraCss: blockCss(),
      body: paginate(rendered, spec, context),
      brand,
    });
  }));

  const usableClaims = context.externalClaims.filter((c) => claimBlockers(c, context.now).length === 0);

  // The key carries the artifact's own id, not its kind.
  //
  // Keyed by kind, regenerating a document would overwrite the bytes of the
  // version already sent to somebody — and a share pinned to that version
  // (`artifact_share.artifact_id`) would start serving the new one. The product
  // promises the opposite: nothing is changed under a reader. That promise is
  // kept here, in the key, or not at all.
  const artifactId = randomUUID();
  const htmlKey = `orgs/${orgId}/artifacts/${artifactId}.html`;

  const row = ctx.db.insert('artifact', {
    id: artifactId,
    org_id: orgId, artifact_kind: kind, title: spec.title, state: 'GENERATED',
    blocked_reason: null,
    spec: JSON.stringify({ blocks: spec.blocks, size: spec.size }),
    fact_refs: JSON.stringify(binder.factRefs()),
    citations: JSON.stringify(usableClaims.map((c) => c.citation)),
    html_key: htmlKey,
    pdf_key: `orgs/${orgId}/artifacts/${artifactId}.pdf`,
    page_count: null,
    generated_by: ctx.auth.userId, generated_at: ctx.now(), superseded_by: null,
    created_at: ctx.now(),
  });

  // Written where there is somewhere to write. The bytes ARE the document: a row
  // recording that a document was generated, with nothing behind the key it
  // names, is a promise the product cannot keep when somebody asks to see it.
  if (ctx.storage?.put) ctx.storage.put(htmlKey, html, { contentType: 'text/html; charset=utf-8' });

  audit(ctx, orgId, 'artifact.generated', 'artifact', row.id, {
    kind, facts: binder.factRefs().length, citations: usableClaims.length,
    missing_optional: binder.missingKeys().length,
  });

  return ok({
    artifact: present(row),
    html,
    fact_refs: binder.factRefs(),
    citations: usableClaims.map((c) => c.citation),
    missing_optional: binder.missingKeys(),
    evidence: evidenceSummary(context.externalClaims, context.now),
    locale: context.locale ?? 'en-GB',
    // Reported rather than left to be noticed. A deck that is mostly French with
    // one English paragraph in it is a state the user should be told about at
    // the moment they generate, not when a reader asks.
    prose_fallbacks: context.prose_fallbacks ?? [],
    ...(context.prose_fallbacks?.length
      ? {
        locale_note: `${context.prose_fallbacks.length} passage`
          + `${context.prose_fallbacks.length === 1 ? '' : 's'} had no approved translation and `
          + 'rendered in English. The figures and dates are in the right format regardless — those '
          + 'are never translated, they are formatted from your fact store.',
      }
      : {}),
    // Stated on every generation. The document is a rendering of referenced
    // facts; it contains no figure that was typed.
    note: 'Every figure in this document is a reference into your fact store. The appendix lists each one '
        + 'with the document and page it was confirmed from.',
  }, 201);
}

/** Lay blocks onto pages. A cover is its own page; a section head starts one. */
function paginate(rendered, spec, context) {
  const pages = [];
  let current = [];
  let lastType = null;

  const flush = () => {
    if (!current.length) return;
    pages.push(page(current.join('\n'), {
      className: spec.size === 'slide' ? 'slide-page' : '',
      flow: spec.size !== 'slide',
      foot: {
        left: context.org.name ?? '',
        right: `${spec.title} · ${pages.length + 1}`,
      },
      // On every page, verbatim, and not negotiable per page. A document is the
      // part of this product that travels: it gets printed, attached, forwarded
      // and screenshotted, and a reader three forwards from here has nothing
      // else to tell them the figures are invented. One notice on a cover page
      // relies on them having seen the cover.
      notice: context.illustrative ? ILLUSTRATIVE_NOTICE : null,
    }));
    current = [];
  };

  // A slide is a fixed box with no overflow, so packing blocks onto it until
  // they run out of room puts a chart through the footer and off the page. One
  // idea per slide, which is also how a deck should read; a flowing document
  // breaks at its section heads instead.
  const slide = spec.size === 'slide';
  const PAIRS = new Set(['KPI_ROW', 'PROSE']);

  spec.blocks.forEach((descriptor, i) => {
    const html = rendered[i];
    if (!html) return;
    const type = String(descriptor).split(':')[0];

    const breakBefore = slide
      ? current.length > 0 && !(PAIRS.has(type) && current.length === 1 && lastType && PAIRS.has(lastType))
      : (type === 'COVER' || type === 'SECTION' || type === 'APPENDIX') && current.length > 0;

    if (breakBefore) flush();
    current.push(html);
    lastType = type;
    if (type === 'COVER') flush();
  });
  flush();

  return pages.join('\n');
}

function present(row) {
  return {
    id: row.id, kind: row.artifact_kind, title: row.title, state: row.state,
    blocked_reason: row.blocked_reason ? JSON.parse(row.blocked_reason) : null,
    fact_refs: row.fact_refs ? JSON.parse(row.fact_refs) : [],
    citations: row.citations ? JSON.parse(row.citations) : [],
    generated_at: row.generated_at, created_at: row.created_at,
  };
}

// ────────────────────────────────────────────────────── external sources ──

/**
 * Register a citable external source.
 *
 * Refused outright if the citation is incomplete. There is no draft state for a
 * half-cited source, because a half-cited source is exactly what ends up in a
 * deck when someone means to come back to it.
 */
export function addExternalSource(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'write');

  const problems = citationProblems({ ...input, quote: input.quote ?? 'x'.repeat(20) });
  // The quote lives on the claim rather than the source, so it is excluded here.
  const relevant = problems.filter((p) => p.field !== 'quote' && p.field !== 'locator');
  if (relevant.length) {
    throw new ArtifactError('incomplete_citation',
      'This source cannot be registered until its citation is complete.', 400, { problems: relevant });
  }

  if (input.document_id) assertBelongsToOrg(ctx.db.get('document', input.document_id), orgId);

  const row = ctx.db.insert('external_source', {
    org_id: orgId, document_id: input.document_id ?? null,
    source_kind: input.source_kind, publisher: String(input.publisher).trim(),
    title: String(input.title).trim(), published_at: input.published_at,
    url: input.url ?? null, accessed_at: input.accessed_at ?? null,
    claim_class: input.claim_class ?? 'OTHER_EXTERNAL',
    added_by: ctx.auth.userId, created_at: ctx.now(),
  });

  // Marking the document external is what moves its figures onto the heavier
  // citation rules.
  if (input.document_id) {
    ctx.db.update('document', input.document_id, { provenance_class: 'EXTERNAL' });
  }

  audit(ctx, orgId, 'external_source.added', 'external_source', row.id,
    { publisher: row.publisher, title: row.title });
  return ok({ source: row }, 201);
}

export function listExternalSources(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  return ok({ sources: ctx.db.find('external_source', { org_id: orgId }) });
}

export function listGenerated(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  return ok({
    artifacts: ctx.db.find('artifact', { org_id: orgId })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(present),
  });
}

/**
 * The bytes of a generated document, as they were generated.
 *
 * Read from storage, never re-rendered. Re-rendering would resolve the fact
 * references against *today's* figures, which is how a document somebody is
 * holding quietly becomes a different document — the exact failure the staleness
 * machinery exists to make visible rather than to paper over.
 *
 * A missing object is a real state and says so: it happens to artifacts
 * generated before storage was configured, and the honest answer is that the
 * document has to be regenerated, not a page of silence.
 */
export function readGenerated(ctx, orgId, artifactId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const row = assertBelongsToOrg(ctx.db.get('artifact', artifactId), orgId);

  // Asked of `generated_at`, not of the state. There are five states and this
  // check was written against two of them; the sweep that marks a document
  // STALE then made it unreadable, which is the exact opposite of what stale
  // means — a stale document is one somebody may be holding, so being able to
  // read what it says is the whole requirement.
  if (!row.generated_at) {
    throw new AccessError('not_generated', 409, {
      detail: 'This document has not been generated yet, so there is nothing to show.',
    });
  }

  const bytes = row.html_key && ctx.storage?.get ? ctx.storage.get(row.html_key) : null;

  audit(ctx, orgId, 'artifact.viewed', 'artifact', row.id, { kind: row.artifact_kind });

  return ok({
    artifact: present(row),
    html: bytes ? bytes.toString('utf8') : null,
    // Named rather than implied. A viewer looking at a superseded version needs
    // to know that is what they are looking at, and a reader of a stale one
    // needs to know the figures under it have moved.
    superseded: Boolean(row.superseded_by),
    stale: row.state === 'STALE',
    stale_since: row.stale_since ?? null,
    staleness: row.staleness ? JSON.parse(row.staleness) : null,
  });
}

export { ArtifactError };
