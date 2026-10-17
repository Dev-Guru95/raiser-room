/**
 * Document assembly: the page itself.
 *
 * Artifacts are HTML with inline SVG, rendered to PDF by headless Chromium.
 * That combination gives real typographic control, vector output at any size,
 * and a document that stays sharp when someone prints it at A3 and puts it on a
 * wall — which a rasterised chart does not.
 *
 * Fonts are embedded as data URIs rather than linked. A linked font that fails
 * to load does not raise an error; it silently falls back, and the first anyone
 * knows is a deck set in Times New Roman arriving at an investor.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BRAND, INK, FONTS, TYPE, PAGE, SERIES } from './theme.js';

const here = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(here, '..', '..', 'tools', 'fonts');

const FACES = [
  { family: 'Cinzel', file: 'Cinzel-Bold.ttf', weight: 700, style: 'normal' },
  { family: 'Lora', file: 'Lora.ttf', weight: 400, style: 'normal' },
  { family: 'Lora', file: 'Lora-Bold.ttf', weight: 700, style: 'normal' },
  { family: 'Lora', file: 'Lora-Italic.ttf', weight: 400, style: 'italic' },
  { family: 'Raleway', file: 'Raleway-Regular.ttf', weight: 400, style: 'normal' },
  { family: 'Raleway', file: 'Raleway-Bold.ttf', weight: 700, style: 'normal' },
  { family: 'Raleway', file: 'Raleway-Light.ttf', weight: 300, style: 'normal' },
  { family: 'Source Code Pro', file: 'SourceCodePro-Regular.ttf', weight: 400, style: 'normal' },
];

let fontCss = null;

/** Embed the brand faces. Cached, because a deck renders them once per document. */
export function fontFaceCss({ embed = true } = {}) {
  if (fontCss !== null && embed) return fontCss;

  const blocks = [];
  const missing = [];

  for (const face of FACES) {
    const path = join(FONT_DIR, face.file);
    if (!existsSync(path)) { missing.push(face.file); continue; }
    const src = embed
      ? `url(data:font/ttf;base64,${readFileSync(path).toString('base64')}) format('truetype')`
      : `url('file://${path}') format('truetype')`;
    blocks.push(
      `@font-face{font-family:'${face.family}';font-weight:${face.weight};`
      + `font-style:${face.style};font-display:block;src:${src};}`,
    );
  }

  if (missing.length) {
    // Loud rather than silent. A missing face means the document would render
    // in a fallback and look like a different company's.
    throw new Error(`brand fonts missing from tools/fonts: ${missing.join(', ')}`);
  }

  const css = blocks.join('');
  if (embed) fontCss = css;
  return css;
}

/**
 * The CSS custom properties the rest of the stylesheet is written against.
 *
 * `brand` is a derived token set from `domain/brand.js` — never raw user input.
 * The derivation is what guarantees the accent clears the contrast floors; a
 * supplied colour passed straight in here would put an unreadable eyebrow label
 * on every page, which is the whole reason that module exists.
 *
 * `--blade` stays TekAIDA's own purple and nothing else. It is deliberately NOT
 * repointed at the customer's accent: one name meaning "our purple" in some
 * documents and "whatever this company uses" in others is how a product ends up
 * printing the wrong company's colour and nobody being able to say why. The
 * stylesheet uses `--accent`.
 */
export function tokensCss(brand = null) {
  const t = brand?.tokens ?? brand ?? {};
  const accent = t.accent ?? BRAND.blade;
  return `:root{
    --onyx:${BRAND.onyx}; --white:${t.page ?? BRAND.white}; --blade:${BRAND.blade}; --steel:${BRAND.steel};
    --accent:${accent}; --accent-text:${t.accent_text ?? accent}; --accent-rule:${t.accent_rule ?? accent};
    --ink:${t.ink ?? INK.primary}; --body:${INK.body}; --muted:${INK.muted}; --faint:${INK.faint};
    --rule:${INK.rule}; --rule-strong:${INK.ruleStrong}; --wash:${t.wash ?? INK.wash}; --wash-neutral:${INK.washNeutral};
    --display:${FONTS.display}; --serif:${FONTS.serif}; --sans:${FONTS.sans}; --mono:${FONTS.mono};
    ${(t.palette?.length ? t.palette : SERIES.map((s) => s.hex))
    .map((hex, i) => `--series-${i + 1}:${hex};`).join('')}
  }`;
}

/**
 * Base stylesheet.
 *
 * `print-color-adjust: exact` is load-bearing: without it a browser helpfully
 * strips background fills when printing, and every filled chart element
 * disappears. The failure is silent and looks like a design decision.
 */
