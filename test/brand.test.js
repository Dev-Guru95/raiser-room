/**
 * Phase 9 — brand.
 *
 * The thing worth testing here is not that colours get stored. It is that a
 * founder's colour choice cannot produce an unreadable document, and that a
 * derivation which drifts out of spec fails here rather than in a deck.
 *
 * The one failure these tests exist for, specifically: a palette that looks
 * fine on screen and prints as four identical greys. It is invisible in every
 * check except a deliberate one, and by the time anyone notices, the paper is
 * in a room with investors in it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal , onPlan } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as api from '../src/api/brand.js';
import * as artifacts from '../src/api/artifacts.js';
import {
  parseHex, toHex, rgbToHsl, hslToRgb, relativeLuminance, contrastRatio,
  atLuminance, derivePalette, greyscaleSeparation, ensureContrast,
  deriveBrand, standardBrand, validateBrand,
  CONTRAST_FLOOR, MIN_GREYSCALE_SEPARATION, RAISEROOM_STANDARD,
} from '../src/domain/brand.js';
import { withPalette, seriesColour, accentColour, activeBrand, SERIES } from '../src/render/theme.js';
import { tokensCss } from '../src/render/document.js';
import { barChart } from '../src/render/charts.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  onPlan(db, org.id, 'FIRM');
  return { db, ctx, org };
}

/**
 * Accents chosen to cover the cases that break naive derivations.
 *
 * The mint is the one that mattered: it produced 0.014 greyscale separation
 * against a 0.08 floor under the first implementation, because that walked HSL
 * lightness and HSL lightness has almost nothing to do with how dark a colour
 * prints.
 */
const ACCENTS = Object.freeze([
  { hex: '#7E3FF2', note: 'the standard' },
  { hex: '#A8E6CF', note: 'pale mint — the one that broke the first derivation' },
  { hex: '#0B5FA5', note: 'a corporate blue' },
  { hex: '#F2C94C', note: 'a yellow, where luminance and lightness diverge most' },
  { hex: '#D93025', note: 'a saturated red' },
  { hex: '#1A1A1A', note: 'near-black, with almost no room to darken' },
  { hex: '#FF00FF', note: 'fully saturated magenta' },
  { hex: '#808080', note: 'a grey, which has no hue to derive from' },
]);

// ─────────────────────────────────────────────────────────── colour maths ──

