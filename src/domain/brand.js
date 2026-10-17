/**
 * Brand — turning what a founder gives you into something legible.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 *
 * A founder choosing brand colours is not a designer. They will hand over the
 * pale mint from their website, and applied literally it produces an eyebrow
 * label nobody can read, a chart palette of four indistinguishable pastels, and
 * a deck that looks worse than the default would have.
 *
 * The naive version of this feature applies what it is given and ships the
 * result. The founder then blames the product, and they are right to: it had
 * every piece of information needed to know the output was unreadable and used
 * none of it.
 *
 * So the brand is an INPUT, not an instruction. What gets rendered is derived
 * from it — a text-safe variant of the accent, a chart palette with separated
 * luminance — and every adjustment is reported, so the user can see what was
 * changed and why rather than wondering if the product got their colour wrong.
 */

export class BrandError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// ─────────────────────────────────────────────────────── colour maths ──

export function parseHex(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export const toHex = ({ r, g, b }) =>
  `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`
    .toUpperCase();

export function rgbToHsl({ r, g, b }) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60) % 360, s, l };
}

export function hslToRgb({ h, s, l }) {
  const hue = ((h % 360) + 360) % 360;
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hk = hue / 360;
  return { r: channel(hk + 1 / 3) * 255, g: channel(hk) * 255, b: channel(hk - 1 / 3) * 255 };
}

/** WCAG relative luminance. The basis for every legibility decision here. */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * Minimum contrast by use.
 *
 * Small text is the hard case and the one founders' accents fail. A colour that
 * works as a chart fill at 40mm wide is unreadable as a 7pt eyebrow label, and
 * the eyebrow is where brand accents are most often used.
 */
export const CONTRAST_FLOOR = Object.freeze({
  bodyText: 4.5,      // WCAG AA, normal size
  largeText: 3.0,     // headings and KPI values
  uiElement: 3.0,     // rules, borders, chart outlines
});

/**
 * Darken (or lighten) a colour until it clears a contrast floor.
 *
 * Hue and saturation are preserved so the result still reads as the company's
 * colour — the point is a legible version of their brand, not a different
 * brand. Returns null when no amount of adjustment gets there, which happens
 * for colours with no room to move.
 */
export function ensureContrast(hex, background, floor, { maxSteps = 100 } = {}) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  if (contrastRatio(hex, background) >= floor) return { hex: toHex(rgb), adjusted: false, steps: 0 };

  const hsl = rgbToHsl(rgb);
  const bgLum = relativeLuminance(background);
  // Move away from the background: darken on light pages, lighten on dark ones.
  const direction = bgLum > 0.5 ? -1 : 1;

  for (let step = 1; step <= maxSteps; step++) {
    const l = Math.max(0, Math.min(1, hsl.l + direction * (step / maxSteps)));
    const candidate = toHex(hslToRgb({ ...hsl, l }));
    if (contrastRatio(candidate, background) >= floor) {
      return { hex: candidate, adjusted: true, steps: step, from: toHex(rgb) };
    }
    if (l === 0 || l === 1) break;
  }
  return null;
}

// ─────────────────────────────────────────────────── palette derivation ──

/**
 * The luminance ladder a derived palette walks.
 *
 * It ALTERNATES rather than drifting, which is the rule Phase 5 established for
 * the standard palette and for the same reason: data rooms get printed, and
 * printed in black and white more often than anyone designing them expects.
 *
 * IN RELATIVE LUMINANCE, NOT HSL LIGHTNESS. The first version of this walked an
 * HSL lightness ladder, which does not control greyscale at all — a yellow and
 * a blue at the same HSL lightness differ by a factor of five in luminance. A
 * mint accent came out with 0.014 separation between adjacent series, meaning
 * four indistinguishable greys on a printed page, which is the exact failure
 * the ladder exists to prevent.
 */
const LUMINANCE_LADDER = Object.freeze([0.18, 0.03, 0.42, 0.08, 0.58, 0.14, 0.32, 0.05]);

