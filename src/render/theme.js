import { formatNumberIn, formatDateIn, formatPeriodIn } from '../domain/locale.js';

/**
 * Design tokens and number formatting for generated artifacts.
 *
 * Everything a reader judges the company on — before they read a word — is set
 * here: the typographic scale, the palette, the spacing rhythm, and how a
 * figure is written. A deck where the numbers are formatted three different ways
 * across four pages reads as carelessness about numbers, which is the one
 * impression a company raising money cannot afford.
 *
 * So formatting is centralised and mechanical. No part of artifact generation
 * writes a number itself; it asks this module.
 */

// ──────────────────────────────────────────────────────────────── brand ──

/**
 * TekAIDA brand colours.
 *
 * BLADE is the page accent. The logo purple is a different value and the two
 * are never interchanged — artwork is not generated here, so the logo colour
 * does not appear in this file at all.
 */
export const BRAND = Object.freeze({
  onyx: '#000000',
  white: '#FFFFFF',
  blade: '#7E3FF2',
  steel: '#B0B0B0',
});

export const INK = Object.freeze({
  primary: '#111111',
  body: '#2A2A2A',
  muted: '#5C5C5C',
  faint: '#8A8A8A',
  rule: '#E3E3E3',
  ruleStrong: '#C9C9C9',
  wash: '#F7F5FF',
  washNeutral: '#F6F6F6',
});

/**
 * The categorical series palette.
 *
 * Ordered so that LUMINANCE ALTERNATES rather than drifting. Data rooms get
 * printed, and they get printed in black and white more often than anyone
 * designing them expects. A palette that is beautiful on screen and renders as
 * four identical greys on a printed page has failed at the only moment that
 * counts, and the failure is invisible until someone is holding the paper.
 *
 * Each entry carries its approximate greyscale value so the ordering can be
 * checked by a test rather than by eye.
 */
export const SERIES = Object.freeze([
  { hex: '#7E3FF2', grey: 0.37, name: 'blade' },
  { hex: '#17202A', grey: 0.11, name: 'ink' },
  { hex: '#59C2C9', grey: 0.69, name: 'teal' },
  { hex: '#3B1E8F', grey: 0.19, name: 'violet-deep' },
  { hex: '#D9A441', grey: 0.68, name: 'amber' },
  { hex: '#8A6A00', grey: 0.42, name: 'amber-deep' },
  { hex: '#B79BF5', grey: 0.65, name: 'violet-light' },
  { hex: '#4A5568', grey: 0.32, name: 'slate' },
]);

/** For documents destined for a black-and-white printer. */
export const SERIES_MONO = Object.freeze([
  { hex: '#1A1A1A', grey: 0.10, name: 'mono-1' },
  { hex: '#6E6E6E', grey: 0.43, name: 'mono-2' },
  { hex: '#A8A8A8', grey: 0.66, name: 'mono-3' },
  { hex: '#4A4A4A', grey: 0.29, name: 'mono-4' },
  { hex: '#CFCFCF', grey: 0.81, name: 'mono-5' },
  { hex: '#888888', grey: 0.53, name: 'mono-6' },
]);

/** Semantic colours. Never the only carrier of meaning — always paired with a label. */
export const SEMANTIC = Object.freeze({
  positive: '#1F7A4D',
  negative: '#A3243B',
  neutral: '#4A5568',
  caution: '#8A6A00',
  subtotal: '#17202A',
});

// ───────────────────────────────────────────────────── the active brand ──

/**
 * The palette a chart drawn RIGHT NOW should use.
 *
 * Charts are pure functions scattered across thirty-odd builders, each calling
 * `seriesColour` with nothing but an index. Threading a palette argument through
 * all of them would work until one builder was missed — and a single missed
 * builder means one chart in RaiseRoom purple inside an otherwise-branded deck,
 * which nobody notices until a client does. So resolution happens here, in the
 * one place every chart already goes through.
 *
 * The cost is module state, which is only safe because artifact generation is
 * fully synchronous: `generate()` builds the entire HTML string before it
 * returns, and the one asynchronous step (Chromium) runs afterwards on a
 * finished string. Two guards keep it that way rather than trusting a comment:
 *
 *   · the scope restores in a `finally`, so a throw mid-document cannot leave
 *     one org's colours set for the next request;
 *   · nesting two DIFFERENT brands throws instead of silently letting the inner
 *     one win, because that combination can only mean a render escaped its
 *     scope and the colours of one company are now being used for another.
 *
 * If a chart builder is ever made asynchronous, it will escape the scope and
 * render in the standard palette — wrong, but wrong in the safe direction, and
 * not another customer's brand.
 */
