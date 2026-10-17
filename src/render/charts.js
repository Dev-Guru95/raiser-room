/**
 * The chart library.
 *
 * Every chart is a pure function returning an SVG string. No canvas, no DOM, no
 * charting library — which means each one is unit-testable, deterministic, and
 * resolution-independent all the way to the printed page. A rasterised chart in
 * a document someone will print at A3 and put on a wall is a refund waiting to
 * happen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO RULES THAT RUN THROUGH ALL OF THEM
 *
 * 1. A chart with nothing to show draws NOTHING. `insufficientData` returns a
 *    stated reason instead of an empty frame with axes. An empty chart in a
 *    deck is worse than no chart: it looks like a mistake, and the reader
 *    cannot tell whether the data is missing or the number is zero.
 *
 * 2. Colour is never the only carrier of meaning. Every series is directly
 *    labelled or legended with its name, every positive/negative distinction
 *    carries a sign or a word, and the palette alternates luminance so it
 *    survives a black-and-white printer. Data rooms get printed.
 */

import {
  INK, SEMANTIC, FONTS, TYPE, seriesColour, accentColour, washColour,
  formatNumber, niceScale, escapeText, textWidth, toNumber, compactDecimalsFor, compactDecimalsAt, percentDecimals,
} from './theme.js';

export class ChartError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Returned instead of a chart when there is not enough data to draw one honestly. */
export function insufficientData(reason, { width = 480, height = 240 } = {}) {
  return {
    ok: false,
    reason,
    svg: '',
    // A caller may render this as a note in the document. It must never be
    // rendered as an empty chart frame.
    placeholder: `<div class="chart-missing" style="width:${width}px"><p>${escapeText(reason)}</p></div>`,
  };
}

const ok = (svg, extra = {}) => ({ ok: true, svg, ...extra });

// ─────────────────────────────────────────────────────────── primitives ──

const n = (v) => Math.round(Number(v) * 100) / 100;

const el = (tag, attrs = {}, children = '') => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${k}="${typeof v === 'number' ? n(v) : escapeText(v)}"`)
    .join(' ');
  return children === null || children === ''
    ? `<${tag}${a ? ` ${a}` : ''}/>`
    : `<${tag}${a ? ` ${a}` : ''}>${children}</${tag}>`;
};

const text = (content, attrs = {}) =>
  el('text', { 'font-family': FONTS.sans, fill: INK.body, ...attrs }, escapeText(content));

/**
 * Chart frame: the plot area inside its margins, plus the title and axis
 * furniture everything else is positioned against.
 */
function frame({ width, height, margin }) {
  const m = { top: 24, right: 16, bottom: 36, left: 56, ...margin };
  return {
    m,
    plot: { x: m.left, y: m.top, w: width - m.left - m.right, h: height - m.top - m.bottom },
    width,
    height,
  };
}

/**
 * Open an SVG at a KNOWN PHYSICAL SIZE.
 *
 * `width="100%"` lets a chart scale to whatever container it lands in, which on
 * a fixed-height slide meant a chart growing until it ran off the bottom of the
 * page and over the footer. A printed chart has a size; it is set here, in
 * millimetres, and the height follows the aspect ratio so nothing is stretched.
 */
const svgOpen = (w, h, title, widthMm = null) => {
  const sizing = widthMm
    ? `width="${n(widthMm)}mm" height="${n((h / w) * widthMm)}mm"`
    : 'width="100%"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" ${sizing} `
    + `role="img" aria-label="${escapeText(title ?? 'chart')}" font-family="${FONTS.sans}">`;
};

/** Horizontal gridlines and the y axis labels. */
function yAxis(f, scale, { unit, compact = true, labelEvery = 1 } = {}) {
  const parts = [];
  // ONE precision for the whole axis, decided from the whole tick set.
  //
  // `formatNumber` chooses decimals per value, and on an axis that produced
  // "100% / 75% / 50% / 25% / 0.0%" — four whole numbers and one with a decimal,
  // because the percent rule gives values under ten an extra place and zero is
  // under ten. It is the same defect `compactDecimalsFor` was written for,
  // reappearing on the axis instead of in a row of labels, and it makes a reader
  // wonder what else was formatted by accident.
  const decimals = axisDecimals(scale.ticks, unit);
  for (const [i, t] of scale.ticks.entries()) {
    // Compact currency ticks take the precision of their OWN scale. An axis
    // running 0 → 2m crosses three of them, and one precision over all of them
    // reads "$0.0 / $500.0k / $1.0m".
    const tickDecimals = unit === 'percent' || !compact
      ? decimals
      : compactDecimalsAt(t, scale.ticks);
    const y = f.plot.y + f.plot.h - ((t - scale.min) / (scale.max - scale.min)) * f.plot.h;
    parts.push(el('line', {
      x1: f.plot.x, x2: f.plot.x + f.plot.w, y1: y, y2: y,
      stroke: t === 0 ? INK.ruleStrong : INK.rule, 'stroke-width': t === 0 ? 0.9 : 0.5,
    }));
    if (i % labelEvery === 0) {
      parts.push(text(formatNumber(t, { unit, compact, decimals: tickDecimals }), {
        x: f.plot.x - 6, y: y + 3, 'text-anchor': 'end',
        'font-size': TYPE.chartAxis, fill: INK.muted,
      }));
    }
  }
  return parts.join('');
}

