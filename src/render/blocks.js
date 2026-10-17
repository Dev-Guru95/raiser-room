/**
 * Block rendering — turning a catalogue entry into a document.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BINDER
 *
 * Everything numeric on a page goes through `FactBinder`. It resolves a fact
 * key, records that the artifact used it, and returns a formatted string. No
 * block is permitted to write a figure any other way — which is what makes the
 * provenance appendix complete by construction rather than by diligence, and
 * what makes the artifact's `fact_refs` an exact record of what it rests on.
 *
 * A key with no fact behind it comes back as absent, and the block says so. It
 * is never filled with a placeholder: a placeholder in a document that leaves
 * the building becomes a real number to whoever reads it.
 */

import { escapeHtml } from './document.js';
import { formatNumber, formatDate, formatPeriod, TYPE, INK, toNumber, percentDecimals, currentLocale } from './theme.js';
import { s } from '../i18n/strings.js';
import { dataTable, pill, rawCell, tableCss } from './tables.js';
import {
  barChart, lineChart, waterfallChart, donutChart, radarChart,
  ganttChart, orgChart, cohortHeatmap, sparkline, insufficientData,
} from './charts.js';
import { renderCitation, claimBlockers } from '../domain/evidence.js';
import { DOMAINS } from '../domain/criteria.js';
import { valuationReadiness } from '../domain/valuation.js';

export class BlockError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Resolves fact references and remembers every one it was asked for.
 *
 * `used` is the artifact's bill of materials. It is what goes into the
 * provenance appendix and into `artifact.fact_refs`, and it is accurate because
 * it is a by-product of rendering rather than a list someone maintained.
 */
export class FactBinder {
  constructor(facts = []) {
    this.byKey = new Map();
    for (const f of facts) {
      // Facts carry periods; keep them all, newest last, so a key can yield
      // either a point value or a series.
      if (!this.byKey.has(f.fact_key)) this.byKey.set(f.fact_key, []);
      this.byKey.get(f.fact_key).push(f);
    }
    for (const list of this.byKey.values()) {
      list.sort((a, b) => String(a.period_end ?? a.created_at).localeCompare(String(b.period_end ?? b.created_at)));
    }
    this.used = new Map();
    this.missing = new Set();
  }

  /** The current fact for a key, or null. Records the lookup either way. */
  fact(key) {
    const list = this.byKey.get(key);
    if (!list || !list.length) { this.missing.add(key); return null; }
    const latest = list.at(-1);
    this.used.set(latest.id, latest);
    return latest;
  }

  has(key) { return this.byKey.has(key) && this.byKey.get(key).length > 0; }

  /** A formatted value, or an em dash. Never a zero standing in for absence. */
  value(key, opts = {}) {
    const f = this.fact(key);
    if (!f) return '<span class="absent">—</span>';
    if (f.value_numeric !== null && f.value_numeric !== undefined) {
      return `<span class="tnum">${escapeHtml(formatNumber(f.value_numeric, {
        unit: f.unit, ...opts,
      }))}</span>`;
    }
    if (f.value_date) return escapeHtml(formatDate(f.value_date));
    return escapeHtml(f.value_text ?? '—');
  }

  /** The raw number, for charts. */
  number(key) {
    const f = this.fact(key);
    return f ? toNumber(f.value_numeric) : null;
  }

  label(key, fallback = null) {
    const f = this.byKey.get(key)?.at(-1);
    return f?.label ?? fallback ?? key;
  }

  /** Every period recorded for a key, oldest first — the natural source of a trend. */
  series(key) {
    const list = this.byKey.get(key) ?? [];
    const points = list
      .filter((f) => toNumber(f.value_numeric) !== null && (f.period_end || f.period_start))
      .map((f) => {
        this.used.set(f.id, f);
        return {
          label: periodLabel(f),
          value: toNumber(f.value_numeric),
          unit: f.unit,
        };
      });
    if (!points.length) this.missing.add(key);
    return points;
  }