test('hex parsing accepts both forms and refuses everything else', () => {
  assert.deepEqual(parseHex('#7E3FF2'), { r: 0x7E, g: 0x3F, b: 0xF2 });
  assert.deepEqual(parseHex('7e3ff2'), { r: 0x7E, g: 0x3F, b: 0xF2 });
  assert.deepEqual(parseHex('#FFF'), { r: 255, g: 255, b: 255 });
  for (const bad of ['', null, undefined, '#12345', 'purple', '#GGGGGG', '#7E3FF2A']) {
    assert.equal(parseHex(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('HSL conversion round-trips within a rounding step', () => {
  for (const { hex } of ACCENTS) {
    const back = toHex(hslToRgb(rgbToHsl(parseHex(hex))));
    const a = parseHex(hex);
    const b = parseHex(back);
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(Math.abs(a[ch] - b[ch]) <= 1, `${hex} -> ${back} drifted on ${ch}`);
    }
  }
});

test('luminance and contrast match the WCAG reference values', () => {
  // The two anchors of the scale. If these move, every floor in the file means
  // something different from what its comment claims.
  assert.equal(Math.round(relativeLuminance('#FFFFFF') * 1000) / 1000, 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(contrastRatio('#FFFFFF', '#000000'), 21);
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  // Order must not matter — the ratio is of the lighter to the darker.
  assert.equal(contrastRatio('#7E3FF2', '#FFFFFF'), contrastRatio('#FFFFFF', '#7E3FF2'));
});

test('atLuminance hits its target for every hue, which HSL lightness does not', () => {
  for (const target of [0.03, 0.08, 0.18, 0.32, 0.58, 0.9]) {
    for (const h of [0, 60, 120, 180, 240, 300]) {
      const hex = atLuminance(h, 0.6, target);
      const got = relativeLuminance(hex);
      assert.ok(Math.abs(got - target) < 0.01,
        `hue ${h} at target ${target} came out at ${got.toFixed(4)} (${hex})`);
    }
  }
});

test('REGRESSION: HSL lightness does not control luminance, which is why the ladder is in luminance', () => {
  // The diagnosis behind the rewrite, kept as a test so nobody reintroduces an
  // HSL ladder on the reasonable-sounding grounds that lightness is lightness.
  const yellow = toHex(hslToRgb({ h: 55, s: 0.85, l: 0.5 }));
  const blue = toHex(hslToRgb({ h: 240, s: 0.85, l: 0.5 }));
  const ratio = relativeLuminance(yellow) / relativeLuminance(blue);
  assert.ok(ratio > 4,
    `two colours at identical HSL lightness differ by ${ratio.toFixed(1)}x in luminance; `
    + 'a ladder in lightness therefore controls nothing');
});

test('ensureContrast reaches the floor while keeping the colour recognisable', () => {
  const result = ensureContrast('#A8E6CF', '#FFFFFF', CONTRAST_FLOOR.bodyText);
  assert.ok(result, 'a mint should have a darker readable version');
  assert.ok(result.adjusted);
  assert.ok(contrastRatio(result.hex, '#FFFFFF') >= CONTRAST_FLOOR.bodyText);

  // Same hue family. A "legible version of your brand" that comes back a
  // different colour is not what was promised.
  const before = rgbToHsl(parseHex('#A8E6CF')).h;
  const after = rgbToHsl(parseHex(result.hex)).h;
  assert.ok(Math.abs(before - after) < 12, `hue moved from ${before} to ${after}`);
});

test('ensureContrast leaves a colour alone when it already clears the floor', () => {
  const result = ensureContrast('#0B5FA5', '#FFFFFF', CONTRAST_FLOOR.bodyText);
  assert.equal(result.adjusted, false);
  assert.equal(result.steps, 0);
});

// ────────────────────────────────────────────────────── palette derivation ──

test('every derived palette prints legibly in black and white', () => {
  for (const { hex, note } of ACCENTS) {
    const palette = derivePalette(hex);
    const separation = greyscaleSeparation(palette);
    assert.ok(separation >= MIN_GREYSCALE_SEPARATION,
      `${hex} (${note}) separated by only ${separation}, below ${MIN_GREYSCALE_SEPARATION}`);
  }
});

test('PROPERTY: no accent anywhere in the colour space derives a palette that prints flat', () => {
  // This replaced a fixed-saturation fallback in `deriveBrand` that existed for
  // exactly this failure and could never run: a full sweep found no accent the
  // ladder handles badly. A branch nobody can reach guarantees nothing, so the
  // guarantee lives here, checked against thousands of colours on every run.
  const failures = [];
  let swept = 0;

  for (let h = 0; h < 360; h += 11) {
    for (let sat = 0; sat <= 1.001; sat += 0.125) {
      for (let light = 0.08; light <= 0.92; light += 0.12) {
        const hex = toHex(hslToRgb({ h, s: sat, l: light }));
        // Near-white is refused upstream by `validateBrand`, so it is not a
        // case this has to handle.
        if (relativeLuminance(hex) > 0.92) continue;
        swept++;
        const separation = greyscaleSeparation(derivePalette(hex));
        if (separation < MIN_GREYSCALE_SEPARATION) failures.push({ hex, separation });
      }
    }
  }

  assert.ok(swept > 2000, `only ${swept} accents swept; the property is barely being tested`);
  assert.deepEqual(failures.slice(0, 5), [],
    `${failures.length} of ${swept} accents derive a palette that prints as flat grey`);
});

test('a derived palette leads with the brand colour', () => {
  const palette = derivePalette('#0B5FA5');
  assert.equal(palette[0].name, 'brand');
  const supplied = rgbToHsl(parseHex('#0B5FA5'));
  const used = rgbToHsl(parseHex(palette[0].hex));
  assert.ok(Math.abs(supplied.h - used.h) < 2, 'the lead colour keeps the brand hue');
});

test('a grey brand still produces a palette that can be told apart', () => {
  // A desaturated brand would derive a palette of greys without the saturation
  // floor, and a chart in eight greys is a chart with no series distinction at
  // all once the legend is off the page.
  const palette = derivePalette('#808080');
  assert.ok(greyscaleSeparation(palette) >= MIN_GREYSCALE_SEPARATION);
  const saturations = palette.slice(1).map((p) => rgbToHsl(parseHex(p.hex)).s);
  assert.ok(Math.min(...saturations) > 0.2, 'derived entries have usable saturation');
});

test('greyscaleSeparation measures ADJACENT pairs, not the overall spread', () => {
  // Two colours that are far apart overall but identical side by side is the
  // failing case, and a min-over-all-pairs measure would pass it.
  const palette = [{ hex: '#000000' }, { hex: '#010101' }, { hex: '#FFFFFF' }];
  assert.ok(greyscaleSeparation(palette) < 0.01);
  assert.equal(greyscaleSeparation([{ hex: '#000000' }]), Infinity);
});

// ───────────────────────────────────────────────────────────── validation ──

test('a near-white accent is refused, because no version of it reads on paper', () => {
  const problems = validateBrand({ accent: '#FEFEFE' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'accent_too_pale');
  expectRefusal(() => deriveBrand({ accent: '#FEFEFE' }), 'invalid_brand', 400);
});

test('a dark page is refused rather than half-implemented', () => {
  const problems = validateBrand({ accent: '#7E3FF2', page: '#101010' });
  assert.equal(problems[0].code, 'dark_page_unsupported');
});

test('a typeface without a licence acknowledgement is refused', () => {
  const problems = validateBrand({ accent: '#7E3FF2', typeface: 'Söhne' });
  assert.equal(problems[0].code, 'licence_not_acknowledged');
  assert.equal(validateBrand({ accent: '#7E3FF2', typeface: 'Söhne', typeface_licence_ack: true }).length, 0);
});

test('malformed colours are named by field rather than refused generically', () => {
  const problems = validateBrand({ accent: '#7E3FF2', primary: 'navy', page: 'bone' });
  assert.deepEqual(problems.map((p) => p.field).sort(), ['page', 'primary']);
});

// ─────────────────────────────────────────────────────────── the derivation ──

test('every supported accent derives tokens that clear every floor', () => {
  for (const { hex, note } of ACCENTS) {
    const brand = deriveBrand({ accent: hex });
    const page = brand.tokens.page;

    assert.ok(contrastRatio(brand.tokens.accent_text, page) >= CONTRAST_FLOOR.bodyText,
      `${hex} (${note}): accent_text fails the body-text floor`);
    assert.ok(contrastRatio(brand.tokens.accent_rule, page) >= CONTRAST_FLOOR.uiElement,
      `${hex} (${note}): accent_rule fails the UI floor`);
    assert.ok(contrastRatio(brand.tokens.ink, brand.tokens.wash) >= CONTRAST_FLOOR.bodyText,
      `${hex} (${note}): body text on the wash fails the body-text floor`);
    assert.ok(brand.contrast.greyscale_separation >= MIN_GREYSCALE_SEPARATION,
      `${hex} (${note}): palette prints flat`);
    assert.equal(brand.tokens.palette.length, 8);
  }
});

test('an adjustment is always explained, never silent', () => {
  const brand = deriveBrand({ accent: '#A8E6CF' });
  assert.ok(brand.adjustments.length > 0, 'a pale mint cannot be used unadjusted');
  for (const adjustment of brand.adjustments) {
    assert.ok(adjustment.token, 'every adjustment names the token it changed');
    assert.ok(adjustment.reason && adjustment.reason.length > 40,
      `adjustment to ${adjustment.token} has no usable reason`);
  }
  // The supplied colour is still what the company is recognised by, so it must
  // survive into the token set rather than being replaced wholesale.
  assert.equal(brand.tokens.accent, '#A8E6CF');
  assert.notEqual(brand.tokens.accent_text, '#A8E6CF');
});

test('a brand needing no help says so instead of inventing an adjustment', () => {
  const brand = deriveBrand({ accent: '#0B5FA5' });
  assert.deepEqual(brand.adjustments, []);
  assert.match(brand.note, /as supplied/);
});

test('the wash derives from the accent rather than staying our purple', () => {
  const ours = standardBrand().tokens.wash;
  const theirs = deriveBrand({ accent: '#0B5FA5' }).tokens.wash;
  assert.notEqual(theirs, ours, 'a blue brand must not get a purple-tinted wash');
  const hue = rgbToHsl(parseHex(theirs)).h;
  assert.ok(Math.abs(hue - rgbToHsl(parseHex('#0B5FA5')).h) < 12);
});

test('the standard arrives in the same shape as a custom brand', () => {
  const standard = standardBrand();
  assert.equal(standard.tokens.accent, RAISEROOM_STANDARD.accent);
  assert.deepEqual(Object.keys(standard).sort(),
    ['adjustments', 'contrast', 'note', 'palette', 'tokens'].sort());
});

// ──────────────────────────────────────────────────── the rendering scope ──

test('the active palette drives chart colours and restores afterwards', () => {
  const brand = deriveBrand({ accent: '#0B5FA5' }).tokens;
  const before = seriesColour(0);
  assert.equal(before, SERIES[0].hex);

  withPalette(brand, () => {
    assert.equal(seriesColour(0), brand.palette[0]);
    assert.equal(accentColour(), brand.accent);
    assert.equal(activeBrand().accent, brand.accent);
  });

  assert.equal(seriesColour(0), before, 'the scope did not restore');
  assert.equal(activeBrand(), null);
  assert.equal(accentColour(), SERIES[0].hex);
});

test('the palette restores even when the render throws mid-document', () => {
  // Without the `finally`, a document that failed halfway would leave one
  // organisation's colours set for whatever rendered next.
  const brand = deriveBrand({ accent: '#D93025' }).tokens;
  assert.throws(() => withPalette(brand, () => { throw new Error('block failed'); }), /block failed/);
  assert.equal(activeBrand(), null);
  assert.equal(seriesColour(0), SERIES[0].hex);
});

test('nesting two different brands is refused rather than silently resolved', () => {
  const a = deriveBrand({ accent: '#0B5FA5' }).tokens;
  const b = deriveBrand({ accent: '#D93025' }).tokens;
  assert.throws(
    () => withPalette(a, () => withPalette(b, () => 'never')),
    /escaped its scope/,
  );
  assert.equal(activeBrand(), null, 'the failed nesting still unwound cleanly');
});

test('nesting the same brand is allowed, since it changes nothing', () => {
  const brand = deriveBrand({ accent: '#0B5FA5' }).tokens;
  const result = withPalette(brand, () => withPalette(brand, () => seriesColour(0)));
  assert.equal(result, brand.palette[0]);
  assert.equal(activeBrand(), null);
});

test('mono output ignores the brand entirely', () => {
  // A black-and-white render is black and white. A brand colour leaking into it
  // defeats the one thing it is for.
  const brand = deriveBrand({ accent: '#D93025' }).tokens;
  withPalette(brand, () => {
    assert.equal(seriesColour(0, { mono: true }), '#1A1A1A');
    assert.notEqual(seriesColour(0, { mono: true }), brand.palette[0]);
  });
});

test('a chart drawn inside the scope contains the brand palette and not ours', () => {
  const brand = deriveBrand({ accent: '#0B5FA5' }).tokens;
  const chart = withPalette(brand, () => barChart({
    categories: ['Q1', 'Q2', 'Q3'],
    series: [{ name: 'Revenue', values: [100, 140, 190] }],
    unit: 'USD',
  }));
  assert.ok(chart.ok);
  assert.ok(chart.svg.includes(brand.palette[0]), 'the brand colour is not in the SVG');
  assert.ok(!chart.svg.toUpperCase().includes('#7E3FF2'),
    'RaiseRoom purple survived into a branded chart');
});

test('the stylesheet carries the brand tokens, and --blade stays ours', () => {
  const brand = deriveBrand({ accent: '#0B5FA5' });
  const css = tokensCss(brand);
  assert.ok(css.includes(`--accent:${brand.tokens.accent}`));
  assert.ok(css.includes(`--accent-text:${brand.tokens.accent_text}`));
  assert.ok(css.includes(`--series-1:${brand.tokens.palette[0]}`));
  // Deliberate: one token name must not mean "our purple" in some documents and
  // "the customer's colour" in others.
  assert.ok(css.includes('--blade:#7E3FF2'));
});

test('tokensCss with no brand produces the standard, so a caller cannot render colourless', () => {
  const css = tokensCss();
  assert.ok(css.includes('--accent:#7E3FF2'));
  assert.ok(css.includes(`--series-1:${SERIES[0].hex}`));
  assert.ok(!css.includes('undefined'), 'a missing token reached the stylesheet');
});

// ───────────────────────────────────────────────────────── the service ──

test('an organisation with no brand still has a usable token set', () => {
  const { ctx, org } = world();
  const res = api.getBrand(ctx, org.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'STANDARD');
  assert.equal(res.body.tokens.accent, RAISEROOM_STANDARD.accent);
  assert.equal(res.body.supplied, null);
});

test('setting a brand stores what was supplied AND what was derived', () => {
  const { ctx, org, db } = world();
  const res = api.setBrand(ctx, org.id, { accent: '#A8E6CF' });
  assert.equal(res.status, 200);

  const row = db.findOne('brand_profile', { org_id: org.id });
  const supplied = JSON.parse(row.supplied);
  const derived = JSON.parse(row.derived);
  assert.equal(supplied.accent, '#A8E6CF', 'intent is recorded exactly as given');
  assert.notEqual(derived.tokens.accent_text, '#A8E6CF', 'output is recorded as derived');
  assert.ok(JSON.parse(row.adjustments).length > 0);
});

test('a stored brand is not re-derived on later renders', () => {
  // The guarantee: a document regenerated next year comes out in the colours
  // that were approved, not in whatever the contrast logic does by then.
  const { ctx, org, db } = world();
  api.setBrand(ctx, org.id, { accent: '#0B5FA5' });

  const row = db.findOne('brand_profile', { org_id: org.id });
  const derived = JSON.parse(row.derived);
  derived.tokens.accent_text = '#123456';
  db.update('brand_profile', row.id, { derived: JSON.stringify(derived) });

  assert.equal(api.brandTokens(ctx, org.id).accent_text, '#123456',
    'brandTokens re-derived instead of reading what was stored');
});

test('a corrupt stored profile falls back to the renderer default, not to undefined colours', () => {
  const { ctx, org, db } = world();
  api.setBrand(ctx, org.id, { accent: '#0B5FA5' });
  const row = db.findOne('brand_profile', { org_id: org.id });
  db.update('brand_profile', row.id, { derived: 'not json' });

  assert.equal(api.brandTokens(ctx, org.id), null);
  assert.ok(!tokensCss(api.brandTokens(ctx, org.id)).includes('undefined'));
});

test('REGRESSION: an org with no brand overrides nothing, so its documents do not change', () => {
  // `brandTokens` first returned `standardBrand().tokens` here, whose palette is
  // DERIVED from the standard accent. That silently swapped the hand-ordered
  // Phase 5 series for eight computed colours in every document belonging to
  // every company that had never touched the brand feature.
  const { ctx, org } = world();
  assert.equal(api.brandTokens(ctx, org.id), null,
    'no brand profile must mean no override at all');
});

test('the standard palette is the proofed one, not a derivation of the standard accent', () => {
  const standard = standardBrand();
  assert.deepEqual(standard.tokens.palette, [...RAISEROOM_STANDARD.palette]);
  assert.notDeepEqual(standard.tokens.palette, derivePalette(RAISEROOM_STANDARD.accent).map((p) => p.hex));
});

test('the standard palette in the domain layer matches the one the renderer uses', () => {
  // Duplicated deliberately — nothing in the domain layer imports the render
  // layer. This is what makes the duplication safe: either side moving fails
  // here rather than drifting until someone compares two PDFs.
  assert.deepEqual([...RAISEROOM_STANDARD.palette], SERIES.map((s) => s.hex));
});

test('setting a brand twice updates the one profile rather than accumulating them', () => {
  const { ctx, org, db } = world();
  api.setBrand(ctx, org.id, { accent: '#0B5FA5' });
  api.setBrand(ctx, org.id, { accent: '#D93025' });
  assert.equal(db.count('brand_profile', { org_id: org.id }), 1);
  assert.equal(api.brandTokens(ctx, org.id).accent, '#D93025');
});

test('preview changes nothing', () => {
  const { ctx, org, db } = world();
  const res = api.previewBrand(ctx, org.id, { accent: '#A8E6CF' });
  assert.equal(res.body.ok, true);
  assert.ok(res.body.adjustments.length);
  assert.match(res.body.note_preview, /Nothing has been applied/);
  assert.equal(db.findOne('brand_profile', { org_id: org.id }), null);
});

test('preview reports problems instead of throwing, so a colour picker can show them live', () => {
  const { ctx, org } = world();
  const res = api.previewBrand(ctx, org.id, { accent: '#FEFEFE' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.problems[0].code, 'accent_too_pale');
});

test('reset removes the profile rather than writing the standard into it', () => {
  // "Reset to standard" and "deliberately chose our colours" must stay
  // distinguishable: the second should survive a change to the standard.
  const { ctx, org, db } = world();
  api.setBrand(ctx, org.id, { accent: '#0B5FA5' });
  const res = api.resetBrand(ctx, org.id);
  assert.equal(res.body.reset, true);
  assert.equal(db.findOne('brand_profile', { org_id: org.id }), null);
  assert.equal(api.getBrand(ctx, org.id).body.source, 'STANDARD');
});

test('resetting a brand that was never set is not an error', () => {
  const { ctx, org } = world();
  const res = api.resetBrand(ctx, org.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.reset, false);
});

test('an unreadable brand is refused with its problems attached', () => {
  const { ctx, org } = world();
  const err = expectRefusal(() => api.setBrand(ctx, org.id, { accent: '#FEFEFE' }), 'invalid_brand', 400);
  assert.equal(err.problems[0].code, 'accent_too_pale');
});

test('a logo from another organisation is 404, never 403', () => {
  const { ctx, org, db } = world();
  const other = svc.createOrganisation(ctxFor(db, 'u-other'), { name: 'Elsewhere', path: 'RAISE' })
    .body.organisation;
  const asset = db.insert('brand_asset', {
    org_id: other.id, asset_role: 'LOGO', filename: 'logo.svg', mime_type: 'image/svg+xml',
    storage_key: 'k', pixel_width: null, pixel_height: null, is_vector: 1, uploaded_by: 'u-other',
    created_at: ctx.now(),
  });
  // A 403 would confirm the id exists somewhere, which is itself a disclosure.
  expectRefusal(() => api.setLogo(ctx, org.id, asset.id), 'logo_not_found', 404);
});

test('a logo that would print soft is refused at its widest placement', () => {
  const { ctx, org, db } = world();
  const asset = db.insert('brand_asset', {
    org_id: org.id, asset_role: 'LOGO', filename: 'logo.png', mime_type: 'image/png',
    storage_key: 'k', pixel_width: 120, pixel_height: 40, is_vector: 0, uploaded_by: 'u-owner',
    created_at: ctx.now(),
  });
  // Checked at 48mm, the widest a cover places one. Passing at 20mm and
  // printing soft on an A4 cover is the failure this avoids.
  expectRefusal(() => api.setLogo(ctx, org.id, asset.id), 'logo_quality', 400);
});

test('a vector logo is accepted and creates a profile where none existed', () => {
  const { ctx, org, db } = world();
  const asset = db.insert('brand_asset', {
    org_id: org.id, asset_role: 'LOGO', filename: 'logo.svg', mime_type: 'image/svg+xml',
    storage_key: 'k', pixel_width: null, pixel_height: null, is_vector: 1, uploaded_by: 'u-owner',
    created_at: ctx.now(),
  });
  const res = api.setLogo(ctx, org.id, asset.id);
  assert.equal(res.body.source, 'STANDARD_WITH_LOGO');
  assert.equal(res.body.logo.filename, 'logo.svg');
  assert.equal(db.findOne('brand_profile', { org_id: org.id }).logo_asset_id, asset.id);
});

test('an asset recorded as something other than a logo is refused by name', () => {
  const { ctx, org, db } = world();
  const asset = db.insert('brand_asset', {
    org_id: org.id, asset_role: 'PORTRAIT', filename: 'founder.jpg', mime_type: 'image/jpeg',
    storage_key: 'k', pixel_width: 3000, pixel_height: 4000, is_vector: 0, uploaded_by: 'u-owner',
    created_at: ctx.now(),
  });
  const err = expectRefusal(() => api.setLogo(ctx, org.id, asset.id), 'not_a_logo', 400);
  assert.match(err.message, /PORTRAIT/);
});

test('an editor cannot restyle every document the company sends', () => {
  // Owner-only, deliberately. An editor preparing one document should not be
  // able to change the colours of every document the company sends, including
  // ones other people are part-way through. Preview is open to them.
  const { ctx, org, db } = world();
  db.insert('membership', {
    org_id: org.id, user_id: 'u-editor', email: 'e@example.com', role: 'EDITOR',
    created_at: ctx.now(),
  });
  const editor = ctxFor(db, 'u-editor');

  expectRefusal(() => api.setBrand(editor, org.id, { accent: '#0B5FA5' }), 'forbidden', 403);
  expectRefusal(() => api.resetBrand(editor, org.id), 'forbidden', 403);
  assert.equal(api.previewBrand(editor, org.id, { accent: '#0B5FA5' }).body.ok, true);
  assert.equal(api.getBrand(editor, org.id).status, 200);
});

test('a viewer cannot set a brand but can preview one', () => {
  const { ctx, org, db } = world();
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER',
    created_at: ctx.now(),
  });
  const viewer = ctxFor(db, 'u-viewer');
  expectRefusal(() => api.setBrand(viewer, org.id, { accent: '#0B5FA5' }), 'forbidden', 403);
  assert.equal(api.previewBrand(viewer, org.id, { accent: '#0B5FA5' }).body.ok, true);
});

test('a non-member gets 404 from every brand call', () => {
  const { ctx, org, db } = world();
  const stranger = ctxFor(db, 'u-stranger');
  for (const call of [
    () => api.getBrand(stranger, org.id),
    () => api.previewBrand(stranger, org.id, { accent: '#0B5FA5' }),
    () => api.setBrand(stranger, org.id, { accent: '#0B5FA5' }),
    () => api.resetBrand(stranger, org.id),
    () => api.brandReport(stranger, org.id),
  ]) {
    expectRefusal(call, 'not_found', 404);
  }
  void ctx;
});

test('setting a brand is audited with what changed', () => {
  const { ctx, org, db } = world();
  api.setBrand(ctx, org.id, { accent: '#A8E6CF' });
  const entry = db.find('audit_log', { org_id: org.id }).find((e) => e.action === 'brand.set');
  assert.ok(entry, 'no audit entry for setting a brand');
  const metadata = JSON.parse(entry.metadata);
  assert.equal(metadata.accent, '#A8E6CF');
  assert.ok(metadata.adjustments.includes('accent_text'));
});

test('the report is willing to say the standard reads better', () => {
  const { ctx, org } = world();
  api.setBrand(ctx, org.id, { accent: '#A8E6CF' });
  const res = api.brandReport(ctx, org.id);
  assert.equal(res.body.source, 'CUSTOM');
  assert.equal(res.body.standard_available, true);
  assert.ok(res.body.findings.some((f) => f.code === 'accent_needs_darkening'));
});

test('unknown fields in the request body are ignored, not stored', () => {
  const { ctx, org, db } = world();
  api.setBrand(ctx, org.id, { accent: '#0B5FA5', org_id: 'someone-else', id: 'forged' });
  const row = db.findOne('brand_profile', { org_id: org.id });
  assert.equal(row.org_id, org.id);
  assert.equal(JSON.parse(row.supplied).org_id, undefined);
});

// ───────────────────────────────────────────────── end to end, in a document ──

/** An org with enough confirmed facts to generate something. */
function readyOrg() {
  const { ctx, org, db } = world();
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });
  return { ctx, org, db };
}

/**
 * The kind used for the end-to-end tests below.
 *
 * Asserted generable rather than discovered, because the first version of these
 * tests filtered a catalogue listing for a `can_generate` field that listing
 * does not return. Every entry came back undefined, the filter found nothing,
 * and both tests passed without rendering a single document.
 */
const E2E_KIND = 'PITCH_DECK';

test('the end-to-end kind really is generable, so the tests below are not vacuous', () => {
  const { ctx, org } = readyOrg();
  const check = artifacts.checkGenerable(ctx, org.id, E2E_KIND).body;
  assert.equal(check.can_generate, true,
    `${E2E_KIND} is blocked by ${JSON.stringify(check.blockers)}; the tests below would prove nothing`);
});

test('a generated document renders in the brand, with no RaiseRoom purple left in it', () => {
  const { ctx, org } = readyOrg();
  api.setBrand(ctx, org.id, { accent: '#0B5FA5' });
  const tokens = api.brandTokens(ctx, org.id);

  const res = artifacts.generate(ctx, org.id, E2E_KIND);
  const html = res.body.html;
  assert.ok(html, 'no HTML was produced');
  assert.ok(html.includes(`--accent:${tokens.accent}`), 'the document did not pick up the brand');
  assert.ok(html.includes(`--series-1:${tokens.palette[0]}`), 'the chart palette is not the brand\'s');
  // --blade is still declared, deliberately. What must not appear is our purple
  // being USED — as a series colour or an accent mark.
  assert.ok(!html.includes(`--series-1:${SERIES[0].hex}`),
    'the chart palette stayed on the RaiseRoom series');
  assert.ok(!html.includes(`--accent:${SERIES[0].hex}`));
});

test('an unbranded document still renders in the standard, not in nothing', () => {
  const { ctx, org } = readyOrg();
  const html = artifacts.generate(ctx, org.id, E2E_KIND).body.html;
  assert.ok(html.includes(`--series-1:${SERIES[0].hex}`));
  assert.ok(!html.includes('undefined'), 'a missing token reached the document');
});

test('generating leaves no brand set behind it', () => {
  const { ctx, org } = readyOrg();
  api.setBrand(ctx, org.id, { accent: '#D93025' });
  artifacts.generate(ctx, org.id, E2E_KIND);
  assert.equal(activeBrand(), null, 'generation left a brand active for the next request');

  // And the next organisation's document is unaffected by it.
  const other = readyOrg();
  const html = artifacts.generate(other.ctx, other.org.id, E2E_KIND).body.html;
  assert.ok(!html.includes('--accent:#D93025'),
    'one organisation\'s brand bled into another\'s document');
});