/**
 * Find the HSL lightness that puts a hue at a target relative luminance.
 *
 * Binary search, because luminance is not a closed-form function of lightness
 * once gamma correction is involved. Every target in 0..1 is reachable: HSL
 * lightness 0 is black and 1 is white whatever the hue, so the search always
 * converges.
 */
export function atLuminance(h, s, target, { iterations = 24 } = {}) {
  let lo = 0;
  let hi = 1;
  let best = toHex(hslToRgb({ h, s, l: 0.5 }));

  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    best = toHex(hslToRgb({ h, s, l: mid }));
    const lum = relativeLuminance(best);
    if (lum < target) lo = mid; else hi = mid;
  }
  return best;
}

/**
 * Hue rotation between series.
 *
 * Close to the golden angle, which spreads hues about as evenly as anything can
 * without landing repeatedly on the same part of the wheel.
 */
const HUE_STEP = 137.5;

/**
 * Build a chart palette from one brand colour.
 *
 * The first entry stays as close to the supplied colour as legibility allows,
 * because that is the one a user will look for. The rest are derived.
 */
export function derivePalette(brandHex, { count = 8, saturation = null } = {}) {
  const rgb = parseHex(brandHex);
  if (!rgb) throw new BrandError('invalid_colour', `"${brandHex}" is not a colour`);

  const base = rgbToHsl(rgb);
  // A very desaturated brand colour would produce a palette of greys that
  // nobody can tell apart, so saturation has a floor for derived entries.
  const sat = saturation ?? Math.max(base.s, 0.35);

  // The brand colour leads, nudged only if it sits where it would vanish into
  // the page or into the ink.
  const brandHexUsed = atLuminance(
    base.h, base.s,
    Math.min(Math.max(relativeLuminance(brandHex), 0.05), 0.5),
  );
  const palette = [{ hex: brandHexUsed, name: 'brand', grey: relativeLuminance(brandHexUsed) }];

  // Order the remaining targets so each is as far as possible in greyscale from
  // the one before it. Greedy-furthest produces the alternation the ladder is
  // for, and it starts from the brand's own luminance rather than assuming it.
  const remaining = [...LUMINANCE_LADDER];
  let previous = palette[0].grey;

  for (let i = 1; i < count; i++) {
    if (!remaining.length) remaining.push(...LUMINANCE_LADDER);
    let pick = 0;
    for (let j = 1; j < remaining.length; j++) {
      if (Math.abs(remaining[j] - previous) > Math.abs(remaining[pick] - previous)) pick = j;
    }
    const target = remaining.splice(pick, 1)[0];
    const hex = atLuminance(base.h + HUE_STEP * i, sat, target);
    palette.push({ hex, name: `derived-${i}`, grey: null });
    previous = target;
  }

  for (const entry of palette) entry.grey = Math.round(relativeLuminance(entry.hex) * 1000) / 1000;
  return palette;
}

/**
 * The smallest greyscale gap between two ADJACENT series.
 *
 * Adjacent is what matters: series one and two sit beside each other in a
 * legend and in a grouped bar, so those are the two a reader has to tell apart.
 */
export function greyscaleSeparation(palette = []) {
  const greys = palette.map((p) => p.grey ?? relativeLuminance(p.hex));
  let min = Infinity;
  for (let i = 1; i < greys.length; i++) min = Math.min(min, Math.abs(greys[i] - greys[i - 1]));
  return greys.length < 2 ? Infinity : Math.round(min * 1000) / 1000;
}

export const MIN_GREYSCALE_SEPARATION = 0.08;

/**
 * Luminance of the pale wash.
 *
 * High enough that black body text on it still clears the body-text floor, so a
 * callout block is never the one unreadable thing on an otherwise legible page.
 */
const WASH_LUMINANCE = 0.9;

// ──────────────────────────────────────────────────────── the profile ──