  /** Facts under a key prefix — how structured sets (holders, customers) are stored. */
  group(prefix) {
    const out = [];
    for (const [key, list] of this.byKey) {
      if (!key.startsWith(prefix)) continue;
      const f = list.at(-1);
      this.used.set(f.id, f);
      out.push({ key, suffix: key.slice(prefix.length), fact: f });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  factRefs() { return [...this.used.keys()]; }
  usedFacts() { return [...this.used.values()]; }
  missingKeys() { return [...this.missing]; }
}

function periodLabel(fact) {
  const end = fact.period_end ?? fact.period_start;
  if (!end) return '';
  const d = new Date(end);
  if (Number.isNaN(d.getTime())) return String(end);
  const m = d.getUTCMonth();
  if (m === 11) return `FY${d.getUTCFullYear()}`;
  return `${['Q1', 'Q1', 'Q1', 'Q2', 'Q2', 'Q2', 'Q3', 'Q3', 'Q3', 'Q4', 'Q4', 'Q4'][m]} ${String(d.getUTCFullYear()).slice(2)}`;
}

// ─────────────────────────────────────────────────────────── the blocks ──

const missingNote = (what) =>
  `<div class="chart-missing"><p>${escapeHtml(what)}</p></div>`;

const BLOCKS = {
  COVER(ctx, b) {
    const name = b.anonymised ? 'A confidential opportunity' : (ctx.org.name ?? 'Company');
    return `<div class="cover cover-block">
      <p class="eyebrow">${escapeHtml(ctx.spec.title)}</p>
      <h1 class="cover-title">${escapeHtml(name)}</h1>
      <p class="cover-sub">${escapeHtml(ctx.spec.purpose)}</p>
      <div class="rule"></div>
      <p class="cover-meta">${escapeHtml(formatDate(ctx.now))}${
  ctx.org.path && ctx.org.path !== 'UNDECIDED' ? ` · ${escapeHtml(ctx.org.path.toLowerCase())} process` : ''
}</p>
    </div>`;
  },

  SECTION(ctx, b) {
    return `<div class="section-head">
      <p class="eyebrow">${escapeHtml(b.eyebrow ?? ctx.spec.title)}</p>
      <h2>${escapeHtml(b.heading ?? ctx.spec.title)}</h2>
      <div class="rule"></div>
    </div>`;
  },

  /** A row of headline figures. Every one is a reference. */
  KPI_ROW(ctx, b, binder) {
    const candidates = b.keys ?? [
      'financials.arr', 'financials.revenue.ttm', 'financials.normalised_earnings',
      'financials.gross_margin', 'people.headcount', 'commercial.concentration.top1',
    ];
    const tiles = candidates
      .filter((k) => binder.has(k))
      .slice(0, 4)
      .map((k) => {
        const f = binder.fact(k);
        return `<div class="kpi">
          <div class="kpi-value">${binder.value(k, { compact: true })}</div>
          <div class="kpi-label">${escapeHtml(f.label)}</div>
          ${f.period_end ? `<div class="kpi-period">${escapeHtml(formatPeriod(f.period_start, f.period_end))}</div>` : ''}
        </div>`;
      });

    // On the credibility record the headline is the record itself, not a
    // revenue figure.
    if (ctx.spec.kind === 'FORECAST_CREDIBILITY' && ctx.cadence) {
      const c = ctx.cadence.credibility;
      return `<div class="kpi-row">
        <div class="kpi"><div class="kpi-value">${c.cycles_complete}/${c.cycles_needed}</div>
          <div class="kpi-label">Forecast cycles measured</div></div>
        <div class="kpi"><div class="kpi-value">${
  c.variances_needing_explanation
    ? `${escapeHtml(String(c.explanation_rate))}%`
    : 'None'}</div>
          <div class="kpi-label">${
  c.variances_needing_explanation ? 'Material variances explained' : 'Material variances to explain'}</div></div>
        <div class="kpi"><div class="kpi-value">${
  c.variances_needing_explanation ? c.explained_promptly : '—'}</div>
          <div class="kpi-label">Explained within six weeks</div></div>
      </div>
      <p class="prose"><em>${escapeHtml(c.statement)}</em></p>`;
    }

    if (!tiles.length) {
      return missingNote('No headline figures have been confirmed yet, so this row is empty rather than '
        + 'filled with placeholders.');
    }
    return `<div class="kpi-row">${tiles.join('')}</div>`;
  },

  PROSE(ctx, b) {
    // Prose carries no figures of its own. Where a number belongs in a
    // sentence it is bound by key, and an unbound key renders as absent rather
    // than as a plausible value.
    const paragraphs = (b.paragraphs ?? ctx.prose?.[b.slot ?? 'default'] ?? []).map((p) =>
      `<p>${bindInline(p, ctx.binder)}</p>`);
    if (!paragraphs.length) return '';
    const heading = b.heading ?? PROSE_HEADINGS[b.slot ?? 'default'] ?? null;
    const head = heading ? `<h3 class="prose-heading">${escapeHtml(heading)}</h3>` : '';
    return `${head}<div class="prose${ctx.slide ? ' prose-slide' : ''}">${paragraphs.join('')}</div>`;
  },

  CHART(ctx, b, binder) {
    const build = CHARTS[b.chart];
    if (!build) return missingNote(`No chart is defined for "${b.chart}".`);
    const result = build(ctx, binder, ctx.chartWidthMm);
    if (!result) return '';
    // A chart on a slide with no headline is a picture with no argument. The
    // heading is what the reader is meant to take away; the chart is evidence
    // for it.
    const heading = b.heading ?? CHART_HEADINGS[b.chart] ?? null;
    const head = heading ? `<h3 class="chart-heading">${escapeHtml(heading)}</h3>` : '';

    // Heading and chart wrapped together, so a page break cannot leave the
    // headline on one page and the evidence for it on the next. A chart's
    // heading is the argument and the chart is the support; separated, the
    // reader gets an assertion with nothing under it.
    return result.ok
      ? `<div class="chart-group">${head}<figure class="chart">${result.svg}${
        b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''}</figure></div>`
      : `<div class="chart-group">${head}${result.placeholder}</div>`;
  },

  TABLE(ctx, b, binder) {
    const build = TABLES[b.table];
    if (!build) return missingNote(`No table is defined for "${b.table}".`);
    const result = build(ctx, binder);
    if (!result) return '';
    return typeof result === 'string' ? result : missingNote(result.reason);
  },

  CHECKLIST(ctx) {
    const room = ctx.room;
    if (!room?.folders?.length) return missingNote('The data room has not been built yet.');
    return `<div class="checklist">${room.folders.map((f) => `
      <div class="checklist-row">
        <span class="checklist-key">${escapeHtml(f.key)}</span>
        <span class="checklist-name">${escapeHtml(f.name)}</span>
        <span class="checklist-bar"><span style="width:${Math.max(f.completeness, 2)}%"></span></span>
        <span class="checklist-pct tnum">${escapeHtml(formatNumber(f.completeness, { unit: 'percent', decimals: 0 }))}</span>
      </div>`).join('')}</div>`;
  },

  /** External claims, with their citations as numbered footnotes. */
  EVIDENCE(ctx) {
    const claims = ctx.externalClaims ?? [];
    const usable = claims.filter((c) => claimBlockers(c, ctx.now).length === 0);
    if (!usable.length) {
      return claims.length
        ? missingNote('External claims were supplied but none carries a complete, in-date citation, so '
          + 'none is shown. A market figure a reader cannot check is the first thing they will question.')
        : '';
    }
    return `<div class="evidence">
      <h3>Sources</h3>
      <ol class="citations">${usable.map((c) =>
    `<li><span class="claim">${escapeHtml(c.statement ?? c.fact?.label ?? '')}</span>
         <span class="cite">${escapeHtml(renderCitation(c.citation, { asOf: ctx.now }))}</span>
         <span class="quote">“${escapeHtml(c.citation.quote)}”</span></li>`).join('')}</ol>
    </div>`;
  },

  /**
   * The provenance appendix.
   *
   * Every figure the document used, where it came from, and who confirmed it.
   * Built from the binder, so it cannot drift from what was actually rendered.
   */
  APPENDIX(ctx, b, binder) {
    const facts = binder.usedFacts();
    if (!facts.length) return '';
    return `<div class="appendix">
      <h3>${escapeHtml(L('doc.appendix.heading'))}</h3>
      <p class="appendix-note">${escapeHtml(L('doc.appendix.note'))}</p>
      ${dataTable({
    dense: true,
    columns: [
      { key: 'label', label: L('doc.column.figure') },
      { key: 'value', label: L('doc.column.value'), align: 'right' },
      { key: 'period', label: L('doc.column.period') },
      { key: 'source', label: L('doc.column.how_it_got_here') },
      { key: 'confirmed', label: L('doc.column.confirmed') },
    ],
    rows: facts.map((f) => ({
      label: f.label,
      value: f.value_numeric !== null && f.value_numeric !== undefined
        ? formatNumber(f.value_numeric, { unit: f.unit })
        : (f.value_text ?? formatDate(f.value_date)),
      period: formatPeriod(f.period_start, f.period_end) || '—',
      source: sourceWording(f, ctx),
      confirmed: f.confirmed_at ? formatDate(f.confirmed_at, { style: 'short' }) : '—',
    })),
  })}
    </div>`;
  },

  DISCLAIMER(ctx) {
    return `<div class="disclaimer">
      <p>This document was generated by RaiseRoom from figures held in ${escapeHtml(ctx.org.name ?? 'the company')}'s
      own records. Every figure traces to a source document confirmed by a named person, and the appendix
      lists each one.</p>
      <p>It is a presentation of the company's own information. It is not an offer, a solicitation, a
      valuation, or legal, financial, accounting or investment advice, and it does not predict any outcome.</p>
    </div>`;
  },
};

function sourceWording(fact, ctx) {
  const doc = ctx.documentsById?.[fact.source_doc_id];
  const where = doc ? `${doc.filename}${fact.source_page ? `, p.${fact.source_page}` : ''}` : null;
  switch (fact.source) {
    case 'USER_CONFIRMED':
      if (!doc) return L('doc.source.confirmed_from', { document: L('doc.source.a_document') });
      return fact.source_page
        ? L('doc.source.confirmed_from_page', { document: doc.filename, page: fact.source_page })
        : L('doc.source.confirmed_from', { document: doc.filename });
    case 'USER_ENTERED': return L('doc.source.entered_by_hand');
    case 'CALCULATED': return `Calculated — ${fact.formula ?? 'stored formula'}`;
    default: return 'In the fact store';
  }
}

/**
 * A piece of document furniture, in the locale the document is rendering in.
 *
 * Goes through the catalogue in git rather than a literal, because these are
 * read as statements by the company issuing the document — "Confirmed from" is a
 * claim about provenance, and a version of it that came out meaning "Approved
 * by" would be a different claim in a language the issuer cannot check.
 *
 * Falls back to English per string, so an unfinished locale shows an English
 * heading rather than a key.
 */
const L = (key, values = {}) => s(key, currentLocale() ?? 'en-GB', values);

/** `{{fact:key}}` in prose is replaced by a bound value, never by a typed number. */
function bindInline(textValue, binder) {
  return escapeHtml(textValue).replace(/\{\{\s*fact:([a-z0-9_.]+)\s*\}\}/gi, (_, key) => binder.value(key, { compact: true }));
}

/** Headlines for prose slots, so a prose slide is not three unanchored lines. */
const PROSE_HEADINGS = Object.freeze({
  default: 'The business',
  market: 'The market, from cited sources only',
  assumptions: 'What the plan depends on',
});

/** What each chart is actually saying. Shown as the slide's headline. */
const CHART_HEADINGS = Object.freeze({
  revenue_trend: 'Revenue, confirmed from the accounts',
  concentration: 'Customer concentration',
  concentration_trend: 'Concentration, two years apart',
  normalisation_bridge: 'Reported profit to underlying earnings',
  ownership: 'Ownership, fully diluted',
  readiness_radar: 'Readiness by domain',
  gap_plan: 'The work, in fix order',
  org: 'How the business is structured',
  cohorts: 'Revenue retention by cohort',
  use_of_funds: 'Use of funds',
  unit_economics: 'Unit economics by segment',
  market: 'Market context',
});

// ───────────────────────────────────────────────────────── chart builders ──

const CHARTS = {
  revenue_trend(ctx, binder, widthMm) {
    const key = binder.has('financials.revenue.ttm') ? 'financials.revenue.ttm' : 'financials.arr';
    const points = binder.series(key);
    if (points.length < 2) {
      return insufficientData('A revenue trend needs at least two periods of confirmed figures.');
    }
    return lineChart({
      categories: points.map((p) => p.label),
      series: [{ name: binder.label(key), values: points.map((p) => p.value) }],
      unit: points[0].unit, area: true, width: 620, height: 260, widthMm,
    });
  },

  concentration(ctx, binder, widthMm) {
    const keys = [
      ['commercial.concentration.top1', 'Top customer'],
      ['commercial.concentration.top3', 'Top 3 customers'],
      ['commercial.concentration.top5', 'Top 5 customers'],
    ].filter(([k]) => binder.has(k));
    if (!keys.length) return insufficientData('Customer concentration has not been recorded yet.');

    const top1 = binder.number('commercial.concentration.top1');
    return barChart({
      categories: keys.map(([, label]) => label),
      series: [{ name: 'Share of revenue', values: keys.map(([k]) => binder.number(k)) }],
      unit: 'percent', width: 520, height: 250, widthMm,
      axisLabel: 'Share of revenue (%)',
      ...(top1 !== null ? {} : {}),
    });
  },

  concentration_trend(ctx, binder, widthMm) {
    const now = binder.number('commercial.concentration.top1');
    const prior = binder.number('commercial.concentration.top1.prior');
    if (now === null || prior === null) {
      return insufficientData('The two-year concentration trend needs both the current and the prior figure.');
    }
    return barChart({
      categories: ['Two years ago', 'Now'],
      series: [{ name: 'Top customer share', values: [prior, now] }],
      unit: 'percent', width: 420, height: 230, widthMm,
    });
  },

  normalisation_bridge(ctx, binder, widthMm) {
    const reported = binder.number('financials.reported_profit');
    const normalised = binder.number('financials.normalised_earnings');
    if (reported === null || normalised === null) {
      return insufficientData('The bridge needs both reported profit and normalised earnings.');
    }

    const adjustments = binder.group('financials.adjustment.')
      .map((g) => ({ label: g.fact.label, value: toNumber(g.fact.value_numeric), kind: 'delta' }))
      .filter((a) => a.value !== null);

    // If individual adjustments have not been recorded, the bridge is drawn
    // with a single combined step and SAYS it is combined, rather than
    // inventing a breakdown that looks itemised.
    const steps = adjustments.length
      ? [{ label: binder.label('financials.reported_profit'), value: reported, kind: 'start' },
        ...adjustments,
        { label: binder.label('financials.normalised_earnings'), value: 0, kind: 'end' }]
      : [{ label: binder.label('financials.reported_profit'), value: reported, kind: 'start' },
        { label: 'Total adjustments (not yet itemised)', value: normalised - reported, kind: 'delta' },
        { label: binder.label('financials.normalised_earnings'), value: 0, kind: 'end' }];

    return waterfallChart({ steps, unit: 'USD', width: 640, height: 300, widthMm });
  },

  ownership(ctx, binder, widthMm) {
    const holders = binder.group('cap_table.holder.');
    if (!holders.length) return insufficientData('No cap table holdings have been recorded yet.');
    return donutChart({
      slices: holders.map((h) => ({ name: h.fact.label, value: toNumber(h.fact.value_numeric) })),
      unit: 'percent', width: 460, height: 280, widthMm,
    });
  },

  readiness_radar(ctx, binder, widthMm) {
    const result = ctx.assessment?.result;
    if (!result?.domains?.length) return insufficientData('No completed readiness assessment yet.');
    return radarChart({
      axes: result.domains.map((d) => shortDomain(d.name)),
      values: result.domains.map((d) => d.raw),
      max: 20, width: 420, height: 340, widthMm: widthMm ? Math.min(widthMm, 120) : null,
    });
  },

  gap_plan(ctx, binder, widthMm) {
    const gaps = (ctx.gaps ?? []).filter((g) => g.due_date);
    if (!gaps.length) {
      return insufficientData('No gaps have due dates yet. Add owners and dates to see the plan as a timeline.');
    }
    return ganttChart({
      tasks: gaps.map((g) => ({
        label: `${g.criterion_ref} ${g.description}`.slice(0, 44),
        start: g.created_at, end: g.due_date, category: g.category, done: !!g.closed_at,
      })),
      today: ctx.now, width: 660, widthMm,
      categoryColours: {
        BLOCKER: '#A3243B', LONG_LEAD: '#8A6A00', THIRD_PARTY: '#3B1E8F',
        CHEAP: '#7E3FF2', ROOM: '#B0B0B0',
      },
    });
  },

  org(ctx, binder, widthMm) {
    if (!ctx.orgTree) return insufficientData('No organisation structure has been recorded yet.');
    return orgChart({ root: ctx.orgTree, width: 640, widthMm });
  },

  cohorts(ctx, binder, widthMm) {
    const c = ctx.cohorts;
    if (!c?.cohorts?.length) return insufficientData('No cohort data has been recorded yet.');
    return cohortHeatmap({ ...c, width: 600, widthMm });
  },

  use_of_funds(ctx, binder, widthMm) {
    const lines = binder.group('raise.use_of_funds.');
    if (!lines.length) return insufficientData('The use of funds has not been recorded yet.');
    return donutChart({
      slices: lines.map((l) => ({ name: l.fact.label, value: toNumber(l.fact.value_numeric) })),
      unit: 'USD', width: 460, height: 280, widthMm,
    });
  },
};

const shortDomain = (name) => String(name)
  .replace('Corporate and cap table', 'Corporate')
  .replace('The financial record', 'Financial')
  .replace('Commercial and customers', 'Commercial')
  .replace('Contracts and legal', 'Legal')
  .replace('IP, technology and data', 'IP & tech')
  .replace('People and key-person risk', 'People')
  .replace('The story and the model', 'Story')
  .replace('The room itself', 'The room');

// ───────────────────────────────────────────────────────── table builders ──

const TABLES = {
  financial_summary(ctx, binder) {
    const keys = [
      'financials.revenue.ttm', 'financials.cogs.ttm', 'financials.gross_margin',
      'financials.reported_profit', 'financials.normalised_earnings', 'financials.arr',
    ].filter((k) => binder.has(k));
    if (!keys.length) return { reason: 'No financial figures have been confirmed yet.' };

    const pctDecimals = percentDecimals(
      keys.map((k) => binder.fact(k)).filter((f) => f.unit === 'percent').map((f) => f.value_numeric),
    );

    return dataTable({
      caption: 'Financial summary',
      columns: [
        { key: 'metric', label: L('doc.column.figure') },
        { key: 'period', label: L('doc.column.period') },
        { key: 'value', label: L('doc.column.value'), align: 'right', preformatted: true },
        { key: 'source', label: L('doc.column.source') },
      ],
      // Formatted per row, from each fact's OWN unit, because this column is
      // genuinely mixed: revenue is currency and gross margin is a percentage.
      // A single unit on the column would print the margin as "$71". Leaving the
      // column unformatted — which is what it did — printed "3600000" and "71"
      // in the first table an investor reads.
      rows: keys.map((k) => {
        const f = binder.fact(k);
        return {
          metric: f.label,
          period: formatPeriod(f.period_start, f.period_end) || '—',
          value: formatNumber(f.value_numeric, {
            unit: f.unit ?? null,
            // One precision across every percentage in the column, even though
            // the column itself is mixed. Two margins reading "63.9%" and "71%"
            // in the same column is the defect this whole rule is about.
            decimals: f.unit === 'percent' ? pctDecimals : null,
          }),
          source: f.source === 'USER_CONFIRMED'
            ? L('doc.source.confirmed_from', { document: L('doc.source.a_document'), page: '—' })
            : L('doc.source.entered_by_hand'),
        };
      }),
      footnotes: ['Every figure above is a reference into the fact store. See the appendix for the document '
        + 'and page each was confirmed from.'],
    });
  },

  /**
   * What a valuer will ask to see, and what the company has.
   *
   * Three states and no score. A percentage here would be a number about the
   * company's prospects dressed as a measurement, which is the one thing the
   * valuation feature exists to not produce.
   */
  valuation_evidence(ctx, binder) {
    const readiness = valuationReadiness(ctx.facts ?? []);
    // Through `binder.fact`, so every figure this table rests on is recorded as
    // used and appears in the provenance appendix like any other.
    for (const area of readiness.areas) {
      for (const key of area.present) binder.fact(key);
    }

    return dataTable({
      caption: 'What a valuer will ask you to evidence',
      columns: [
        { key: 'area', label: 'Area' },
        { key: 'state', label: 'Where it stands' },
        { key: 'test', label: 'Reproducible when' },
      ],
      rows: readiness.areas.map((a) => ({
        area: a.name,
        state: { EVIDENCED: 'Evidenced', PARTIAL: 'Partly', NOT_STARTED: 'Not started' }[a.state],
        test: a.reproducible_when,
      })),
      footnotes: [readiness.no_estimate],
    });
  },

  normalisation(ctx, binder) {
    const reported = binder.fact('financials.reported_profit');
    const normalised = binder.fact('financials.normalised_earnings');
    if (!reported || !normalised) return { reason: 'The normalisation bridge has not been recorded yet.' };

    const adjustments = binder.group('financials.adjustment.');
    const rows = [
      { item: reported.label, amount: reported.value_numeric, evidence: 'Statutory accounts', _kind: 'row' },
      ...adjustments.map((a) => ({
        item: a.fact.label, amount: a.fact.value_numeric,
        evidence: a.fact.source === 'USER_CONFIRMED' ? 'Evidenced' : 'Not yet evidenced',
      })),
      { item: normalised.label, amount: normalised.value_numeric, evidence: '', _kind: 'total' },
    ];

    return dataTable({
      caption: 'Normalisation bridge',
      columns: [
        { key: 'item', label: 'Item' },
        { key: 'amount', label: 'Amount', unit: 'USD', align: 'right' },
        { key: 'evidence', label: 'Evidence' },
      ],
      rows,
      footnotes: adjustments.length
        ? []
        : ['Individual adjustments have not been itemised yet. Until they are, the bridge shows a single '
          + 'combined movement rather than a breakdown.'],
    });
  },

  domain_scores(ctx) {
    const result = ctx.assessment?.result;
    if (!result?.domains?.length) return { reason: 'No completed readiness assessment yet.' };
    return dataTable({
      caption: 'Score by domain',
      columns: [
        { key: 'domain', label: 'Domain' },
        { key: 'raw', label: 'Raw', align: 'right', numeric: true },
        { key: 'weight', label: 'Weight', align: 'right', numeric: true },
        { key: 'weighted', label: 'Weighted', align: 'right', numeric: true },
        { key: 'state', label: '' },
      ],
      rows: result.domains.map((d) => ({
        domain: `${d.domain}. ${d.name}`,
        raw: `${d.raw}/20`,
        weight: `×${d.weight}`,
        weighted: d.weighted,
        state: d.raw < 8 ? pill('below floor', 'bad') : d.raw >= 16 ? pill('strong', 'good') : pill('mid', 'neutral'),
      })),
    });
  },

  gap_register(ctx) {
    const gaps = ctx.gaps ?? [];
    if (!gaps.length) return { reason: 'No open gaps. Either nothing has been scored yet, or everything is closed.' };
    return dataTable({
      caption: 'Gap register, in fix order',
      dense: true,
      columns: [
        { key: 'ref', label: 'Ref' },
        { key: 'category', label: 'Category' },
        { key: 'description', label: 'Gap' },
        { key: 'done_when', label: 'Done when' },
        { key: 'owner', label: 'Owner' },
        { key: 'due', label: 'Due' },
      ],
      rows: gaps.map((g) => ({
        ref: g.criterion_ref,
        category: pill(g.category.replace('_', ' ').toLowerCase(),
          g.category === 'BLOCKER' ? 'bad' : g.category === 'CHEAP' ? 'good' : 'warn'),
        description: g.description,
        done_when: g.done_when,
        owner: g.owner_user_id ?? null,
        due: g.due_date ? formatDate(g.due_date, { style: 'short' }) : null,
      })),
      footnotes: ['Ordered by what each item depends on and how long it takes to come back, not by score. '
        + 'Blocking items first, then long-lead items, because the time they take is not yours to compress.'],
    });
  },

  room_index(ctx) {
    const room = ctx.room;
    if (!room?.folders?.length) return { reason: 'The data room has not been built yet.' };
    const rows = [];
    for (const folder of room.folders) {
      rows.push({ item: `${folder.key}. ${folder.name}`, state: '', note: '', _kind: 'subtotal' });
      for (const i of folder.items) {
        rows.push({
          item: `   ${i.ref} ${i.name}`,
          state: i.state === 'PRESENT' ? pill('present', 'good')
            : i.state === 'NOT_APPLICABLE' ? pill('not applicable', 'neutral') : pill('missing', 'bad'),
          note: i.na_reason ?? '',
        });
      }
    }
    return dataTable({
      caption: 'Data room index',
      dense: true,
      columns: [
        { key: 'item', label: 'Item' },
        { key: 'state', label: 'State' },
        { key: 'note', label: 'Note' },
      ],
      rows,
    });
  },

  top_customers(ctx, binder) {
    const customers = binder.group('commercial.customer.');
    if (!customers.length) {
      return { reason: 'Revenue by customer has not been recorded yet, so the top customers cannot be listed.' };
    }
    return dataTable({
      caption: 'Largest customers by revenue',
      columns: [
        { key: 'name', label: 'Customer' },
        { key: 'revenue', label: 'Revenue', unit: 'USD', compact: true, align: 'right' },
        { key: 'share', label: 'Share', unit: 'percent', align: 'right' },
      ],
      rows: customers.map((c) => ({
        name: c.fact.label,
        revenue: c.fact.value_numeric,
        share: null,
      })),
    });
  },

  key_people(ctx, binder) {
    const people = binder.group('people.key_person.');
    if (!people.length) return { reason: 'No key-person dependencies have been recorded yet.' };
    return dataTable({
      caption: 'Key-person dependencies',
      columns: [
        { key: 'person', label: 'Person' },
        { key: 'holds', label: 'What they uniquely hold' },
      ],
      rows: people.map((p) => {
        const parts = String(p.fact.value_text ?? '').split(' uniquely holds: ');
        return { person: parts[0] ?? p.fact.label, holds: parts[1] ?? p.fact.value_text };
      }),
    });
  },

  use_of_funds(ctx, binder, widthMm) {
    const lines = binder.group('raise.use_of_funds.');
    if (!lines.length) return { reason: 'The use of funds has not been recorded yet.' };
    const total = lines.reduce((s, l) => s + (toNumber(l.fact.value_numeric) ?? 0), 0);
    return dataTable({
      caption: 'Use of funds',
      columns: [
        { key: 'item', label: 'Application' },
        { key: 'amount', label: 'Amount', unit: 'USD', align: 'right' },
      ],
      rows: [
        ...lines.map((l) => ({ item: l.fact.label, amount: l.fact.value_numeric })),
        { item: 'Total', amount: total, _kind: 'total' },
      ],
    });
  },

  kpi(ctx, binder) {
    const keys = ['financials.arr', 'metrics.nrr', 'metrics.churn', 'people.headcount']
      .filter((k) => binder.has(k));
    if (!keys.length) return { reason: 'No operating metrics have been confirmed yet.' };
    return dataTable({
      caption: 'Operating metrics',
      columns: [
        { key: 'metric', label: 'Metric' },
        { key: 'value', label: 'Latest', align: 'right' },
        { key: 'trend', label: 'Trend' },
      ],
      rows: keys.map((k) => {
        const points = binder.series(k);
        return {
          metric: binder.label(k),
          value: formatNumber(binder.number(k), { unit: binder.fact(k)?.unit, compact: true }),
          trend: points.length > 1 ? rawCell(sparkline(points.map((p) => p.value))) : null,
        };
      }),
    });
  },
};

CHARTS.forecast_variance = (ctx, binder, widthMm) => {
  const variances = [...(ctx.cadence?.variances ?? [])]
    .filter((v) => v.actual_value !== null && v.actual_value !== undefined)
    .sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));

