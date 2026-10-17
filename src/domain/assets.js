/**
 * Image quality rules.
 *
 * A deck is judged in the first four seconds, and nothing loses those four
 * seconds faster than a logo that has been scaled up from a 200-pixel PNG
 * someone pulled off a website. The company looks careless about its own brand,
 * which a reader generalises.
 *
 * So resolution is checked at the point of PLACEMENT, not at upload. A 600-pixel
 * image is fine at thumbnail size and unusable across half a slide, and only the
 * placement knows which it is. The check refuses rather than warns: an artifact
 * that will not generate until the logo is replaced is a nuisance for an hour,
 * and a blurry logo in front of an investor is a different kind of problem.
 */

export class AssetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const ASSET_ROLES = Object.freeze([
  'LOGO', 'PRODUCT_SHOT', 'PORTRAIT', 'DIAGRAM', 'SCREENSHOT', 'OTHER',
]);

/**
 * Minimum effective resolution, in dots per inch at final printed size.
 *
 * 300 is the long-standing print standard and is what a logo on a cover needs.
 * 200 is the floor for photographic content, where detail hides softness. A
 * screenshot is exempt from the upper standard because screen pixels are what
 * it is — demanding 300 dpi of a UI capture produces an upscaled blur that is
 * worse than the original.
 */
export const MIN_DPI = Object.freeze({
  LOGO: 300,
  DIAGRAM: 300,
  PRODUCT_SHOT: 220,
  PORTRAIT: 220,
  SCREENSHOT: 144,
  OTHER: 200,
});

/** Vector assets have no resolution and are always acceptable. */
export const VECTOR_MIME = Object.freeze(['image/svg+xml', 'application/pdf']);

const MM_PER_INCH = 25.4;

/**
 * Effective DPI of an image placed at a given physical width.
 *
 * @param {number} pixelWidth   the image's own pixel width
 * @param {number} placedWidthMm  how wide it will be on the page
 */
export function effectiveDpi(pixelWidth, placedWidthMm) {
  const px = Number(pixelWidth);
  const mm = Number(placedWidthMm);
  if (!Number.isFinite(px) || !Number.isFinite(mm) || mm <= 0) return null;
  return (px / mm) * MM_PER_INCH;
}

/** The pixel width an asset needs to be placed this wide. */
export function requiredPixels(role, placedWidthMm) {
  const dpi = MIN_DPI[role] ?? MIN_DPI.OTHER;
  return Math.ceil((Number(placedWidthMm) / MM_PER_INCH) * dpi);
}

/**
 * Can this asset be placed here?
 *
 * @param {object} asset  { asset_role, mime_type, pixel_width, pixel_height, is_vector, filename }
 * @param {object} placement  { widthMm, heightMm }
 */
export function placementProblems(asset = {}, placement = {}) {
  const problems = [];
  const role = ASSET_ROLES.includes(asset.asset_role) ? asset.asset_role : 'OTHER';

  if (asset.is_vector || VECTOR_MIME.includes(asset.mime_type)) return problems;

  const widthMm = Number(placement.widthMm);
  if (!Number.isFinite(widthMm) || widthMm <= 0) {
    problems.push({ code: 'no_placement_size', problem: 'the placement has no width, so quality cannot be judged' });
    return problems;
  }

  if (!Number.isFinite(Number(asset.pixel_width))) {
    // Unknown dimensions are refused rather than assumed adequate. An asset
    // whose size nobody measured is exactly the one that turns out to be 180px.
    problems.push({
      code: 'unknown_dimensions',
      problem: `The pixel dimensions of ${asset.filename ?? 'this image'} were never recorded, so its `
             + 'quality at this size cannot be checked. Re-upload it.',
    });
    return problems;
  }

  const dpi = effectiveDpi(asset.pixel_width, widthMm);
  const floor = MIN_DPI[role] ?? MIN_DPI.OTHER;

  if (dpi < floor) {
    const need = requiredPixels(role, widthMm);
    problems.push({
      code: 'below_minimum_resolution',
      problem: `${asset.filename ?? 'This image'} would print at ${Math.round(dpi)} dpi at this size, `
             + `below the ${floor} dpi floor for a ${role.toLowerCase().replace('_', ' ')}. `
             + `It needs to be at least ${need}px wide, or placed smaller than `
             + `${Math.floor((asset.pixel_width / floor) * MM_PER_INCH)}mm.`,
      effective_dpi: Math.round(dpi),
      required_dpi: floor,
      required_pixels: need,
    });
  }

  // An aspect mismatch means the placement will crop or stretch. Stretching a
  // logo is the one thing a brand guideline always forbids, and it is
  // detectable here rather than in the printed deck.
  if (placement.heightMm && asset.pixel_height) {
    const assetAspect = Number(asset.pixel_width) / Number(asset.pixel_height);
    const placeAspect = widthMm / Number(placement.heightMm);
    if (Number.isFinite(assetAspect) && Number.isFinite(placeAspect)
        && Math.abs(assetAspect - placeAspect) / placeAspect > 0.02) {
      problems.push({
        code: 'aspect_mismatch',
        problem: `${asset.filename ?? 'This image'} is ${assetAspect.toFixed(2)}:1 but the space is `
               + `${placeAspect.toFixed(2)}:1. Fit it inside the box rather than stretching it.`,
        asset_aspect: Number(assetAspect.toFixed(3)),
        placement_aspect: Number(placeAspect.toFixed(3)),
      });
    }
  }

  return problems;
}

/** Throw on any blocking problem. Used by the generation gate. */
export function assertPlaceable(asset, placement) {
  const problems = placementProblems(asset, placement);
  const blocking = problems.filter((p) => p.code !== 'aspect_mismatch');
  if (blocking.length) {
    throw new AssetError(blocking[0].code, blocking[0].problem);
  }
  return problems;
}

/**
 * Advice for an asset that is not good enough, rather than a bare refusal.
 * The user needs to know what to go and get.
 */
export function upgradeAdvice(asset = {}, placement = {}) {
  const role = ASSET_ROLES.includes(asset.asset_role) ? asset.asset_role : 'OTHER';
  const need = requiredPixels(role, placement.widthMm ?? 0);
  if (role === 'LOGO') {
    return `Ask whoever holds your brand files for the vector original — an SVG, EPS or PDF. A vector logo `
         + `has no resolution to be wrong, and it is the one asset that is always available somewhere.`;
  }
  return `Supply a version at least ${need}px wide, or place this one smaller.`;
}
