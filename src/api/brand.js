/**
 * Phase 9 — brand.
 *
 * One organisation, one brand profile. What the user supplied is stored exactly
 * as they gave it; what documents render from is DERIVED from it and stored
 * alongside, with the list of adjustments that produced it.
 *
 * Storing both is the point. If only the derived tokens were kept, a founder
 * asking "why is my accent darker here than on my website" could only be
 * answered with a guess, and a later change to the derivation would silently
 * rewrite colours they had already approved. If only the supplied values were
 * kept, every render would re-derive and a change to the contrast floors would
 * change documents that had already gone to investors.
 *
 * So: supplied is the record of intent, derived is the record of output, and
 * re-deriving is an explicit act with its own audit entry.
 */

import { authorise } from '../domain/access.js';
import {
  deriveBrand, standardBrand, validateBrand, BrandError,
  RAISEROOM_STANDARD, contrastRatio, CONTRAST_FLOOR, MIN_GREYSCALE_SEPARATION,
  greyscaleSeparation,
} from '../domain/brand.js';
import { placementProblems } from '../domain/assets.js';
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

const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

/** The fields a user may supply. Anything else in the request body is ignored. */
const SUPPLIED_FIELDS = Object.freeze(['accent', 'primary', 'page', 'typeface', 'typeface_licence_ack']);

const pickSupplied = (input = {}) => {
  const out = {};
  for (const field of SUPPLIED_FIELDS) {
    if (input[field] !== undefined) out[field] = input[field];
  }
  return out;
};

// ───────────────────────────────────────────────────────────────── read ──

/**
 * The brand in force, derived tokens included.
 *
 * Never 404s. An organisation that has set no brand has the RaiseRoom standard,
 * which is a real answer — the renderer needs a token set whatever the user has
 * done, and a caller that has to handle "no brand" separately is a caller that
 * will one day render a document with no colours at all.
 */
export function getBrand(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const row = ctx.db.findOne('brand_profile', { org_id: orgId });
  if (!row) {
    return ok({
      source: 'STANDARD',
      supplied: null,
      ...standardBrand(),
      logo: null,
      typeface: null,
    });
  }
  return ok({
    source: 'CUSTOM',
    supplied: parseJson(row.supplied, {}),
    tokens: parseJson(row.derived, {}).tokens ?? parseJson(row.derived, {}),
    palette: parseJson(row.derived, {}).palette ?? [],
    contrast: parseJson(row.derived, {}).contrast ?? {},
    note: parseJson(row.derived, {}).note ?? '',
    adjustments: parseJson(row.adjustments, []),
    logo: row.logo_asset_id ? logoSummary(ctx, orgId, row.logo_asset_id) : null,
    typeface: row.typeface ?? null,
    set_at: row.created_at,
  });
}

/**
 * The token set the renderer should use, as a plain object.
 *
 * Returns the STORED derived tokens for a custom brand rather than re-deriving,
 * so a document regenerated next year comes out in the colours that were
 * approved, not in whatever the current contrast logic would produce. This is
 * the function artifact generation calls; it does no authorisation of its own
 * because its callers have already done it.
 */
export function brandTokens(ctx, orgId) {
  const row = ctx.db.findOne('brand_profile', { org_id: orgId });
  // Null, not the standard token set. An organisation that has set no brand
  // should render exactly as it did before this feature existed, which means
  // the renderer's own proofed defaults rather than a token set that happens to
  // hold the same accent. Passing the standard through here replaced the
  // hand-ordered Phase 5 series palette with a derivation of it in every
  // document in the product, which is not a thing a brand feature should do to
  // the people who never used it.
  if (!row) return null;
  const derived = parseJson(row.derived, null);
  const tokens = derived?.tokens ?? derived;
  // A profile whose derived tokens are unreadable is worse than none: it would
  // render a document with undefined colours.
  return tokens?.accent ? tokens : null;
}

function logoSummary(ctx, orgId, assetId) {
  const asset = ctx.db.get('brand_asset', assetId);
  if (!asset || asset.org_id !== orgId) return null;
  return {
    id: asset.id,
    filename: asset.filename,
    is_vector: Boolean(asset.is_vector),
    pixel_width: asset.pixel_width,
    pixel_height: asset.pixel_height,
  };
}

// ──────────────────────────────────────────────────────────── preview ──