  if (!variances.length) {
    return insufficientData('No periods have been closed against a forecast yet. '
      + 'This chart appears once there is a forecast and an actual to set against it.');
  }

  return barChart({
    categories: variances.map((v) => formatDate(v.period_end, { style: 'short' })),
    series: [
      { name: 'Forecast', values: variances.map((v) => toNumber(v.forecast_value)) },
      { name: 'Actual', values: variances.map((v) => toNumber(v.actual_value)) },
    ],
    unit: variances[0].unit ?? 'USD', width: 600, height: 280, widthMm,
  });
};

TABLES.forecast_cycles = (ctx) => {
  const cycles = ctx.cadence?.cycles ?? [];
  if (!cycles.length) {
    return { reason: 'No forecast has been locked yet. This is the record that cannot be produced '
                   + 'retrospectively, so the useful time to start keeping it is now.' };
  }
  return dataTable({
    caption: 'Forecast cycles',
    columns: [
      { key: 'label', label: 'Forecast' },
      { key: 'version', label: 'Version', align: 'right', numeric: true },
      { key: 'locked', label: 'Locked' },
      { key: 'basis', label: 'Built on' },
      { key: 'measured', label: 'Measured' },
    ],
    rows: cycles.map((c) => ({
      label: c.forecast.label,
      version: c.forecast.version,
      locked: c.forecast.locked_at ? formatDate(c.forecast.locked_at, { style: 'short' }) : null,
      basis: c.forecast.basis,
      measured: c.complete
        ? pill(`${c.variances.length} variance${c.variances.length === 1 ? '' : 's'}`, 'good')
        : pill('not yet', 'warn'),
    })),
    footnotes: ['A superseded forecast stays on this record. It was what the company believed at the '
      + 'time, and removing it would let a revision produce a cleaner history than actually happened.'],
  });
};