/**
 * What the product falls back to, and what many companies are better off with.
 *
 * The palette is the hand-ordered one from Phase 5, NOT a derivation of the
 * accent. Running the standard through `derivePalette` produces a perfectly
 * legal palette that no one has ever looked at, and quietly replaces eight
 * colours that were chosen and visually proofed. It is duplicated from
 * `render/theme.js` rather than imported, because nothing in the domain layer
 * imports the render layer; `test/brand.test.js` asserts the two lists are
 * identical, so a change to either side fails loudly instead of drifting.
 */
export const RAISEROOM_STANDARD = Object.freeze({
  name: 'RaiseRoom standard',
  primary: '#000000',
  accent: '#7E3FF2',
  page: '#FFFFFF',
  ink: '#111111',
  palette: Object.freeze([
    '#7E3FF2', '#17202A', '#59C2C9', '#3B1E8F',
    '#D9A441', '#8A6A00', '#B79BF5', '#4A5568',
  ]),
});

/**
 * Validate what a user supplied, before anything is derived from it.
 *
 * Refuses only the cases where no derivation can help. Everything else is
 * adjusted and reported, because a product that rejects a founder's brand
 * colour outright has picked a fight it does not need to win.
 */
export function validateBrand(input = {}) {
  const problems = [];

  const accent = parseHex(input.accent);
  if (!accent) {
    problems.push({ field: 'accent', problem: 'The accent colour is not a valid hex value.' });
  } else {
    const lum = relativeLuminance(toHex(accent));
    // White, or near enough, has nothing to derive from: every variant of it is
    // either white or a grey that is no longer the brand.
    if (lum > 0.92) {
      problems.push({
        field: 'accent', code: 'accent_too_pale',
        problem: 'This is close to white, so there is no version of it that can be read on a white '
               + 'page. Pick the darker colour from your palette — most brands have one — or use the '
               + 'RaiseRoom standard.',
      });
    }
  }

  if (input.primary !== undefined && input.primary !== null && !parseHex(input.primary)) {
    problems.push({ field: 'primary', problem: 'The primary colour is not a valid hex value.' });
  }

  if (input.page !== undefined && input.page !== null) {
    const page = parseHex(input.page);
    if (!page) {
      problems.push({ field: 'page', problem: 'The page colour is not a valid hex value.' });
    } else if (relativeLuminance(toHex(page)) < 0.5) {
      // A dark page is a different design system, not a colour swap: every
      // chart, rule and shade in this product assumes ink on paper.
      problems.push({
        field: 'page', code: 'dark_page_unsupported',
        problem: 'Documents are designed for a light page. A dark background would need the whole '
               + 'chart and table system rebuilt around it, and a half-converted one looks worse than '
               + 'either.',
      });
    }
  }

  if (input.typeface && !input.typeface_licence_ack) {
    // Not a technical limit. Most web font licences do not permit embedding in
    // a PDF that leaves the company, and a licence breach in a document sent to
    // an investor is a bad place to discover the distinction.
    problems.push({
      field: 'typeface', code: 'licence_not_acknowledged',
      problem: 'Embedding a typeface in a document that leaves your company needs a licence that '
             + 'permits it, and many web font licences do not. Confirm you hold one, or leave this '
             + 'blank to use the standard set.',
    });
  }

  return problems;
}

/**
 * Derive the tokens documents actually render from.
 *
 * Returns the tokens AND the list of adjustments, so the product can show what
 * was changed and why. An unexplained difference between the colour someone
 * supplied and the one on the page reads as a bug.
 */