let active = null;
let depth = 0;

export function withPalette(brand, fn) {
  if (!brand) return fn();
  if (depth > 0 && active && active.accent !== brand.accent) {
    throw new Error(
      'withPalette was nested with a different brand, which means a render escaped its scope. '
      + 'Refusing rather than rendering one organisation\'s document in another\'s colours.',
    );
  }
  const previous = active;
  active = brand;
  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
    active = depth === 0 ? null : previous;
  }
}

/** The brand in force, or the RaiseRoom standard when none is set. */
export const activeBrand = () => active;

/** The accent for marks a chart draws in the brand colour rather than a series colour. */
export const accentColour = () => active?.accent ?? BRAND.blade;

/** Pale tint for chart grounds and tracks. */
export const washColour = () => active?.wash ?? INK.wash;

export const seriesColour = (i, { mono = false } = {}) => {
  if (mono) return SERIES_MONO[i % SERIES_MONO.length].hex;
  const palette = active?.palette?.length ? active.palette : SERIES.map((s) => s.hex);
  return palette[i % palette.length];
};

// ───────────────────────────────────────────────────── the active locale ──

/**
 * The locale a document is being rendered in, for the duration of that render.
 *
 * The same mechanism as `withPalette`, for the same reason and with the same
 * justification. `formatNumber` is called from some thirty places across charts,
 * tables and blocks, each with nothing but a value and a unit. Threading a
 * locale through all of them would work until one was missed — and one missed
 * call is a German deck with a single figure written the English way, which
 * nobody notices until a German reader does.
 *
 * Safe for exactly the same reason: generation is fully synchronous. The scope
 * restores in a `finally` so a document that throws cannot leave one company's
 * locale set for the next request, and nesting two different locales throws
 * rather than letting the inner one win.
 *
 * NOTE WHAT THIS DOES NOT DO. It changes how a stored number is WRITTEN. It
 * never changes the number, and no part of this path goes near a translation
 * model. A figure has one value, in one place, and every locale is a rendering
 * of it.
 */
let activeLocale = null;
let localeDepth = 0;

export function withLocale(code, fn) {
  if (!code) return fn();
  if (localeDepth > 0 && activeLocale && activeLocale !== code) {
    throw new Error(
      'withLocale was nested with a different locale, which means a render escaped its scope. '
      + 'Refusing rather than writing one document in two number formats.',
    );
  }
  const previous = activeLocale;
  activeLocale = code;
  localeDepth += 1;
  try {
    return fn();
  } finally {
    localeDepth -= 1;
    activeLocale = localeDepth === 0 ? null : previous;
  }
}

/** The locale in force, or null when a document is rendering in plain English. */
export const currentLocale = () => activeLocale;

// ────────────────────────────────────────────────────────── typography ──

/**
 * The type stack.
 *
 * Cinzel for display, Lora for body prose, Raleway for interface and chart
 * labels, Source Code Pro for references and identifiers. Figures use Raleway
 * with tabular numerals so columns align — proportional numerals in a financial
 * table are the single most common reason a generated document looks amateur.
 */
export const FONTS = Object.freeze({
  display: "'Cinzel', 'Times New Roman', serif",
  serif: "'Lora', Georgia, serif",
  sans: "'Raleway', 'Helvetica Neue', Arial, sans-serif",
  mono: "'Source Code Pro', 'SFMono-Regular', Consolas, monospace",
});

/** Point sizes, for print. A fourth-based scale; no size is invented at the call site. */
export const TYPE = Object.freeze({
  displayXL: 34, displayL: 26, displayM: 20,
  headingL: 15, headingM: 12.5, headingS: 10.5,
  body: 10, bodyS: 9, caption: 8, micro: 7,
  chartLabel: 8.5, chartAxis: 8, chartValue: 8.5,
});

/** Millimetre rhythm. Everything in a layout is a multiple of these. */
export const SPACE = Object.freeze({
  xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 24,
});

export const PAGE = Object.freeze({
  // 16:9 for slides, A4 portrait for documents. Both in millimetres.
  slide: { width: 297, height: 167, margin: 16 },
  a4: { width: 210, height: 297, margin: 18 },
  a4landscape: { width: 297, height: 210, margin: 16 },
});

// ─────────────────────────────────────────────────────── number format ──

const CURRENCY_SYMBOL = Object.freeze({ USD: '$', GBP: '£', EUR: '€' });