TABLES.variance_register = (ctx) => {
  const variances = ctx.cadence?.variances ?? [];
  if (!variances.length) return { reason: 'No periods have been closed against a forecast yet.' };

  return dataTable({
    caption: 'Variances against forecast',
    dense: true,
    columns: [
      { key: 'period', label: 'Period' },
      { key: 'metric', label: 'Metric' },
      { key: 'forecast', label: 'Forecast', unit: 'USD', compact: true, align: 'right' },
      { key: 'actual', label: 'Actual', unit: 'USD', compact: true, align: 'right' },
      { key: 'delta', label: 'Variance', unit: 'percent', align: 'right' },
      { key: 'band', label: '' },
      { key: 'explanation', label: 'Explanation' },
    ],
    rows: variances.map((v) => ({
      period: formatDate(v.period_end, { style: 'short' }),
      metric: v.fact_key,
      forecast: v.forecast_value,
      actual: v.actual_value,
      delta: v.delta_percent,
      band: pill(
        (v.materiality ?? '').replace('_', ' ').toLowerCase(),
        v.materiality === 'ON_PLAN' ? 'good' : v.materiality === 'MINOR' ? 'neutral'
          : v.materiality === 'MATERIAL' ? 'warn' : 'bad',
      ),
      // An unexplained material variance is named as such rather than left
      // blank. A blank cell reads as "nothing to say"; this one has something
      // to say and nobody has said it.
      explanation: v.explanation
        ?? (v.needs_explanation ? 'Not yet explained' : null),
    })),
    footnotes: ['Variance is measured against the forecast, not the outcome. The date an explanation '
      + 'was written is kept with it.'],
  });
};