export function baseCss(size = 'slide') {
  const page = PAGE[size] ?? PAGE.slide;
  return `
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    font-family:var(--sans); font-size:${TYPE.body}pt; color:var(--body);
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
    text-rendering:geometricPrecision;
  }
  @page{size:${page.width}mm ${page.height}mm; margin:0;}
  h1,h2,h3,h4{margin:0; font-weight:700; color:var(--ink);}
  p{margin:0 0 ${TYPE.body * 0.6}pt;}
  svg{display:block;}
  .tnum{font-variant-numeric:tabular-nums;}
  .page{
    width:${page.width}mm; height:${page.height}mm; padding:${page.margin}mm;
    position:relative; overflow:hidden; background:var(--white);
    break-after:page; page-break-after:always;
  }
  .page:last-child{break-after:auto; page-break-after:auto;}
  /* A slide is a fixed box. Whatever is on it is centred vertically, so three
     lines of prose sit in the middle of the frame rather than clinging to the
     top edge with two-thirds of the slide empty below them. */
  .page.slide-page{display:flex; flex-direction:column; justify-content:center;}
  .page.slide-page > *{flex:0 0 auto;}
  .page-flow{break-after:auto; page-break-after:auto; height:auto; min-height:${page.height}mm;}
  .chart-missing{
    border:0.6pt dashed var(--rule-strong); background:var(--wash-neutral);
    padding:6mm; border-radius:2pt;
  }
  .chart-missing p{
    font-family:var(--serif); font-size:${TYPE.bodyS}pt; font-style:italic;
    color:var(--muted); margin:0;
  }
  .eyebrow{
    font-family:var(--mono); font-size:${TYPE.micro}pt; letter-spacing:.08em;
    text-transform:uppercase; color:var(--accent-text); margin:0 0 2mm;
  }
  .rule{height:0; border-top:1pt solid var(--accent-rule); margin:2mm 0 4mm;}
  .hairline{height:0; border-top:.4pt solid var(--rule); margin:3mm 0;}
  .footnote{font-family:var(--sans); font-size:${TYPE.micro}pt; color:var(--muted);}
  sup.cite{font-size:${TYPE.micro - 1}pt; color:var(--accent-text); font-weight:700; padding-left:.4mm;}
  .running-foot{
    position:absolute; left:${page.margin}mm; right:${page.margin}mm; bottom:${Math.max(page.margin / 2, 6)}mm;
    display:flex; justify-content:space-between; align-items:baseline;
    font-family:var(--sans); font-size:${TYPE.micro}pt; color:var(--faint);
    border-top:.4pt solid var(--rule); padding-top:1.5mm;
  }
  /* The illustrative-example notice, on every page of an example document.
     Sits above the running footer, boxed rather than greyed: a notice in the
     same faint grey as a page number reads as furniture, and this one has to
     be read by somebody who has only ever seen this page. Full width so the
     sentence is never truncated, and it carries ink rather than colour so it
     survives a black-and-white print — which is how a deck in a meeting gets
     looked at. */
  .illus-note{
    position:absolute; left:${page.margin}mm; right:${page.margin}mm;
    bottom:${Math.max(page.margin / 2, 6) + 5}mm;
    margin:0; padding:1mm 1.5mm; border:.5pt solid var(--ink);
    font-family:var(--sans); font-size:${TYPE.micro}pt; line-height:1.25;
    color:var(--ink);
  }
  `;
}

/** Everything that goes in <head>. */
export function documentHead({ title, size = 'slide', extraCss = '', embedFonts = true, brand = null } = {}) {
  return `<meta charset="utf-8"><title>${escapeHtml(title ?? 'Document')}</title>
<style>${fontFaceCss({ embed: embedFonts })}${tokensCss(brand)}${baseCss(size)}${extraCss}</style>`;
}

/** A full HTML document. */
export function htmlDocument({ title, size = 'slide', body, extraCss = '', embedFonts = true, brand = null }) {
  return `<!doctype html><html lang="en"><head>${
    documentHead({ title, size, extraCss, embedFonts, brand })
  }</head><body>${body}</body></html>`;
}

/**
 * One page or slide.
 *
 * `notice` is the illustrative-example notice, and it sits above the running
 * footer rather than inside it. In the footer it would compete with the page
 * number for the same line and get truncated by the flex layout on a narrow
 * slide — and a truncated version of this particular sentence is worse than
 * none, because "Illustrative example. Not a real company, client…" trailing
 * off reads as a caption rather than a warning.
 */
export function page(content, { className = '', foot = null, flow = false, notice = null } = {}) {
  const classes = ['page', flow ? 'page-flow' : '', className].filter(Boolean).join(' ');
  return `<section class="${classes}">${content}${
    notice ? `<p class="illus-note">${escapeHtml(notice)}</p>` : ''
  }${
    foot ? `<div class="running-foot"><span>${foot.left ?? ''}</span><span>${foot.right ?? ''}</span></div>` : ''
  }</section>`;
}

export const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