/**
 * The decimal places a SET of figures shares, whatever the unit.
 *
 * Every place a chart writes more than one number — axis ticks, bar labels,
 * legend shares — goes through this, so a chart cannot write "44.3%" beside
 * "72%" or "$4.2m" beside "$3m". Which rule applies depends on the unit;
 * that one precision applies to the whole set does not.
 */
export function setDecimals(values = [], unit = null) {
  const clean = values.map(toNumber).filter((v) => v !== null);
  if (!clean.length) return undefined;
  return unit === 'percent' ? percentDecimals(clean) : compactDecimalsFor(clean);
}

/**
 * The decimal places every tick on one axis shares.
 *
 * Takes the most any single tick genuinely needs, so an axis stepping in halves
 * still reads 0.5 / 1.0 / 1.5 rather than losing the halves to its whole
 * neighbours — the fix is one precision, not no precision.
 */
export function axisDecimals(ticks = [], unit = null) {
  const clean = ticks.map(toNumber).filter((v) => v !== null);
  if (!clean.length) return undefined;

  return setDecimals(clean, unit);
}

/**
 * Category labels along the x axis, rotated only if they would otherwise
 * collide. Rotating labels that fit is a tell that nobody looked at the output.
 */
function xCategories(f, categories, bandWidth) {
  const widest = Math.max(...categories.map((c) => textWidth(c, TYPE.chartAxis)));
  const rotate = widest > bandWidth - 4;
  return categories.map((c, i) => {
    const cx = f.plot.x + bandWidth * (i + 0.5);
    const y = f.plot.y + f.plot.h + (rotate ? 8 : 14);
    return text(c, {
      x: cx, y, 'text-anchor': rotate ? 'end' : 'middle',
      'font-size': TYPE.chartAxis, fill: INK.muted,
      transform: rotate ? `rotate(-35 ${n(cx)} ${n(y)})` : null,
    });
  }).join('');
}

/** A legend. Drawn only when there is more than one series to tell apart. */
function legend(series, { x, y, mono = false }) {
  if (series.length < 2) return '';
  let cursor = x;
  return series.map((s, i) => {
    const swatch = el('rect', {
      x: cursor, y: y - 6, width: 9, height: 9, rx: 1.5,
      fill: s.colour ?? seriesColour(i, { mono }),
    });
    const label = text(s.name, {
      x: cursor + 13, y: y + 1.5, 'font-size': TYPE.chartLabel, fill: INK.body,
    });
    cursor += 13 + textWidth(s.name, TYPE.chartLabel) + 16;
    return swatch + label;
  }).join('');
}

const axisTitle = (f, label) => (label
  ? text(label, {
    x: f.plot.x, y: f.plot.y - 10, 'font-size': TYPE.chartAxis,
    fill: INK.muted, 'font-weight': 600,
  })
  : '');

// ──────────────────────────────────────────────────────────── bar chart ──

/**
 * Bars, grouped or stacked.
 *
 * @param {object} spec
 *   categories  string[]
 *   series      [{ name, values: number[], colour? }]
 *   unit, title, stacked, horizontal, valueLabels, mono
 */