/**
 * Derive without saving.
 *
 * The adjustments are the reason this exists. A user picking a colour should see
 * what will be changed and why BEFORE it is applied to their documents, because
 * discovering it afterwards — in a rendered deck, with no explanation — is
 * indistinguishable from the product having got their colour wrong.
 */
export function previewBrand(ctx, orgId, input = {}) {
  authorise(membershipOf(ctx, orgId), 'read');
  const supplied = pickSupplied(input);

  const problems = validateBrand(supplied);
  if (problems.length) {
    return ok({ ok: false, problems, standard: RAISEROOM_STANDARD }, 200);
  }

  const derived = deriveBrand(supplied);
  return ok({
    ok: true,
    supplied,
    ...derived,
    floors: {
      body_text: CONTRAST_FLOOR.bodyText,
      ui_element: CONTRAST_FLOOR.uiElement,
      greyscale_separation: MIN_GREYSCALE_SEPARATION,
    },
    // A preview is not a saved brand, and saying so prevents the most annoying
    // possible support ticket: "I set my colours and nothing changed."
    note_preview: 'This is a preview. Nothing has been applied to your documents yet.',
  });
}

// ───────────────────────────────────────────────────────────────── write ──

/**
 * Set the brand.
 *
 * Derivation happens here, once, and the result is stored. Validation problems
 * come back as a 400 with the problems attached rather than a silently-corrected
 * brand, because the two refusals this can produce — a near-white accent and an
 * unacknowledged typeface licence — both need a decision from a person.
 */
export function setBrand(ctx, orgId, input = {}) {
  return usage.around(ctx, orgId, 'BRAND_SET', () => doSetBrand(ctx, orgId, input));
}

function doSetBrand(ctx, orgId, input = {}) {
  // Owner, not editor. This changes every document the company will send from
  // here on, including ones other people are mid-way through preparing, and it
  // is set roughly once in the product's life. An editor can preview freely.
  authorise(membershipOf(ctx, orgId), 'own');
  // Setting a brand is a write. Documents already generated in it keep it.
  requireEntitlement(ctx, orgId, 'CUSTOM_BRAND');
  const supplied = pickSupplied(input);

  // Derived, not stored raw: `deriveBrand` throws with the problems attached if
  // the input cannot produce a legible document.
  const derived = deriveBrand(supplied);

  const logoAssetId = input.logo_asset_id ?? null;
  if (logoAssetId) assertLogoUsable(ctx, orgId, logoAssetId);

  const existing = ctx.db.findOne('brand_profile', { org_id: orgId });
  const fields = {
    org_id: orgId,
    supplied: JSON.stringify(supplied),
    derived: JSON.stringify(derived),
    adjustments: JSON.stringify(derived.adjustments),
    logo_asset_id: logoAssetId,
    typeface: supplied.typeface ?? null,
    typeface_licence_ack: supplied.typeface_licence_ack ? 1 : 0,
    created_by: ctx.auth.userId,
    created_at: ctx.now(),
  };

  const row = existing
    ? ctx.db.update('brand_profile', existing.id, fields)
    : ctx.db.insert('brand_profile', fields);

  audit(ctx, orgId, existing ? 'brand.updated' : 'brand.set', 'brand_profile', row.id, {
    accent: supplied.accent ?? null,
    accent_text: derived.tokens.accent_text,
    adjustments: derived.adjustments.map((a) => a.token),
    greyscale_separation: derived.contrast.greyscale_separation,
  });

  return ok({
    source: 'CUSTOM',
    supplied,
    ...derived,
    logo: logoAssetId ? logoSummary(ctx, orgId, logoAssetId) : null,
    // Documents already generated are not retrospectively restyled. Reissuing a
    // document an investor has already seen, in different colours, under the
    // same name, is a worse outcome than an inconsistent set of old PDFs.
    applies_to: 'Documents generated from now on. Anything already generated keeps the colours it was '
              + 'generated with — regenerate it if you want the new ones.',
  });
}

/**
 * Attach a logo.
 *
 * Reuses the Phase 5 asset gate rather than a second set of rules, so a logo
 * that would print at 94 DPI is refused here for the same reason, with the same
 * wording, as one placed on a cover by hand.
 */