// ─────────────────────────────────── generic, prefix-driven builders ──
//
// Most registers in a data room are the same shape: a set of named items with
// a value, stored as facts under a shared key prefix. Rather than thirteen
// near-identical builders — thirteen places for the same bug, the last of them
// written in a hurry — they are generated from a declaration.
//
// Where the underlying register is not modelled yet, the builder says so
// plainly. That is the honest state: the catalogue declares what a data room is
// expected to hold, and the product says which of it the company has given it
// the material to produce.

const PREFIX_TABLES = Object.freeze({
  cap_table: { prefix: 'cap_table.holder.', caption: 'Capitalisation table', valueLabel: 'Holding', unit: 'percent', total: true },
  waterfall: { prefix: 'cap_table.instrument.', caption: 'Instruments through to shares', valueLabel: 'Shares', unit: 'count' },
  options: { prefix: 'cap_table.option.', caption: 'Option ledger', valueLabel: 'Options', unit: 'count', total: true },
  contract_register: { prefix: 'legal.contract.', caption: 'Contract register', valueLabel: 'Annual value', unit: 'USD' },
  unit_economics: { prefix: 'metrics.', caption: 'Unit economics', valueLabel: 'Value', unit: null },
  revenue_by_segment: { prefix: 'financials.segment.', caption: 'Revenue by segment', valueLabel: 'Revenue', unit: 'USD', total: true },
  forecast_variance: { prefix: 'financials.forecast.', caption: 'Forecast against actual', valueLabel: 'Variance', unit: 'USD' },
  working_capital: { prefix: 'financials.working_capital.', caption: 'Working capital', valueLabel: 'Amount', unit: 'USD' },
  pipeline: { prefix: 'commercial.pipeline.', caption: 'Pipeline', valueLabel: 'Weighted value', unit: 'USD', total: true },
  cohorts: { prefix: 'metrics.cohort.', caption: 'Cohort retention', valueLabel: 'Retention', unit: 'percent' },
});