export function barChart(spec = {}) {
  const {
    categories = [], series = [], unit = null, axisLabel = null,
    stacked = false, valueLabels = null, mono = false,
    width = 560, height = 280, title = null, compactAxis = true, widthMm = null,
  } = spec;

  if (!categories.length || !series.length) {
    return insufficientData('No data to chart yet.', { width, height });
  }
  for (const s of series) {
    if (!Array.isArray(s.values) || s.values.length !== categories.length) {
      throw new ChartError('series_length_mismatch',
        `series "${s.name}" has ${s.values?.length ?? 0} values for ${categories.length} categories`);
    }
  }

  const f = frame({ width, height, margin: { bottom: series.length > 1 ? 50 : 36 } });

  const totals = categories.map((_, i) => series.reduce((sum, s) => sum + (Number(s.values[i]) || 0), 0));
  const flat = series.flatMap((s) => s.values.map(Number)).filter(Number.isFinite);
  const scale = niceScale(
    stacked ? 0 : Math.min(...flat, 0),
    stacked ? Math.max(...totals) : Math.max(...flat),
    { ticks: 5 },
  );

  const band = f.plot.w / categories.length;
  const groupPad = Math.min(band * 0.18, 12);
  const inner = band - groupPad * 2;
  // Capped: four categories across a wide frame otherwise produce slabs, which
  // read as a design with nothing in it rather than as data.
  const MAX_BAR = 64;
  const rawBarW = stacked ? inner : inner / series.length;
  const barW = Math.min(rawBarW, stacked ? MAX_BAR : MAX_BAR);
  const barInset = (rawBarW - barW) / 2;

  const yOf = (v) => f.plot.y + f.plot.h - ((v - scale.min) / (scale.max - scale.min)) * f.plot.h;

  // Auto: label values when there is room, which is the single biggest
  // readability win on a chart someone will read across a meeting table.
  const showValues = valueLabels ?? (categories.length * series.length <= 12);
  const labelDecimals = setDecimals(flat, unit);

  const bars = [];
  categories.forEach((_, i) => {
    let stackTop = 0;
    series.forEach((s, j) => {
      const v = Number(s.values[i]);
      if (!Number.isFinite(v)) return;
      const colour = s.colour ?? seriesColour(j, { mono });

      const groupW = stacked ? barW : barW * series.length;
      const groupLeft = f.plot.x + band * i + (band - groupW) / 2;
      const x = stacked ? groupLeft : groupLeft + barW * j;

      const yTop = stacked ? yOf(stackTop + v) : yOf(Math.max(v, 0));
      const yBase = stacked ? yOf(stackTop) : yOf(0);
      const h = Math.abs(yBase - yTop);
      if (stacked) stackTop += v;

      bars.push(el('rect', {
        x, y: Math.min(yTop, yBase), width: barW, height: Math.max(h, 0.5),
        fill: colour, rx: 1.5,
      }));

      // Inside a stacked segment the label needs real headroom, not just more
      // pixels than the glyph: a value crammed against a segment boundary reads
      // as belonging to the neighbouring band.
      const room = stacked ? h > TYPE.chartValue * 2.1 : h > 11;
      if (showValues && room) {
        // Per value for compact currency, for the same reason as the axis: a
        // chart whose bars span scales writes each at its own precision.
        const label = formatNumber(v, {
          unit, compact: true,
          decimals: unit === 'percent' ? labelDecimals : compactDecimalsAt(v, flat),
        });
        bars.push(text(label, {
          x: x + barW / 2,
          y: stacked ? Math.min(yTop, yBase) + h / 2 + 3 : Math.min(yTop, yBase) - 4,
          'text-anchor': 'middle', 'font-size': TYPE.chartValue,
          fill: stacked ? contrastOn(colour) : INK.primary, 'font-weight': 600,
        }));
      }
    });
  });

  const body = [
    axisTitle(f, axisLabel ?? (unit ? unitLabel(unit) : null)),
    yAxis(f, scale, { unit, compact: compactAxis }),
    bars.join(''),
    xCategories(f, categories, band),
    legend(series, { x: f.plot.x, y: f.height - 8, mono }),
  ].join('');

  return ok(`${svgOpen(width, height, title ?? 'bar chart', widthMm)}${body}</svg>`, { scale });
}

/**
 * Readable text colour for a filled shape.
 *
 * Relative luminance, not a hue guess: white on the amber in this palette is
 * unreadable at 8.5pt, and a label nobody can read is worse than no label
 * because it still occupies the space one would have gone in.
 */
export function contrastOn(hex) {
  const m = String(hex).replace('#', '');
  if (m.length !== 6) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Threshold set from the actual palette rather than from a rule of thumb:
  // the teal, amber and light violet all sit near 0.40–0.45 and need dark text,
  // while blade purple, ink, slate and the deep tones sit below 0.16 and need
  // white. 0.30 separates them with room on both sides.
  return L > 0.30 ? INK.primary : '#FFFFFF';
}

const unitLabel = (unit) => ({ USD: 'USD', GBP: 'GBP', EUR: 'EUR', percent: '%', count: 'count' }[unit] ?? unit);

// ─────────────────────────────────────────────────────────── line chart ──

export function lineChart(spec = {}) {
  const {
    categories = [], series = [], unit = null, axisLabel = null, mono = false,
    width = 560, height = 280, title = null, markers = true, area = false,
    zeroBased = false, widthMm = null,
  } = spec;

  if (categories.length < 2 || !series.length) {
    return insufficientData('A trend needs at least two periods of data.', { width, height });
  }

  const f = frame({ width, height, margin: { bottom: series.length > 1 ? 50 : 36 } });
  const flat = series.flatMap((s) => s.values.map(Number)).filter(Number.isFinite);
  const scale = niceScale(Math.min(...flat), Math.max(...flat), { ticks: 5, zeroBased });

  const step = categories.length > 1 ? f.plot.w / (categories.length - 1) : 0;
  const xOf = (i) => f.plot.x + step * i;
  const yOf = (v) => f.plot.y + f.plot.h - ((v - scale.min) / (scale.max - scale.min)) * f.plot.h;

  const lines = series.map((s, j) => {
    const colour = s.colour ?? seriesColour(j, { mono });
    const points = s.values
      .map((v, i) => (Number.isFinite(Number(v)) ? { x: xOf(i), y: yOf(Number(v)) } : null))
      .filter(Boolean);
    if (points.length < 2) return '';

    const d = points.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join(' ');
    const fill = area
      ? el('path', {
        d: `${d} L${n(points.at(-1).x)} ${n(yOf(scale.min))} L${n(points[0].x)} ${n(yOf(scale.min))} Z`,
        fill: colour, opacity: 0.12,
      })
      : '';

    const dots = markers
      ? points.map((p) => el('circle', { cx: p.x, cy: p.y, r: 2.6, fill: colour,
        stroke: '#FFFFFF', 'stroke-width': 1.2 })).join('')
      : '';

    return fill + el('path', {
      d, fill: 'none', stroke: colour, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }) + dots;
  }).join('');

  const body = [
    axisTitle(f, axisLabel ?? (unit ? unitLabel(unit) : null)),
    yAxis(f, scale, { unit, compact: true }),
    lines,
    // The first and last labels are anchored inward. Centring them hangs half
    // of each over the edge of the plot, where the page trims them.
    categories.map((c, i) => text(c, {
      x: xOf(i), y: f.plot.y + f.plot.h + 14,
      'text-anchor': i === 0 ? 'start' : (i === categories.length - 1 ? 'end' : 'middle'),
      'font-size': TYPE.chartAxis, fill: INK.muted,
    })).join(''),
    legend(series, { x: f.plot.x, y: f.height - 8, mono }),
  ].join('');

  return ok(`${svgOpen(width, height, title ?? 'line chart', widthMm)}${body}</svg>`, { scale });
}