export function deriveBrand(input = {}, { palette: suppliedPalette = null } = {}) {
  const problems = validateBrand(input);
  if (problems.length) {
    throw new BrandError('invalid_brand', 'this brand cannot be used as supplied', 400, { problems });
  }

  const page = input.page ? toHex(parseHex(input.page)) : RAISEROOM_STANDARD.page;
  const accent = toHex(parseHex(input.accent));
  const primary = input.primary ? toHex(parseHex(input.primary)) : RAISEROOM_STANDARD.primary;
  const adjustments = [];

  // The accent as used for small text. This is the one that fails most often.
  const forText = ensureContrast(accent, page, CONTRAST_FLOOR.bodyText);
  if (!forText) {
    throw new BrandError('accent_unusable',
      'No readable version of this accent exists on a white page.', 400, { problems: [] });
  }
  if (forText.adjusted) {
    adjustments.push({
      token: 'accent_text',
      from: accent, to: forText.hex,
      reason: `Your accent has a contrast ratio of ${contrastRatio(accent, page)}:1 against the page, `
            + `below the ${CONTRAST_FLOOR.bodyText}:1 needed for small text. A darker version of the `
            + 'same colour is used for labels; the original is still used for fills and rules.',
    });
  }

  const forUi = ensureContrast(accent, page, CONTRAST_FLOOR.uiElement);
  if (forUi?.adjusted) {
    adjustments.push({
      token: 'accent_rule',
      from: accent, to: forUi.hex,
      reason: 'Rules and borders were darkened slightly so they remain visible when printed.',
    });
  }

  // The pale tint behind callouts, pills and progress tracks. Derived from the
  // accent rather than fixed, because a purple-tinted wash sitting behind a
  // company's blue deck does not read as a design choice — it reads as a bit of
  // our brand we forgot to take out.
  const accentHsl = rgbToHsl(parseHex(accent));
  const wash = atLuminance(accentHsl.h, Math.min(accentHsl.s, 0.45), WASH_LUMINANCE);

  // A caller may supply the palette outright — the standard does, because its
  // eight colours were chosen rather than computed.
  const palette = suppliedPalette
    ? suppliedPalette.map((hex, i) => ({ hex, name: i === 0 ? 'brand' : `standard-${i}`, grey: null }))
    : derivePalette(accent);
  for (const entry of palette) entry.grey = Math.round(relativeLuminance(entry.hex) * 1000) / 1000;
  const separation = greyscaleSeparation(palette);

  // There was a fixed-saturation fallback here, for a palette that came out too
  // flat to tell apart in print. It was written when the ladder walked HSL
  // lightness, where flat palettes were common. The luminance ladder made it
  // unreachable: a sweep of 45,283 accents across the whole colour space finds
  // none that fail the floor, so the branch could never run and the adjustment
  // it promised the user could never be shown.
  //
  // Deleted rather than left in as reassurance. What replaces it is stronger —
  // `test/brand.test.js` runs that sweep as a property test, so the guarantee is
  // checked against thousands of colours on every run instead of resting on a
  // branch nobody could reach.

  return {
    tokens: {
      page,
      primary,
      accent,                       // fills, chart marks, large shapes
      accent_text: forText.hex,     // small text
      accent_rule: forUi?.hex ?? forText.hex,
      wash,                         // pale tint for callouts and tracks
      ink: RAISEROOM_STANDARD.ink,
      palette: palette.map((p) => p.hex),
    },
    palette,
    adjustments,
    contrast: {
      accent_on_page: contrastRatio(accent, page),
      accent_text_on_page: contrastRatio(forText.hex, page),
      ink_on_wash: contrastRatio(RAISEROOM_STANDARD.ink, wash),
      greyscale_separation: separation,
    },
    // Said plainly, because the difference between what was supplied and what
    // is rendered is otherwise indistinguishable from the product being wrong.
    note: adjustments.length
      ? `${adjustments.length} adjustment${adjustments.length === 1 ? ' was' : 's were'} made so the `
        + 'documents stay readable. Your colour is still what people will recognise; it is used '
        + 'wherever it works, and a darker version is used where it would not.'
      : 'Your colours were used as supplied — they clear the contrast floors without adjustment.',
  };
}

/** The standard, in the same shape, so nothing downstream needs a special case. */
export function standardBrand() {
  return deriveBrand(
    { accent: RAISEROOM_STANDARD.accent, primary: RAISEROOM_STANDARD.primary },
    { palette: [...RAISEROOM_STANDARD.palette] },
  );
}