const PREFIX_CHARTS = Object.freeze({
  dilution: { prefix: 'cap_table.instrument.', type: 'bar', unit: 'count' },
  unit_economics: { prefix: 'metrics.', type: 'bar', unit: null },
  revenue_by_segment: { prefix: 'financials.segment.', type: 'bar', unit: 'USD' },
  forecast_variance: { prefix: 'financials.forecast.', type: 'bar', unit: 'USD' },
  working_capital: { prefix: 'financials.working_capital.', type: 'bar', unit: 'USD' },
  pipeline: { prefix: 'commercial.pipeline.', type: 'bar', unit: 'USD' },
  market: { prefix: 'market.', type: 'bar', unit: null },
  kpi_trend: { prefix: 'financials.arr', type: 'series', unit: 'USD' },
});

/** Registers with no data model behind them yet. Named, so nothing is silently absent. */
const NOT_MODELLED = Object.freeze({
  qa_log: 'The question-and-answer log is not modelled yet, so it cannot be generated. '
        + 'Keep it alongside the room until it is.',
  disclosures: 'The disclosure schedule is not modelled yet. It is drafted with your lawyer against the '
             + 'warranties in the sale agreement, so it is not something this product should generate.',
  diligence: 'No counterparty request list has been imported yet. Import one to track it here.',
  diligence_progress: 'No counterparty request list has been imported yet.',
});