// ────────────────────────────────────────────────────── waterfall chart ──

/**
 * A waterfall. The chart a normalisation bridge has to be.
 *
 * Steps are `{ label, value, kind }` where kind is 'start' | 'delta' | 'subtotal'
 * | 'end'. Start, subtotal and end sit on the baseline; deltas float from the
 * running total. Positive and negative deltas are coloured differently AND
 * signed in their labels, because the whole point of a bridge is being able to
 * see which way each adjustment went without decoding a legend.
 */
export function waterfallChart(spec = {}) {
  const {
    steps = [], unit = null, width = 640, height = 320, title = null,
    axisLabel = null, connectors = true, widthMm = null,
  } = spec;

  if (steps.length < 2) {
    return insufficientData('A bridge needs a starting figure and at least one adjustment.', { width, height });
  }

  const f = frame({ width, height, margin: { bottom: 56, top: 28 } });

  // Resolve each step to its baseline and top, carrying the running total.
  let running = 0;
  const resolved = steps.map((s) => {
    const v = Number(s.value);
    if (!Number.isFinite(v)) throw new ChartError('bad_step', `step "${s.label}" has no numeric value`);
    if (s.kind === 'start') { running = v; return { ...s, from: 0, to: v, value: v }; }
    if (s.kind === 'subtotal' || s.kind === 'end') return { ...s, from: 0, to: running, value: running };
    const from = running; running += v;
    return { ...s, from, to: running, value: v };
  });

  const lows = resolved.flatMap((r) => [r.from, r.to]);
  const scale = niceScale(Math.min(...lows, 0), Math.max(...lows), { ticks: 5 });

  const band = f.plot.w / resolved.length;
  const barW = Math.min(band * 0.62, 56);
  const yOf = (v) => f.plot.y + f.plot.h - ((v - scale.min) / (scale.max - scale.min)) * f.plot.h;

  // One precision for every figure on the chart, chosen from the largest.
  const labelDecimals = setDecimals(resolved.map((r) => r.value), unit);

  const parts = [];
  resolved.forEach((r, i) => {
    const cx = f.plot.x + band * (i + 0.5);
    const x = cx - barW / 2;
    const yTop = yOf(Math.max(r.from, r.to));
    const h = Math.max(Math.abs(yOf(r.from) - yOf(r.to)), 1);

    const colour = r.kind === 'start' || r.kind === 'end' || r.kind === 'subtotal'
      ? SEMANTIC.subtotal
      : (r.value >= 0 ? SEMANTIC.positive : SEMANTIC.negative);

    parts.push(el('rect', { x, y: yTop, width: barW, height: h, fill: colour, rx: 1.5 }));

    // Deltas are signed so direction survives a monochrome print; totals are
    // not, because "+$420k" on a starting figure reads as an increase of
    // $420k rather than a balance of it.
    const isTotal = r.kind !== 'delta';
    parts.push(text(formatNumber(r.value, {
      unit, compact: true, sign: !isTotal,
      decimals: unit === 'percent'
        ? labelDecimals
        : compactDecimalsAt(r.value, resolved.map((x) => x.value)),
    }), {
      x: cx, y: yTop - 5, 'text-anchor': 'middle', 'font-size': TYPE.chartValue,
      'font-weight': 700, fill: INK.primary,
    }));

    const label = String(r.label);
    const lines = wrapLabel(label, barW + band * 0.3, TYPE.chartAxis);
    lines.forEach((line, k) => {
      parts.push(text(line, {
        x: cx, y: f.plot.y + f.plot.h + 14 + k * 9.5, 'text-anchor': 'middle',
        'font-size': TYPE.chartAxis, fill: INK.muted,
        'font-weight': isTotal ? 600 : 400,
      }));
    });

    if (connectors && i < resolved.length - 1 && resolved[i + 1].kind === 'delta') {
      const y = yOf(r.to);
      parts.push(el('line', {
        x1: cx + barW / 2, x2: f.plot.x + band * (i + 1.5) - barW / 2, y1: y, y2: y,
        stroke: INK.ruleStrong, 'stroke-width': 0.7, 'stroke-dasharray': '2 2',
      }));
    }
  });

  const body = [
    axisTitle(f, axisLabel ?? (unit ? unitLabel(unit) : null)),
    yAxis(f, scale, { unit, compact: true }),
    parts.join(''),
  ].join('');

  return ok(`${svgOpen(width, height, title ?? 'waterfall chart', widthMm)}${body}</svg>`, { scale, resolved });
}

