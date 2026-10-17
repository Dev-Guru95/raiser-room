/**
 * Table rendering.
 *
 * Tables carry most of the numbers in a data room, and most of the places a
 * generated document gives itself away. The rules enforced here are the ones a
 * financial printer would enforce:
 *
 *   · figures right-aligned, labels left, nothing centred;
 *   · tabular numerals, so digits line up down the column;
 *   · one precision per column, decided from the column and not per cell;
 *   · negatives in brackets;
 *   · totals ruled above, not emboldened and left to float;
 *   · an absent value shown as an em dash, never as zero, never as blank.
 *
 * The last one matters most. A blank cell and a zero cell mean different things
 * and a reader will assume whichever is worse.
 */

import { INK, TYPE, formatNumber, compactDecimalsFor, percentDecimals, toNumber, escapeText } from './theme.js';

export class TableError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const ALIGN = Object.freeze(['left', 'right']);

/**
 * @param {object} spec
 *   columns  [{ key, label, align?, unit?, compact?, decimals?, width?, emphasis? }]
 *   rows     [{ ...cells, _kind?: 'row'|'subtotal'|'total'|'rule', _note?: string }]
 *   caption, footnotes, zebra, compact
 */
export function dataTable(spec = {}) {
  const {
    columns = [], rows = [], caption = null, footnotes = [],
    zebra = false, dense = false, className = '',
  } = spec;

  if (!columns.length) throw new TableError('no_columns', 'a table needs columns');

  // One precision per numeric column, decided from the whole column. Deciding
  // per cell produces a column reading 1,240 / 1,240.5 / 1,241, which looks
  // like three different measurements of the same thing.
  const decimalsByKey = {};
  for (const col of columns) {
    if (col.decimals !== undefined && col.decimals !== null) { decimalsByKey[col.key] = col.decimals; continue; }
    // Percent columns too, not just compact ones. A column reading
    // "44.3% / 72% / 84.9%" mixes precisions exactly as a compact column would.
    if (col.unit === 'percent') { decimalsByKey[col.key] = percentDecimals(rows.map((r) => r[col.key])); continue; }
    if (!col.compact) continue;
    decimalsByKey[col.key] = compactDecimalsFor(rows.map((r) => r[col.key]));
  }

  const head = columns.map((c) => {
    const align = c.align ?? (c.unit || c.compact ? 'right' : 'left');
    return `<th class="${align}" ${c.width ? `style="width:${c.width}"` : ''}>${escapeText(c.label)}</th>`;
  }).join('');

  const body = rows.map((row, i) => {
    if (row._kind === 'rule') return `<tr class="rule-row"><td colspan="${columns.length}"></td></tr>`;

    const kind = row._kind ?? 'row';
    const classes = [kind !== 'row' ? kind : '', zebra && i % 2 === 1 ? 'alt' : ''].filter(Boolean).join(' ');

    const cells = columns.map((c) => {
      const align = c.align ?? (c.unit || c.compact ? 'right' : 'left');
      const raw = row[c.key];
      return `<td class="${align}${c.emphasis ? ' strong' : ''}">${cell(raw, c, decimalsByKey[c.key])}</td>`;
    }).join('');

    return `<tr${classes ? ` class="${classes}"` : ''}>${cells}</tr>`;
  }).join('');

  const notes = footnotes.length
    ? `<tfoot><tr><td colspan="${columns.length}" class="notes">${
      footnotes.map((f) => `<span class="note">${escapeText(f)}</span>`).join('')
    }</td></tr></tfoot>`
    : '';

  return `<table class="data ${dense ? 'dense' : ''} ${className}">`
    + (caption ? `<caption>${escapeText(caption)}</caption>` : '')
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>${notes}</table>`;
}

/**
 * One cell.
 *
 * A raw string passes through (already-formatted labels, dates, markup-free
 * prose). A number is formatted by the column's rules. Absent is an em dash.
 */
function cell(raw, col, decimals) {
  if (raw === null || raw === undefined || raw === '') return '<span class="absent">—</span>';
  if (typeof raw === 'object' && raw.html) return raw.html;      // sparkline, pill, etc.

  if (col.unit || col.compact || col.numeric) {
    const n = toNumber(raw);
    // Not a zero. A value that cannot be read as a number is a data problem and
    // showing it as 0 would hide it.
    if (n === null) return `<span class="absent">${escapeText(raw)}</span>`;
    return `<span class="tnum">${escapeText(formatNumber(n, {
      unit: col.unit, compact: !!col.compact, decimals,
    }))}</span>`;
  }

  // A raw number reaching here means the column declared no numeric formatting,
  // so the value prints through `String()`: "3600000" where the deck should read
  // "$3,600,000", and "71" where it should read "71%".
  //
  // This shipped. It was in the financial summary of the investor deck — the one
  // table an investor reads first — and every structural check passed, because
  // the figure was correct and present and traced to its source. It was just
  // written the way a database writes it.
  //
  // Loud, therefore, not lenient. A caller with a genuinely pre-formatted figure
  // passes a string; a caller with a number says how to format it.
  // A column whose values the caller formatted itself — a genuinely mixed column,
  // where currency and percentage sit in the same place and no single unit fits.
  // It still gets tabular numerals: proportional figures in a financial table
  // are the most reliable way to make a generated document look amateur.
  if (col.preformatted) return `<span class="tnum">${escapeText(raw)}</span>`;

  if (typeof raw === 'number') {
    throw new TableError('unformatted_number',
      `column "${col.key}" was given the number ${raw} but declares no unit, compact or numeric `
      + 'formatting, so it would print unformatted. Set one of those on the column, or format the '
      + 'value before putting it in the row.');
  }

  return escapeText(raw);
}

/** A small status pill. Carries a word, never only a colour. */
export function pill(label, tone = 'neutral') {
  return { html: `<span class="pill pill-${escapeText(tone)}">${escapeText(label)}</span>` };
}

/** Raw HTML into a cell — used for sparklines. Callers pass trusted markup only. */
export const rawCell = (html) => ({ html });

/** Stylesheet for everything above. */
export function tableCss() {
  return `
  table.data{
    width:100%; border-collapse:collapse; font-family:var(--sans);
    font-size:${TYPE.bodyS}pt; color:var(--body);
  }
  table.data caption{
    caption-side:top; text-align:left; font-weight:700; color:var(--ink);
    font-size:${TYPE.headingS}pt; padding-bottom:1.6mm;
  }
  table.data th{
    font-size:${TYPE.micro}pt; text-transform:uppercase; letter-spacing:.06em;
    color:var(--muted); font-weight:700; padding:0 2.4mm 1.4mm;
    border-bottom:.8pt solid ${INK.ruleStrong};
  }
  table.data td{ padding:1.5mm 2.4mm; border-bottom:.35pt solid var(--rule); }
  table.data.dense td{ padding:1mm 2mm; }
  table.data .left{ text-align:left; }
  table.data .right{ text-align:right; }
  table.data .tnum{ font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1; }
  table.data .absent{ color:var(--faint); }
  table.data .strong{ font-weight:700; color:var(--ink); }
  table.data tr.alt td{ background:var(--wash-neutral); }
  /* Totals are ruled above, the way a printed account does it. */
  table.data tr.subtotal td{ border-top:.6pt solid ${INK.ruleStrong}; font-weight:700; color:var(--ink); }
  table.data tr.total td{
    border-top:1pt solid ${INK.primary}; border-bottom:2.2pt double ${INK.primary};
    font-weight:700; color:var(--ink);
  }
  table.data tr.rule-row td{ padding:0; height:1.6mm; border:0; }
  table.data tfoot .notes{ border:0; padding-top:1.8mm; }
  table.data tfoot .note{
    display:block; font-size:${TYPE.micro}pt; color:var(--muted); font-family:var(--serif);
  }
  .pill{
    display:inline-block; padding:.3mm 1.6mm; border-radius:6pt;
    font-size:${TYPE.micro}pt; font-weight:700; letter-spacing:.03em;
  }
  .pill-neutral{ background:var(--wash-neutral); color:var(--body); }
  .pill-good{ background:#E6F3EC; color:#1F7A4D; }
  .pill-bad{ background:#F7E7EA; color:#A3243B; }
  .pill-warn{ background:#FBF2DF; color:#8A6A00; }
  .pill-info{ background:var(--wash); color:var(--accent-text); }
  `;
}