// A purpose-built builder always wins over the generic fallback. Without this
// guard the loop silently overwrote the real forecast-variance chart with a
// prefix lookup that had nothing to find, and the document rendered a
// "nothing recorded" note next to a table full of the very data it wanted.
for (const [name, cfg] of Object.entries(PREFIX_TABLES)) {
  if (TABLES[name]) continue;
  TABLES[name] = (ctx, binder) => {
    const items = binder.group(cfg.prefix);
    if (!items.length) {
      return { reason: `Nothing has been recorded under ${cfg.prefix} yet, so ${cfg.caption.toLowerCase()} `
                     + 'cannot be produced. Nothing is invented to fill it.' };
    }
    const rows = items.map((i) => ({ item: i.fact.label, value: i.fact.value_numeric ?? i.fact.value_text }));
    if (cfg.total) {
      const total = items.reduce((sum, i) => sum + (toNumber(i.fact.value_numeric) ?? 0), 0);
      rows.push({ item: 'Total', value: total, _kind: 'total' });
    }
    return dataTable({
      caption: cfg.caption,
      columns: [
        { key: 'item', label: 'Item' },
        { key: 'value', label: cfg.valueLabel, unit: cfg.unit, align: 'right', numeric: true },
      ],
      rows,
    });
  };
}