/** Greedy wrap for an axis label, measured rather than guessed at by character count. */
function wrapLabel(label, maxWidth, fontSize) {
  const words = String(label).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (textWidth(trial, fontSize) <= maxWidth || !line) line = trial;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

// ───────────────────────────────────────────────────────── donut chart ──

/**
 * A donut, for composition — customer concentration above all.
 *
 * Deliberately not a pie: the hole carries the headline figure, which is what a
 * reader actually wants from a concentration chart. Slices are directly
 * labelled with name and share, because a legend forces a reader to look back
 * and forth and they will stop bothering.
 */
export function donutChart(spec = {}) {
  const {
    slices = [], unit = 'percent', width = 420, height = 300, title = null,
    centreValue = null, centreLabel = null, mono = false, maxSlices = 6, widthMm = null,
  } = spec;

  const clean = slices.filter((s) => Number.isFinite(Number(s.value)) && Number(s.value) > 0);
  if (!clean.length) return insufficientData('No composition data to chart yet.', { width, height });

  // Collapse the tail rather than drawing twenty unreadable slivers.
  const sorted = [...clean].sort((a, b) => Number(b.value) - Number(a.value));
  const head = sorted.slice(0, maxSlices);
  const tail = sorted.slice(maxSlices);
  const shown = tail.length
    ? [...head, { name: `Other (${tail.length})`, value: tail.reduce((s, x) => s + Number(x.value), 0) }]
    : head;

  const total = shown.reduce((s, x) => s + Number(x.value), 0);
  // Decided across every slice AND the centre figure, so the ring and the
  // number in the middle of it agree.
  const shareDecimals = setDecimals([...shown.map((x) => x.value),
    ...(centreValue === null || centreValue === undefined ? [] : [centreValue])], unit);
  const cx = width * 0.33;
  const cy = height / 2;
  const rOuter = Math.min(width * 0.26, height * 0.38);
  const rInner = rOuter * 0.62;

  let angle = -Math.PI / 2;
  const arcs = [];
  const rows = [];

  shown.forEach((s, i) => {
    const share = Number(s.value) / total;
    const sweep = share * Math.PI * 2;
    const colour = s.colour ?? seriesColour(i, { mono });

    arcs.push(el('path', {
      d: annularSector(cx, cy, rInner, rOuter, angle, angle + sweep),
      fill: colour, stroke: '#FFFFFF', 'stroke-width': 1,
    }));

    const y = cy - (shown.length * 15) / 2 + i * 15 + 4;
    rows.push(el('rect', { x: width * 0.58, y: y - 7, width: 9, height: 9, rx: 1.5, fill: colour }));
    rows.push(text(s.name, {
      x: width * 0.58 + 13, y, 'font-size': TYPE.chartLabel, fill: INK.body,
    }));
    rows.push(text(formatNumber(Number(s.value), {
      // One precision across the whole ring. 44% and 44.3% are different
      // conversations when the figure is customer concentration, but a ring
      // mixing the two is just careless.
      unit, compact: unit !== 'percent', decimals: shareDecimals,
    }), {
      x: width - 8, y, 'text-anchor': 'end', 'font-size': TYPE.chartLabel,
      fill: INK.primary, 'font-weight': 600,
    }));

    angle += sweep;
  });

  const centre = centreValue !== null && centreValue !== undefined
    ? text(formatNumber(centreValue, {
      unit, compact: unit !== 'percent', decimals: shareDecimals,
    }), {
      x: cx, y: cy + 2, 'text-anchor': 'middle', 'font-size': 19,
      'font-weight': 700, fill: INK.primary,
    }) + (centreLabel
      ? text(centreLabel, {
        x: cx, y: cy + 15, 'text-anchor': 'middle', 'font-size': TYPE.micro, fill: INK.muted,
      })
      : '')
    : '';

  return ok(`${svgOpen(width, height, title ?? 'composition chart', widthMm)}${arcs.join('')}${centre}${rows.join('')}</svg>`);
}

function annularSector(cx, cy, rIn, rOut, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => `${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}`;
  return `M${p(rOut, a0)} A${n(rOut)} ${n(rOut)} 0 ${large} 1 ${p(rOut, a1)} `
       + `L${p(rIn, a1)} A${n(rIn)} ${n(rIn)} 0 ${large} 0 ${p(rIn, a0)} Z`;
}

// ─────────────────────────────────────────────────────── cohort heatmap ──

/**
 * A cohort retention heatmap. The chart that answers "does revenue stay?".
 *
 * Cells carry their value as text as well as their shade, so the chart is
 * readable in monochrome and so a reader can quote a number off it without
 * squinting at a colour scale.
 */
export function cohortHeatmap(spec = {}) {
  const {
    cohorts = [], periods = [], values = [], unit = 'percent',
    width = 640, height = null, title = null, scaleMax = null, widthMm = null,
  } = spec;

  if (!cohorts.length || !periods.length) {
    return insufficientData('Cohort analysis needs at least one cohort and one period.', { width });
  }
  if (values.length !== cohorts.length) {
    throw new ChartError('cohort_shape_mismatch',
      `${values.length} value rows for ${cohorts.length} cohorts`);
  }

  const labelW = 86;
  const cellH = 22;
  const headerH = 26;
  const cellW = (width - labelW - 8) / periods.length;
  const h = height ?? headerH + cohorts.length * cellH + 10;

  const flat = values.flat().map(Number).filter(Number.isFinite);
  const max = scaleMax ?? Math.max(...flat, 1);
  // One precision across the whole grid. This was a hardcoded zero, which
  // rounded 87.5% retention to 88% — in the chart whose entire purpose is to
  // show small movements between cohorts.
  const cellDecimals = setDecimals(flat, unit);

  const parts = [];
  periods.forEach((p, j) => {
    parts.push(text(p, {
      x: labelW + cellW * (j + 0.5), y: headerH - 9, 'text-anchor': 'middle',
      'font-size': TYPE.chartAxis, fill: INK.muted, 'font-weight': 600,
    }));
  });

  cohorts.forEach((c, i) => {
    const y = headerH + i * cellH;
    parts.push(text(c, {
      x: labelW - 8, y: y + cellH / 2 + 3, 'text-anchor': 'end',
      'font-size': TYPE.chartAxis, fill: INK.body,
    }));

    (values[i] ?? []).forEach((raw, j) => {
      // `Number(null)` is 0, so the old check passed and every not-yet-reached
      // cell printed as 0% in a shaded box — a retention cliff that never
      // happened, in a chart built to answer "does revenue stay?". It rendered
      // all the way to a PDF before anyone looked at it.
      const v = toNumber(raw);
      const x = labelW + cellW * j;
      if (v === null) {
        // An absent cell is left blank with a hairline. A cohort that has not
        // reached that period yet is not a zero, and shading it as one would
        // invent a retention cliff that never happened.
        parts.push(el('rect', {
          x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2,
          fill: '#FFFFFF', stroke: INK.rule, 'stroke-width': 0.5,
        }));
        return;
      }
      const t = Math.max(0, Math.min(1, v / max));
      parts.push(el('rect', {
        x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2,
        fill: shade(t), rx: 1.5,
      }));
      parts.push(text(formatNumber(v, { unit, decimals: cellDecimals }), {
        x: x + cellW / 2, y: y + cellH / 2 + 3, 'text-anchor': 'middle',
        'font-size': TYPE.micro, 'font-weight': 600,
        fill: t > 0.55 ? '#FFFFFF' : INK.primary,
      }));
    });
  });

  return ok(`${svgOpen(width, h, title ?? 'cohort heatmap', widthMm)}${parts.join('')}</svg>`);
}

/** Blade purple ramp, light to dark. Luminance is monotonic so it prints. */
function shade(t) {
  const from = [247, 245, 255];
  const to = [59, 30, 143];
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ───────────────────────────────────────────────────────── radar chart ──

/** Readiness across the eight domains, at a glance. */
export function radarChart(spec = {}) {
  const {
    axes = [], values = [], max = 20, width = 420, height = 360,
    title = null, colour = accentColour(), comparison = null, widthMm = null,
  } = spec;

  if (axes.length < 3) return insufficientData('A radar needs at least three axes.', { width, height });

  const cx = width / 2;
  const cy = height / 2 + 4;
  const r = Math.min(width, height) * 0.33;
  const angleOf = (i) => -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
  const pointOf = (i, v) => {
    const rad = (Math.max(0, Math.min(v / max, 1))) * r;
    return [cx + rad * Math.cos(angleOf(i)), cy + rad * Math.sin(angleOf(i))];
  };

  const rings = [0.25, 0.5, 0.75, 1].map((t) => el('polygon', {
    points: axes.map((_, i) => {
      const [x, y] = [cx + r * t * Math.cos(angleOf(i)), cy + r * t * Math.sin(angleOf(i))];
      return `${n(x)},${n(y)}`;
    }).join(' '),
    fill: 'none', stroke: INK.rule, 'stroke-width': 0.5,
  })).join('');

  const spokes = axes.map((_, i) => el('line', {
    x1: cx, y1: cy, x2: cx + r * Math.cos(angleOf(i)), y2: cy + r * Math.sin(angleOf(i)),
    stroke: INK.rule, 'stroke-width': 0.5,
  })).join('');

  const polygon = (vals, fill, stroke, opacity) => el('polygon', {
    points: vals.map((v, i) => pointOf(i, Number(v) || 0).map(n).join(',')).join(' '),
    fill, opacity, stroke, 'stroke-width': 2, 'stroke-linejoin': 'round',
  });

  const compare = comparison
    ? polygon(comparison.values, 'none', INK.faint, 1)
    : '';

  const labels = axes.map((a, i) => {
    const [x, y] = [cx + (r + 18) * Math.cos(angleOf(i)), cy + (r + 18) * Math.sin(angleOf(i))];
    const anchor = Math.abs(x - cx) < 6 ? 'middle' : (x > cx ? 'start' : 'end');
    return text(a, {
      x, y: y + 3, 'text-anchor': anchor, 'font-size': TYPE.micro, fill: INK.body,
    });
  }).join('');

  const body = rings + spokes + compare
    + polygon(values, colour, colour, 0.22)
    + polygon(values, 'none', colour, 1)
    + labels;

  return ok(`${svgOpen(width, height, title ?? 'radar chart', widthMm)}${body}</svg>`);
}

// ────────────────────────────────────────────────────────── gantt chart ──

/**
 * A timeline for the gap plan.
 *
 * Bars are coloured by category rather than by owner, because the sequencing
 * argument — blockers first, then long-lead items whose time is not yours to
 * compress — is the thing the chart exists to make visible.
 */
export function ganttChart(spec = {}) {
  const {
    tasks = [], start = null, end = null, width = 680, title = null,
    categoryColours = {}, today = null, widthMm = null,
  } = spec;

  const dated = tasks.filter((t) => t.start && t.end);
  if (!dated.length) {
    return insufficientData('No dated items to plot. Add owners and due dates to the gap register.', { width });
  }

  const t0 = Date.parse(start ?? dated.reduce((m, t) => (t.start < m ? t.start : m), dated[0].start));
  const t1 = Date.parse(end ?? dated.reduce((m, t) => (t.end > m ? t.end : m), dated[0].end));
  const span = Math.max(t1 - t0, 86_400_000);

  const labelW = 190;
  const rowH = 20;
  const headerH = 24;
  const height = headerH + dated.length * rowH + 14;
  // Reserve a gutter for the category tags. Without it the longest tag is
  // clipped by the page edge — which is how "LONG_LEAD" became "LO".
  const catW = Math.max(
    0,
    ...dated.map((t) => (t.category ? textWidth(t.category, TYPE.micro) + 12 : 0)),
  );
  const plotW = width - labelW - 14 - catW;
  const xOf = (iso) => labelW + ((Date.parse(iso) - t0) / span) * plotW;

  const parts = [];

  // Month gridlines, labelled.
  const cursor = new Date(t0);
  cursor.setUTCDate(1);
  while (cursor.getTime() <= t1) {
    const x = xOf(cursor.toISOString());
    if (x >= labelW) {
      parts.push(el('line', { x1: x, x2: x, y1: headerH - 6, y2: height - 10, stroke: INK.rule, 'stroke-width': 0.5 }));
      parts.push(text(cursor.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }), {
        x: x + 3, y: headerH - 10, 'font-size': TYPE.micro, fill: INK.muted,
      }));
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  dated.forEach((t, i) => {
    const y = headerH + i * rowH;
    const x0 = xOf(t.start);
    const x1 = Math.max(xOf(t.end), x0 + 3);
    const colour = categoryColours[t.category] ?? seriesColour(i);

    parts.push(text(truncate(t.label, 34), {
      x: labelW - 10, y: y + rowH / 2 + 3, 'text-anchor': 'end',
      'font-size': TYPE.micro, fill: INK.body,
    }));
    parts.push(el('rect', {
      x: x0, y: y + 4, width: x1 - x0, height: rowH - 9, rx: 2,
      fill: colour, opacity: t.done ? 0.35 : 1,
    }));
    if (t.category) {
      parts.push(text(t.category, {
        x: x1 + 5, y: y + rowH / 2 + 3, 'font-size': TYPE.micro, fill: INK.muted,
      }));
    }
  });

  if (today) {
    const x = xOf(today);
    if (x >= labelW && x <= width) {
      parts.push(el('line', {
        x1: x, x2: x, y1: headerH - 6, y2: height - 10,
        stroke: SEMANTIC.negative, 'stroke-width': 1, 'stroke-dasharray': '3 2',
      }));
    }
  }

  return ok(`${svgOpen(width, height, title ?? 'timeline', widthMm)}${parts.join('')}</svg>`);
}

const truncate = (s, len) => (String(s).length > len ? `${String(s).slice(0, len - 1)}…` : String(s));

// ──────────────────────────────────────────────────────── scatter chart ──

export function scatterChart(spec = {}) {
  const {
    points = [], xLabel = null, yLabel = null, xUnit = null, yUnit = null,
    width = 520, height = 320, title = null, mono = false, widthMm = null,
  } = spec;

  if (points.length < 2) return insufficientData('Not enough points to plot.', { width, height });

  const f = frame({ width, height, margin: { bottom: 44, left: 60 } });
  const xs = points.map((p) => Number(p.x)).filter(Number.isFinite);
  const ys = points.map((p) => Number(p.y)).filter(Number.isFinite);
  const sx = niceScale(Math.min(...xs), Math.max(...xs), { ticks: 5, zeroBased: false });
  const sy = niceScale(Math.min(...ys), Math.max(...ys), { ticks: 5, zeroBased: false });

  const xOf = (v) => f.plot.x + ((v - sx.min) / (sx.max - sx.min)) * f.plot.w;
  const yOf = (v) => f.plot.y + f.plot.h - ((v - sy.min) / (sy.max - sy.min)) * f.plot.h;

  const dots = points.map((p, i) => {
    const cx = xOf(Number(p.x));
    const cy = yOf(Number(p.y));
    return el('circle', { cx, cy, r: p.r ?? 4, fill: p.colour ?? seriesColour(0, { mono }), opacity: 0.8 })
      + (p.label ? text(p.label, { x: cx + 6, y: cy - 5, 'font-size': TYPE.micro, fill: INK.muted }) : '');
  }).join('');

  const xTicks = sx.ticks.map((t) => text(formatNumber(t, { unit: xUnit, compact: true }), {
    x: xOf(t), y: f.plot.y + f.plot.h + 14, 'text-anchor': 'middle',
    'font-size': TYPE.chartAxis, fill: INK.muted,
  })).join('');

  const body = [
    axisTitle(f, yLabel), yAxis(f, sy, { unit: yUnit, compact: true }), dots, xTicks,
    xLabel ? text(xLabel, {
      x: f.plot.x + f.plot.w / 2, y: height - 6, 'text-anchor': 'middle',
      'font-size': TYPE.chartAxis, fill: INK.muted, 'font-weight': 600,
    }) : '',
  ].join('');

  return ok(`${svgOpen(width, height, title ?? 'scatter chart', widthMm)}${body}</svg>`);
}

// ─────────────────────────────────────────────────────────── org chart ──

/**
 * An organisation chart.
 *
 * Laid out by a tidy-tree pass rather than by fixed coordinates, so it stays
 * correct when a company adds a function. Nodes carry the key-person flag,
 * because an org chart in a data room is read for exactly one thing: where the
 * business breaks if someone leaves.
 */
export function orgChart(spec = {}) {
  const { root = null, width = 680, title = null, nodeW = 124, nodeH = 36, gapX = 14, gapY = 34, widthMm = null } = spec;
  if (!root) return insufficientData('No organisation structure recorded yet.', { width });

  // First pass: measure each subtree's width.
  const measure = (node) => {
    const children = node.children ?? [];
    if (!children.length) { node._w = nodeW; return nodeW; }
    const total = children.reduce((s, c) => s + measure(c), 0) + gapX * (children.length - 1);
    node._w = Math.max(total, nodeW);
    return node._w;
  };
  measure(root);

  // Second pass: place.
  const nodes = [];
  const edges = [];
  let depth = 0;
  const place = (node, left, level) => {
    depth = Math.max(depth, level);
    const children = node.children ?? [];
    const x = left + node._w / 2 - nodeW / 2;
    const y = level * (nodeH + gapY);
    nodes.push({ ...node, x, y });

    let cursor = left;
    for (const c of children) {
      place(c, cursor, level + 1);
      edges.push({
        x1: x + nodeW / 2, y1: y + nodeH,
        x2: cursor + c._w / 2, y2: (level + 1) * (nodeH + gapY),
      });
      cursor += c._w + gapX;
    }
  };
  place(root, 0, 0);

  const totalW = root._w;
  const height = (depth + 1) * (nodeH + gapY) - gapY + 8;
  const offset = Math.max((width - totalW) / 2, 0);

  const edgeSvg = edges.map((e) => el('path', {
    d: `M${n(e.x1 + offset)} ${n(e.y1)} V${n((e.y1 + e.y2) / 2)} H${n(e.x2 + offset)} V${n(e.y2)}`,
    fill: 'none', stroke: INK.ruleStrong, 'stroke-width': 0.8,
  })).join('');

  const nodeSvg = nodes.map((node) => {
    const x = node.x + offset;
    const keyPerson = !!node.key_person;
    return el('rect', {
      x, y: node.y, width: nodeW, height: nodeH, rx: 3,
      fill: keyPerson ? washColour() : '#FFFFFF',
      stroke: keyPerson ? accentColour() : INK.ruleStrong,
      'stroke-width': keyPerson ? 1.4 : 0.8,
    })
      + text(truncate(node.name ?? '', 20), {
        x: x + nodeW / 2, y: node.y + 15, 'text-anchor': 'middle',
        'font-size': TYPE.micro, 'font-weight': 700, fill: INK.primary,
      })
      + text(truncate(node.role ?? '', 24), {
        x: x + nodeW / 2, y: node.y + 26, 'text-anchor': 'middle',
        'font-size': TYPE.micro, fill: INK.muted,
      })
      // A flag, not just a colour — this has to survive monochrome.
      + (keyPerson
        ? text('key person', {
          x: x + nodeW / 2, y: node.y + nodeH + 9, 'text-anchor': 'middle',
          'font-size': 6, fill: accentColour(), 'font-weight': 700,
        })
        : '');
  }).join('');

  return ok(`${svgOpen(width, height, title ?? 'organisation chart', widthMm)}${edgeSvg}${nodeSvg}</svg>`);
}

// ──────────────────────────────────────────────────────────── sparkline ──

/** A tiny inline trend, for use inside table cells. */
export function sparkline(values = [], { width = 60, height = 16, colour = accentColour() } = {}) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (clean.length < 2) return '';
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const d = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return `${i ? 'L' : 'M'}${n(x)} ${n(y)}`;
  }).join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" `
       + `height="${height}" role="img" aria-label="trend">`
       + el('path', { d, fill: 'none', stroke: colour, 'stroke-width': 1.4, 'stroke-linejoin': 'round' })
       + '</svg>';
}

export const CHART_TYPES = Object.freeze([
  'bar', 'grouped bar', 'stacked bar', 'line', 'area', 'waterfall', 'donut',
  'cohort heatmap', 'radar', 'gantt', 'scatter', 'org chart', 'sparkline',
]);