export class FormatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Coerce to a number, or to null. Never to zero.
 *
 * `Number(null)` is 0 and `Number('')` is 0, and that single piece of JavaScript
 * has now produced three separate bugs in this codebase, each one turning
 * "we don't know" into "it is zero":
 *
 *   · an unanswered criterion scored zero and dragged a readiness band down;
 *   · a missing timing sample became a zero-day duration, flattering the median;
 *   · a cohort that had not reached a period yet rendered as 0% retention — a
 *     retention cliff that never happened, printed in a deck.
 *
 * The third got all the way to a rendered PDF. So the coercion lives here once,
 * every numeric path uses it, and `Number()` on possibly-absent data is a bug
 * wherever it appears.
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when a value is genuinely absent, as opposed to zero. */
export const isAbsent = (value) => toNumber(value) === null;

/**
 * Format a figure for display.
 *
 * `compact` renders 4_200_000 as "$4.2m". That is a rounded restatement, so the
 * rounded form is returned alongside the exact value — a caller putting a
 * compact figure on a chart must still be able to show what it was rounded
 * from, and the provenance appendix always prints the exact value.
 */
export function formatNumber(value, { unit = null, compact = false, decimals = null, sign = false } = {}) {
  // A locale in force takes over entirely. The English path below is not a
  // special case of the localised one — it is the original, kept because every
  // existing test and every English document depends on its exact output, and
  // re-expressing it through Intl to save a branch would be a rewrite of the
  // formatting of every document in the product for no gain.
  if (activeLocale) {
    return formatNumberIn(value, activeLocale, { unit, compact, decimals, sign });
  }
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) throw new FormatError('not_a_number', `cannot format ${JSON.stringify(value)}`);

  if (unit === 'percent') {
    const d = decimals ?? percentDecimals([n]);
    return `${withSign(n.toFixed(d), n, sign)}%`;
  }

  const symbol = CURRENCY_SYMBOL[unit] ?? '';

  if (compact) {
    const abs = Math.abs(n);
    const [scale, suffix] = abs >= 1e9 ? [1e9, 'bn'] : abs >= 1e6 ? [1e6, 'm'] : abs >= 1e3 ? [1e3, 'k'] : [1, ''];
    const scaled = n / scale;
    const d = decimals ?? (suffix && Math.abs(scaled) < 100 ? 1 : 0);
    const body = `${symbol}${Math.abs(scaled).toFixed(d)}${suffix}`;
    return n < 0 ? `(${body})` : (sign && n > 0 ? `+${body}` : body);
  }

  const d = decimals ?? (unit && CURRENCY_SYMBOL[unit] ? 0 : 0);
  const body = `${symbol}${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d,
  })}`;

  // Negatives in brackets. Financial convention, and it survives photocopying
  // in a way a minus sign in front of a currency symbol does not.
  return n < 0 ? `(${body})` : (sign && n > 0 ? `+${body}` : body);
}

const withSign = (text, n, sign) => (n < 0 ? `(${text.replace('-', '')})` : (sign && n > 0 ? `+${text}` : text));