for (const [name, cfg] of Object.entries(PREFIX_CHARTS)) {
  if (CHARTS[name]) continue;
  CHARTS[name] = (ctx, binder, widthMm) => {
    if (cfg.type === 'series') {
      const points = binder.series(cfg.prefix);
      if (points.length < 2) return insufficientData('Not enough periods recorded to draw a trend.');
      return lineChart({
        categories: points.map((p) => p.label),
        series: [{ name: binder.label(cfg.prefix), values: points.map((p) => p.value) }],
        unit: cfg.unit, width: 600, height: 260, widthMm,
      });
    }
    const items = binder.group(cfg.prefix).filter((i) => toNumber(i.fact.value_numeric) !== null);
    if (!items.length) {
      return insufficientData(`Nothing has been recorded under ${cfg.prefix} yet.`);
    }
    return barChart({
      categories: items.map((i) => i.fact.label),
      series: [{ name: cfg.prefix, values: items.map((i) => toNumber(i.fact.value_numeric)) }],
      unit: cfg.unit ?? items[0].fact.unit, width: 560, height: 260, widthMm,
    });
  };
}

for (const [name, reason] of Object.entries(NOT_MODELLED)) {
  if (!TABLES[name]) TABLES[name] = () => ({ reason });
  if (!CHARTS[name]) CHARTS[name] = () => insufficientData(reason);
}

/** Table and chart names a catalogue entry may reference. */
export const AVAILABLE_TABLES = Object.freeze(Object.keys(TABLES));
export const AVAILABLE_CHARTS = Object.freeze(Object.keys(CHARTS));

/**
 * Render one block descriptor.
 * `"CHART:concentration"` parses to `{ type: 'CHART', chart: 'concentration' }`.
 */
export function parseBlock(descriptor) {
  const [type, name] = String(descriptor).split(':');
  const block = { type, raw: descriptor };
  if (type === 'CHART') block.chart = name;
  if (type === 'TABLE') block.table = name;
  if (type === 'PROSE') block.slot = name ?? 'default';
  return block;
}

export function renderBlock(descriptor, ctx, binder) {
  const block = typeof descriptor === 'string' ? parseBlock(descriptor) : descriptor;
  const render = BLOCKS[block.type];
  if (!render) throw new BlockError('unknown_block', `no renderer for block type "${block.type}"`);
  return render(ctx, block, binder);
}

/** Stylesheet for every block above. */
export function blockCss() {
  return `${tableCss()}
  /* A cover is a page, not a paragraph at the top of one. */
  .cover-block{ display:flex; flex-direction:column; justify-content:flex-end; height:100%;
    padding-bottom:10mm; }
  .cover-title{ font-family:var(--display); font-size:${TYPE.displayXL}pt; line-height:1.05; margin:1mm 0 3mm; }
  .cover-sub{ font-family:var(--serif); font-size:${TYPE.headingM}pt; color:var(--muted); max-width:150mm; }
  .cover-meta{ font-family:var(--sans); font-size:${TYPE.caption}pt; color:var(--faint); }
  .section-head h2{ font-family:var(--display); font-size:${TYPE.displayM}pt; margin:0; }
  .kpi-row{ display:flex; gap:6mm; margin:4mm 0 5mm; }
  .kpi{ flex:1; border-left:1.6pt solid var(--accent-rule); padding-left:3mm; }
  .kpi-value{ font-size:${TYPE.displayM}pt; font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums; }
  .kpi-label{ font-size:${TYPE.caption}pt; color:var(--muted); margin-top:.6mm; }
  .kpi-period{ font-size:${TYPE.micro}pt; color:var(--faint); }
  .prose-heading{ font-family:var(--sans); font-size:${TYPE.headingL}pt; margin:0 0 3mm; color:var(--ink); }
  .prose{ font-family:var(--serif); font-size:${TYPE.body}pt; line-height:1.5; max-width:165mm; }
  .prose p{ margin:0 0 2.4mm; }
  /* On a slide the reader is further away and there is far more room. */
  .prose-slide{ font-size:${TYPE.headingM}pt; line-height:1.55; max-width:205mm; }
  .prose-slide p{ margin:0 0 3.4mm; }
  .chart-heading{ font-family:var(--sans); font-size:${TYPE.headingL}pt; margin:0 0 3mm; color:var(--ink); }
  .chart-group{ break-inside:avoid; page-break-inside:avoid; }
  figure.chart{ margin:3mm 0 4mm; }
  figure.chart figcaption{ font-family:var(--sans); font-size:${TYPE.micro}pt; color:var(--muted); margin-top:1mm; }
  .checklist{ margin:3mm 0; }
  .checklist-row{ display:flex; align-items:center; gap:3mm; padding:1.1mm 0; border-bottom:.35pt solid var(--rule); }
  .checklist-key{ font-family:var(--mono); font-size:${TYPE.micro}pt; color:var(--accent-text); width:8mm; }
  .checklist-name{ flex:1; font-size:${TYPE.bodyS}pt; }
  .checklist-bar{ width:40mm; height:2.2mm; background:var(--wash-neutral); border-radius:1.1mm; overflow:hidden; }
  .checklist-bar span{ display:block; height:100%; background:var(--accent); }
  .checklist-pct{ width:12mm; text-align:right; font-size:${TYPE.caption}pt; font-weight:700; }
  .evidence h3, .appendix h3{ font-family:var(--sans); font-size:${TYPE.headingS}pt; margin:4mm 0 2mm; }
  ol.citations{ margin:0; padding-left:5mm; font-size:${TYPE.caption}pt; }
  ol.citations li{ margin-bottom:2.4mm; }
  ol.citations .claim{ display:block; font-weight:700; color:var(--ink); }
  ol.citations .cite{ display:block; color:var(--body); }
  ol.citations .quote{ display:block; font-family:var(--serif); font-style:italic; color:var(--muted); }
  .appendix-note{ font-family:var(--serif); font-size:${TYPE.caption}pt; color:var(--muted); margin-bottom:2mm; }
  .disclaimer{ font-family:var(--sans); font-size:${TYPE.micro}pt; color:var(--muted);
    border-top:.4pt solid ${INK.rule}; padding-top:2mm; margin-top:4mm; }
  .disclaimer p{ margin:0 0 1.2mm; }
  .absent{ color:var(--faint); }
  `;
}