function assertLogoUsable(ctx, orgId, assetId) {
  const asset = ctx.db.get('brand_asset', assetId);
  // Non-member and non-existent are the same answer. A 403 here would confirm
  // that an asset id exists in some other organisation.
  if (!asset || asset.org_id !== orgId) {
    throw new BrandError('logo_not_found', 'no such asset', 404);
  }
  if (asset.asset_role !== 'LOGO') {
    throw new BrandError('not_a_logo',
      `That asset is recorded as ${asset.asset_role}, not a logo.`, 400);
  }

  // The widest a logo is ever placed by `defaultPlacement`. Checking at the
  // largest placement means a logo accepted here is usable everywhere, rather
  // than passing at 20mm on a slide and printing soft on an A4 cover.
  const problems = placementProblems(asset, { widthMm: 48 })
    .filter((p) => p.code !== 'aspect_mismatch');
  if (problems.length) {
    throw new BrandError('logo_quality', problems[0].problem ?? 'This logo would print badly.', 400,
      { problems });
  }
  return asset;
}

export function setLogo(ctx, orgId, assetId) {
  authorise(membershipOf(ctx, orgId), 'own');
  assertLogoUsable(ctx, orgId, assetId);

  const existing = ctx.db.findOne('brand_profile', { org_id: orgId });
  if (!existing) {
    // A logo with no colour profile is a legitimate state — plenty of companies
    // have a logo and no considered palette — so the standard is materialised
    // rather than refusing until colours are set.
    const derived = standardBrand();
    const row = ctx.db.insert('brand_profile', {
      org_id: orgId,
      supplied: JSON.stringify({ accent: RAISEROOM_STANDARD.accent }),
      derived: JSON.stringify(derived),
      adjustments: JSON.stringify(derived.adjustments),
      logo_asset_id: assetId,
      typeface: null, typeface_licence_ack: 0,
      created_by: ctx.auth.userId, created_at: ctx.now(),
    });
    audit(ctx, orgId, 'brand.logo_set', 'brand_profile', row.id, { asset_id: assetId });
    return ok({ logo: logoSummary(ctx, orgId, assetId), source: 'STANDARD_WITH_LOGO' });
  }

  const row = ctx.db.update('brand_profile', existing.id, { logo_asset_id: assetId });
  audit(ctx, orgId, 'brand.logo_set', 'brand_profile', row.id, { asset_id: assetId });
  return ok({ logo: logoSummary(ctx, orgId, assetId), source: 'CUSTOM' });
}

/**
 * Back to the standard.
 *
 * Deletes the profile rather than writing the standard into it, so "reset" and
 * "deliberately chose the RaiseRoom colours" stay distinguishable — the second
 * should survive a later change to the standard, and the first should not.
 */
export function resetBrand(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'own');
  const existing = ctx.db.findOne('brand_profile', { org_id: orgId });
  if (existing) {
    ctx.db.remove('brand_profile', existing.id);
    audit(ctx, orgId, 'brand.reset', 'brand_profile', existing.id, {
      supplied: parseJson(existing.supplied, {}),
    });
  }
  return ok({ source: 'STANDARD', ...standardBrand(), reset: Boolean(existing) });
}

// ─────────────────────────────────────────────────────────────── report ──

/**
 * What a brand costs in legibility, stated plainly.
 *
 * Used by the UI and by anyone asking whether to keep their own colours. The
 * honest answer is sometimes "the standard reads better", and a product that
 * cannot say so is flattering the user at the expense of the document.
 */
export function brandReport(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const current = getBrand(ctx, orgId).body;
  const tokens = current.tokens ?? {};
  const palette = (current.palette ?? []).map((p) => (typeof p === 'string' ? { hex: p } : p));

  const findings = [];
  const ratio = contrastRatio(tokens.accent, tokens.page ?? '#FFFFFF');
  if (ratio !== null && ratio < CONTRAST_FLOOR.bodyText) {
    findings.push({
      code: 'accent_needs_darkening',
      finding: `Your accent reads at ${ratio}:1 on the page, so a darker version of it is used for `
             + 'small text. Both are on your documents: the original for fills, the darker one for labels.',
    });
  }

  const separation = palette.length ? greyscaleSeparation(palette) : null;
  if (separation !== null && separation < MIN_GREYSCALE_SEPARATION) {
    findings.push({
      code: 'palette_prints_flat',
      finding: 'Two of your chart colours are close enough in brightness that a black-and-white printer '
             + 'will render them as the same grey. Charts carry series labels as well as colour, so '
             + 'nothing becomes unreadable, but the colour stops helping.',
    });
  }

  return ok({
    source: current.source,
    tokens,
    adjustments: current.adjustments ?? [],
    findings,
    greyscale_separation: separation,
    standard_available: current.source !== 'STANDARD',
  });
}