/** A date, written the unambiguous way. "03/04/2026" means different months on different continents. */
export function formatDate(iso, { style = 'long' } = {}) {
  if (activeLocale) return formatDateIn(iso, activeLocale, { style });
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const m = months[d.getUTCMonth()];
  if (style === 'short') return `${d.getUTCDate()} ${m.slice(0, 3)} ${d.getUTCFullYear()}`;
  if (style === 'month') return `${m} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}

/** A period, written as a range. */
export function formatPeriod(start, end) {
  if (activeLocale) return formatPeriodIn(start, end, activeLocale);
  if (!start && !end) return '';
  if (start && end) return `${formatDate(start, { style: 'short' })} – ${formatDate(end, { style: 'short' })}`;
  return formatDate(start ?? end, { style: 'short' });
}

/**
 * Decimal places for a set of percentages.
 *
 * A gross margin of 63.9% is a headline figure in an investor deck, and the rule
 * this replaced printed it as "64%" — because percentages took a decimal place
 * only below ten. A tenth of a point of margin is a number people argue about;
 * rounding it away silently is not a formatting preference, it is a different
 * figure.
 *
 * So: a percentage that has a fractional part keeps one place, and a whole one
 * does not. **Decided across the whole set, never per value** — the old rule's
 * real failure was not its threshold but that it chose per figure, which is how
 * an axis came out reading "100% / 75% / 50% / 25% / 0.0%". Whole numbers stay
 * whole; one fractional member gives the whole set its decimal.
 *
 * One place, not two. Percentages here come from figures like margin and
 * retention, where the second decimal is noise and printing it implies a
 * precision the underlying accounts do not have.
 */
export function percentDecimals(values) {
  const clean = values.map(toNumber).filter((v) => v !== null);
  if (!clean.length) return 0;
  // Rounded to one place first: 63.94 and 63.9 should not disagree about
  // whether this set needs a decimal, because they print identically.
  return clean.some((v) => Math.abs(Math.round(v * 10) / 10 - Math.round(v)) > 1e-9) ? 1 : 0;
}

/**
 * Pick ONE compact precision for a whole set of figures.
 *
 * `formatNumber` on its own chooses decimals per value, so a single waterfall
 * came out reading "$420k … +$68.0k … ($42.0k) … $610k" — three figures at zero
 * decimals and two at one, in the same row of labels. Nobody can say why, and it
 * is precisely the kind of detail that makes a reader wonder how carefully the
 * rest of the numbers were handled.
 *
 * Decided once from the largest magnitude in the set, then applied to all.
 */
export function compactDecimalsFor(values) {
  const clean = values.map(toNumber).filter((v) => v !== null).map(Math.abs);
  if (!clean.length) return 0;
  const max = Math.max(...clean);
  return decimalsForScale(scaleOf(max), clean);
}

/** The scale a compact figure is written at: thousands, millions, billions. */
export const scaleOf = (n) => {
  const abs = Math.abs(Number(n) || 0);
  return abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1;
};

/**
 * Decimals for one scale, decided from every value written at that scale.
 *
 * Within a scale, mixed precision is the defect: "$420k … $68.0k" in one row is
 * two figures at the same magnitude written two ways, and nobody can say why.
 *
 * ACROSS scales it is not. "$0 / $500k / $1.0m" is how a person writes an axis;
 * forcing one precision over all of them gives "$0.0 / $500.0k / $1.0m", which
 * is worse than the problem it was meant to fix — and is exactly what a
 * well-meant set-wide rule produced on the first zero-based currency axis it
 * met.
 */
export function decimalsForScale(scale, values) {
  const atScale = values
    .map(toNumber).filter((v) => v !== null).map(Math.abs)
    .filter((v) => scaleOf(v) === scale);
  if (!atScale.length || scale === 1) return 0;
  // The LARGEST at this scale decides. A decimal exists to stop 1.2m collapsing
  // to 1m; once the biggest figure in the bucket is past a hundred, a decimal on
  // any of them is noise.
  return Math.max(...atScale) / scale < 100 ? 1 : 0;
}

/** Decimals for one value, decided from the others written at its scale. */
export const compactDecimalsAt = (value, values) =>
  decimalsForScale(scaleOf(toNumber(value) ?? 0), values);

/**
 * Round a tick value to something a human would have chosen.
 * 1, 2, 2.5 and 5 times a power of ten — the steps axes are read in.
 */
export function niceStep(rough) {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / power;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * power;
}

/** Axis bounds and ticks that land on readable values and always include zero for bars. */
export function niceScale(min, max, { ticks = 5, zeroBased = true } = {}) {
  let lo = Math.min(...[min, zeroBased ? 0 : min].filter(Number.isFinite));
  let hi = Math.max(...[max, zeroBased ? 0 : max].filter(Number.isFinite));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (lo === hi) { hi = lo + 1; }

  const step = niceStep((hi - lo) / Math.max(ticks - 1, 1));
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const out = [];
  // Accumulate by index rather than by repeated addition: 0.1 + 0.1 + 0.1 does
  // not equal 0.3, and an axis labelled 0.30000000000000004 is the kind of
  // detail that makes a reader doubt everything else on the page.
  const count = Math.round((hi - lo) / step);
  for (let i = 0; i <= count; i++) out.push(round12(lo + i * step));

  return { min: lo, max: hi, step, ticks: out };
}

const round12 = (n) => Number(n.toPrecision(12));

/** Escape text for inclusion in SVG or HTML. Called on every piece of user data. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Approximate rendered width of a string, in points.
 *
 * Used for label collision decisions. Deliberately an estimate with a stated
 * error margin rather than a precise measurement, because precise measurement
 * needs a font engine and the decisions it feeds — rotate these labels, drop
 * every other one — only need to be approximately right.
 */
export function textWidth(text, fontSize, { bold = false } = {}) {
  const avg = bold ? 0.58 : 0.52;
  return String(text ?? '').length * fontSize * avg;
}
