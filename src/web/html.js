/**
 * The design system, as functions that return HTML strings.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE IDEA THIS INTERFACE IS BUILT AROUND
 *
 * **A figure is never shown naked.** Everywhere a number appears in this app it
 * carries where it came from, attached by a drawn hairline — the document, the
 * page, when a person confirmed it. A figure somebody typed carries a dashed
 * line instead of a solid one, and says so.
 *
 * That is the entire product in one component. The thesis is that a document
 * whose every figure traces to a source is worth more than one whose figures are
 * merely correct, and an interface that showed bare numbers in a grid of cards
 * would be arguing the opposite in the only language users actually read.
 *
 * Everything else is deliberately quiet: paper, ink, rules, and whitespace. The
 * boldness is spent in one place.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FOUR FACES, EACH WITH ONE JOB
 *
 * The brand carries four typefaces, and using all four as decoration would be
 * noise. Each has exactly one semantic job here:
 *
 *   Cinzel        the wordmark, and nowhere else
 *   Raleway       the working interface — every control, label and heading
 *   Source Code Pro   identifiers only: fact keys, references, document ids.
 *                     A fact key IS an identifier; setting it in a monospace is
 *                     information, not styling.
 *   Lora          not used in the app at all. It is the document face, and
 *                 keeping it there is what makes a generated document feel
 *                 like a different artefact from the tool that made it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ESCAPING
 *
 * `h` escapes. `raw` does not, and every call site that uses it is passing
 * markup this file produced. Interpolating anything from a user or a database
 * without `h` is the bug this layer exists to prevent, and `test/web.test.js`
 * checks the pages for it.
 */

import { sentenceFor } from './wording.js';
import { LEGAL_DOCUMENTS } from '../domain/legal.js';

/** The footer's links, in the order a reader expects them. */
const LEGAL_LINKS = LEGAL_DOCUMENTS.map(({ path, title }) => ({ path, title }));

export const h = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Marks a string as already-escaped markup. Purely a signal to a reader. */
export const raw = (markup) => String(markup ?? '');

const cls = (...names) => names.filter(Boolean).join(' ');

// ────────────────────────────────────────────────────────────── the shell ──

/**
 * The navigation, which is the data room's own index.
 *
 * Numbered, because a data room index genuinely is numbered and a counterparty
 * reads it in that order. The numbers here are not decoration standing in for
 * hierarchy — they are the same ordering the generated index uses.
 */
export const SECTIONS = Object.freeze([
  { key: 'overview', n: '00', label: 'Overview', href: '/org/:org' },
  { key: 'assessment', n: '01', label: 'Readiness', href: '/org/:org/readiness' },
  { key: 'gaps', n: '02', label: 'Gaps', href: '/org/:org/gaps' },
  { key: 'room', n: '03', label: 'Data room', href: '/org/:org/room' },
  { key: 'documents', n: '04', label: 'Documents', href: '/org/:org/documents' },
  { key: 'facts', n: '05', label: 'Figures', href: '/org/:org/facts' },
  { key: 'writing', n: '06', label: 'Writing', href: '/org/:org/writing' },
  { key: 'artifacts', n: '07', label: 'Documents out', href: '/org/:org/artifacts' },
  { key: 'cadence', n: '08', label: 'Forecasts', href: '/org/:org/cadence' },
  { key: 'sharing', n: '09', label: 'Sharing', href: '/org/:org/sharing' },
  { key: 'advisor', n: '10', label: 'Advisor', href: '/org/:org/advisor' },
  { key: 'valuation', n: '11', label: 'Valuation', href: '/org/:org/valuation' },
  { key: 'settings', n: '12', label: 'Settings', href: '/org/:org/settings' },
]);

export function layout({
  title, body, user = null, org = null, section = null, flash = null, wide = false,
  illustrative = false,
  // Script files this page needs, by path. Per page rather than on every page:
  // the product is server-rendered and exactly one page has behaviour that
  // cannot be done without script, so loading it everywhere would be loading it
  // for nothing on twenty-nine pages out of thirty.
  scripts = [],
}) {
  const nav = org
    ? `<nav class="rail" aria-label="Sections">
        <ol class="rail-list">
          ${SECTIONS.map((s) => {
    const href = s.href.replace(':org', org.id);
    const here = s.key === section;
    return `<li><a class="${cls('rail-link', here && 'is-here')}" href="${h(href)}"${
      here ? ' aria-current="page"' : ''}><span class="rail-n">${h(s.n)}</span>${h(s.label)}</a></li>`;
  }).join('')}
        </ol>
      </nav>`
    : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} — RaiseRoom</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#101F3F">
</head><body class="${cls(org && 'has-rail')}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="wordmark" href="/">
    <img class="wordmark-mark" src="/assets/brand/mark-gold-on-navy.svg" alt="" width="26" height="26">
    <span class="wordmark-text">RaiseRoom</span>
  </a>
  ${org ? `<span class="top-org">${h(org.name)}</span>` : ''}
  <div class="top-end">
    ${user
    ? `<span class="top-user">${h(user.email)}</span>
       <form method="post" action="/sign-out" class="inline">
         ${csrfField(user.csrf)}<button class="link-button" type="submit">Sign out</button>
       </form>`
    : '<a class="link-button" href="/sign-in">Sign in</a>'}
  </div>
</header>
${nav}
<main id="main" class="${cls('main', wide && 'is-wide')}">
  ${illustrative ? illustrativeBar() : ''}
  ${flash ? banner(flash) : ''}
  ${raw(body)}
</main>
${siteFooter()}
${scripts.map((src) => `<script src="${h(src)}" defer></script>`).join('')}
</body></html>`;
}

/**
 * The page a counterparty sees.
 *
 * Deliberately not the app's own layout with the chrome removed. A reader who
 * follows a link is not a user of this product — they are somebody being shown
 * a company's file, and the page should read as a document the company provided
 * rather than as a tool they are briefly inside. So: no index rail, no account,
 * no wordmark link into the app, and the company's name where the product's
 * would otherwise be.
 *
 * The watermark is in the markup rather than painted over it. A reader who
 * prints or saves the page takes the attribution with them, which is the only
 * thing a watermark is actually for — and the product says plainly elsewhere
 * that it is a deterrent and a way to trace a leak, not protection.
 */
export function sharedLayout({
  title, body, company = null, watermark = null, flash = null, illustrative = false,
}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${h(title)}${company ? ` — ${h(company)}` : ''}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#101F3F">
</head><body class="is-shared">
<a class="skip" href="#main">Skip to content</a>
<header class="top top-shared">
  <span class="wordmark">${h(company ?? 'Provided in confidence')}</span>
  ${watermark ? `<span class="top-end mark">
    <span class="mark-line">${h(watermark.line1)}</span>
    <span class="mark-line mark-faint">${h(watermark.line2)}</span>
  </span>` : ''}
</header>
<main id="main" class="main">
  ${illustrative ? illustrativeBar() : ''}
  ${flash ? banner(flash) : ''}
  ${raw(body)}
</main>
${watermark ? `<footer class="mark-footer"><p>${h(watermark.footer)}</p></footer>` : ''}
</body></html>`;
}

/**
 * The notice on a worked-example organisation.
 *
 * On every page, in the same place, above everything else. The alternative — one
 * notice on a landing page — relies on the reader having arrived through the
 * front door and remembering, and a screenshot of a single page taken out of
 * context is exactly how invented figures end up quoted as real ones.
 */
export const illustrativeBar = () => `<div class="illus" role="note">
  <p><strong>Illustrative example.</strong> Not a real company, client, engagement, or performance
  result. All names, figures, workflows, and outcomes are invented for teaching purposes.</p>
</div>`;

export const csrfField = (token) =>
  `<input type="hidden" name="csrf" value="${h(token)}">`;

// ───────────────────────────────────────────── the signature: a figure ──

/**
 * A figure, with where it came from.
 *
 * `source` is the fact's own source enum. A document-backed figure gets a solid
 * hairline; one somebody typed gets a dashed one and says so, because the
 * difference between "confirmed from the accounts" and "somebody told us" is the
 * difference this product sells.
 */
export function figure({ value, label = null, source = null, from = null, unit = null }) {
  const traced = source === 'USER_CONFIRMED';
  const calculated = source === 'CALCULATED';

  const origin = from
    || (traced ? 'Confirmed from a document'
      : source === 'USER_ENTERED' ? 'Entered by hand, no document behind it'
        : calculated ? 'Calculated from other figures'
          : source === 'DOCUMENT_EXTRACTED' ? 'Read from a document, not yet confirmed'
            : null);

  return `<span class="${cls('figure', traced && 'is-traced', calculated && 'is-calculated',
    source === 'DOCUMENT_EXTRACTED' && 'is-unconfirmed')}">
    ${label ? `<span class="figure-label">${h(label)}</span>` : ''}
    <span class="figure-value tnum">${h(value)}${unit ? `<span class="figure-unit">${h(unit)}</span>` : ''}</span>
    ${origin ? `<span class="figure-source">${h(origin)}</span>` : ''}
  </span>`;
}

/** A fact key or reference. Monospace because it is an identifier. */
export const ref = (value) => `<code class="ref">${h(value)}</code>`;

// ──────────────────────────────────────────────────────────── components ──

/**
 * The site footer.
 *
 * On every page, which is the point. The terms and the privacy policy both have
 * to be reachable from the footer of every page, from sign-up and from the plan
 * pages — so the footer that is already on every page is the one place that
 * satisfies all three at once, rather than three links somebody has to remember
 * to add to a fourth page later.
 *
 * `/subprocessors` is linked because the privacy policy names it as the
 * authoritative list. A policy pointing at a page nobody linked is a policy
 * pointing at a page nobody maintains.
 *
 * The paths come from `src/domain/legal.js`, so there is one list of them.
 */
function siteFooter() {
  const links = LEGAL_LINKS
    .map(({ path, title }) => `<a href="${h(path)}">${h(title)}</a>`)
    .join('');
  return `<footer class="site-foot">
  <nav aria-label="Legal">${links}</nav>
  <p>RaiseRoom is a product of TekAIDA.</p>
</footer>`;
}

export function page({ title, lede = null, actions = null, body }) {
  return `<div class="page-head">
    <h1>${h(title)}</h1>
    ${lede ? `<p class="lede">${h(lede)}</p>` : ''}
    ${actions ? `<div class="page-actions">${raw(actions)}</div>` : ''}
  </div>
  ${raw(body)}`;
}

export function section({ title, note = null, body, id = null }) {
  return `<section class="block"${id ? ` id="${h(id)}"` : ''}>
    <h2>${h(title)}</h2>
    ${note ? `<p class="note">${h(note)}</p>` : ''}
    ${raw(body)}
  </section>`;
}

/**
 * A record in a list — a fact, a gap, a document.
 *
 * A left border in a state colour rather than a card. Cards would give every
 * record the same weight and the same shadow; a rule costs nothing and carries
 * the state.
 */
export function record({ title, meta = null, body = null, state = null, actions = null, href = null }) {
  const inner = `
    <div class="record-main">
      ${href ? `<a class="record-title" href="${h(href)}">${h(title)}</a>`
    : `<span class="record-title">${h(title)}</span>`}
      ${meta ? `<span class="record-meta">${h(meta)}</span>` : ''}
      ${body ? `<div class="record-body">${raw(body)}</div>` : ''}
    </div>
    ${actions ? `<div class="record-actions">${raw(actions)}</div>` : ''}`;
  return `<div class="${cls('record', state && `state-${state}`)}">${inner}</div>`;
}

/** A state, in a word. Never only a colour — the same rule the charts follow. */
export function pill(label, tone = 'neutral') {
  return `<span class="pill pill-${h(tone)}">${h(label)}</span>`;
}

export function table({ columns, rows, caption = null, empty = 'Nothing here yet.' }) {
  if (!rows.length) return emptyState({ says: empty });
  return `${caption ? `<h3 class="table-caption">${h(caption)}</h3>` : ''}
  <div class="table-scroll"><table class="data">
    <thead><tr>${columns.map((c) =>
    `<th class="${h(c.align ?? 'left')}">${h(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${columns.map((c) =>
    `<td class="${h(c.align ?? 'left')}">${c.raw ? raw(row[c.key] ?? '') : h(row[c.key] ?? '—')}</td>`)
    .join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

/**
 * An empty screen is an invitation to act, not a shrug.
 *
 * So it takes what to do next, and most callers give it one.
 */
export function emptyState({ says, action = null }) {
  return `<div class="empty"><p>${h(says)}</p>${action ? raw(action) : ''}</div>`;
}

export function banner({ tone = 'info', says, detail = null }) {
  return `<div class="banner banner-${h(tone)}" role="${tone === 'error' ? 'alert' : 'status'}">
    <p>${h(says)}</p>${detail ? `<p class="banner-detail">${h(detail)}</p>` : ''}
  </div>`;
}

/**
 * A refusal from the service layer, shown as the service layer wrote it.
 *
 * The messages below this web layer were written to be read by a person —
 * they say what happened and what to do — so the interface shows them rather
 * than replacing them with "Something went wrong."
 */
export function refusal(err) {
  const extra = [];
  if (err?.problems?.length) {
    for (const p of err.problems) extra.push(p.problem ?? p.says ?? String(p));
  }
  if (err?.still_yours?.says) extra.push(err.still_yours.says);
  if (err?.available_in?.length) extra.push(`Available in: ${err.available_in.join(', ')}.`);

  // The code is for machines. `sentenceFor` is what a person reads; the code
  // stays on the page, quietly and in the identifier face, because somebody
  // writing in for help needs a word to quote.
  return `<div class="banner banner-error" role="alert">
    <p>${h(sentenceFor(err))}</p>
    ${extra.map((e) => `<p class="banner-detail">${h(e)}</p>`).join('')}
    ${err?.code ? `<p class="banner-code"><code>${h(err.code)}</code></p>` : ''}
  </div>`;
}

// ──────────────────────────────────────────────────────────────── forms ──

export function form({ action, method = 'post', csrf, body, submit = 'Save', compact = false, data = {} }) {
  // `data-*` attributes only, and the names are escaped like everything else.
  // The document upload form carries `data-upload`, which is how the script at
  // /assets/upload.js finds the one form it is allowed to intercept — a marker
  // on the form rather than a selector in the script, so a new form does not
  // silently acquire upload behaviour.
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${h(k)}${v === true ? '' : `="${h(v)}"`}`).join('');
  return `<form class="${cls('form', compact && 'is-compact')}" method="${h(method)}" action="${h(action)}"${attrs}>
    ${csrfField(csrf)}
    ${raw(body)}
    <div class="form-actions"><button class="button" type="submit">${h(submit)}</button></div>
  </form>`;
}

export function field({ name, label, type = 'text', value = '', hint = null, required = false,
  placeholder = '', autocomplete = null, step = null }) {
  const id = `f-${name}`;
  return `<div class="field">
    <label for="${h(id)}">${h(label)}</label>
    ${hint ? `<p class="hint" id="${h(id)}-hint">${h(hint)}</p>` : ''}
    <input id="${h(id)}" name="${h(name)}" type="${h(type)}" value="${h(value)}"
      ${required ? 'required' : ''} ${placeholder ? `placeholder="${h(placeholder)}"` : ''}
      ${autocomplete ? `autocomplete="${h(autocomplete)}"` : ''}
      ${step ? `step="${h(step)}"` : ''}
      ${hint ? `aria-describedby="${h(id)}-hint"` : ''}>
  </div>`;
}

export function textarea({ name, label, value = '', hint = null, rows = 6, placeholder = '' }) {
  const id = `f-${name}`;
  return `<div class="field">
    <label for="${h(id)}">${h(label)}</label>
    ${hint ? `<p class="hint" id="${h(id)}-hint">${h(hint)}</p>` : ''}
    <textarea id="${h(id)}" name="${h(name)}" rows="${h(rows)}"
      ${placeholder ? `placeholder="${h(placeholder)}"` : ''}
      ${hint ? `aria-describedby="${h(id)}-hint"` : ''}>${h(value)}</textarea>
  </div>`;
}

export function select({ name, label, options, value = '', hint = null }) {
  const id = `f-${name}`;
  return `<div class="field">
    <label for="${h(id)}">${h(label)}</label>
    ${hint ? `<p class="hint">${h(hint)}</p>` : ''}
    <select id="${h(id)}" name="${h(name)}">
      ${options.map((o) => `<option value="${h(o.value)}"${o.value === value ? ' selected' : ''}>${
    h(o.label)}</option>`).join('')}
    </select>
  </div>`;
}

/** A button that posts one action. Used in lists, where a full form would be noise. */
export function action({ href = null, label, csrf = null, confirm = null, tone = 'quiet' }) {
  if (href) return `<a class="button button-${h(tone)}" href="${h(href)}">${h(label)}</a>`;
  return `<form method="post" action="${h(confirm)}" class="inline">${csrfField(csrf)}
    <button class="button button-${h(tone)}" type="submit">${h(label)}</button></form>`;
}


// ───────────────────────────────────────────────────────────── stylesheet ──

/**
 * One stylesheet, served from the app.
 *
 * Not inline: the content-security policy forbids inline script and the style
 * rule is kept tight for the same reason. Fonts are served from the app too, so
 * nothing on a page reaches a third party — which in a product holding somebody's
 * diligence file is a privacy property, not a performance one.
 */
export function stylesheet() {
  return `
@font-face{font-family:'Cinzel';src:url('/assets/fonts/Cinzel-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
@font-face{font-family:'Raleway';src:url('/assets/fonts/Raleway-Regular.ttf') format('truetype');font-weight:400;font-display:swap}
@font-face{font-family:'Raleway';src:url('/assets/fonts/Raleway-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
@font-face{font-family:'Source Code Pro';src:url('/assets/fonts/SourceCodePro-Regular.ttf') format('truetype');font-weight:400;font-display:swap}

:root{
  /* THE IDENTITY, as delivered in assets/brand/PALETTE.txt. The four brand
     values are named once here and everything below is expressed in terms of
     them, so a recolour is this block and a colour literal further down the
     file is a bug.

     The one rule that shapes the rest: gold is an accent and never type. It
     reaches 2.1:1 against the cream ground, which is a soft rule and an
     unreadable word, so gold draws marks, rules and fills, and burgundy
     carries the interactive text instead. */
  --navy:#101F3F; --gold:#C9A227; --cream:#F4EFE4; --burgundy:#6E1F33;

  --paper:var(--cream); --ink:var(--navy); --ink-muted:#44506E; --ink-faint:#5F6A86;
  --rule:#DDD4C2; --rule-firm:#B5A88C; --accent:var(--gold); --wash:#EBE3D3;
  --link:var(--burgundy);
  /* Type on a navy ground: the top bar, and nothing else so far. */
  --on-navy:var(--cream); --on-navy-muted:#B9C0D1;
  --positive:#1C6E45; --negative:var(--burgundy); --caution:#7A5E00;
  --ui:'Raleway',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace;
  --display:'Cinzel',Georgia,serif;
  --rail-w:13.5rem;
  /* The ground is the brand's cream rather than white. The documents this tool
     produces are still white — a deck is printed on paper — and that difference
     is deliberate: the tool and the artefact it makes should not look like the
     same object. Declaring the scheme stops a browser in dark mode from
     rendering form controls dark against it, which is the one place the choice
     would have leaked out as a bug. */
  color-scheme:light;
}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:var(--ui); font-size:16px; line-height:1.55;
}
.tnum{font-variant-numeric:tabular-nums}

.skip{position:absolute;left:-9999px;top:0;background:var(--ink);color:var(--on-navy);padding:.5rem .75rem;z-index:10}
.skip:focus{left:.5rem;top:.5rem}

/* ── top bar ───────────────────────────────────────────────────────────── */
/* A navy ground under a gold rule — the one place the identity is stated at
   full strength, and the reason the rest of the page can stay quiet. The rule
   is 2px because a gold hairline on navy is a suggestion of a rule. */
.top{
  display:flex; align-items:baseline; gap:1rem; flex-wrap:wrap;
  padding:1rem 1.5rem; background:var(--navy); color:var(--on-navy);
  border-bottom:2px solid var(--gold);
}
/* The mark is the delivered artwork placed beside the name, rather than the
   lockup file: the wordmark stays live text, so it is selectable, searchable
   and readable to a screen reader, and the artwork is used as the file it
   arrived as instead of being re-drawn in path data. The <img> carries no alt
   because the name is right beside it — announcing it twice is worse than not
   announcing it at all. */
.wordmark{
  font-family:var(--display); font-weight:700; font-size:1.25rem;
  letter-spacing:.02em; color:var(--on-navy); text-decoration:none;
  display:inline-flex; align-items:center; gap:.5rem;
}
.wordmark-mark{display:block; width:1.625rem; height:1.625rem}
.top-org{color:var(--on-navy-muted); font-size:.875rem}
.top-end{margin-left:auto; display:flex; align-items:baseline; gap:1rem}
.top-user{color:var(--on-navy-muted); font-size:.8125rem}
/* Sign in and sign out sit in the navy bar, where the burgundy they are given
   below is barely a colour at all. */
.top .link-button{color:var(--on-navy)}

/* ── the site footer ──────────────────────────────────────────────────────
   On every page. Quiet enough to ignore while reading and findable when
   somebody goes looking for the terms, which is the only time anybody looks
   at a footer at all. */
.site-foot{
  /* The same 1.5rem side padding .main uses, so the footer's first link sits
     under the page's first word rather than a few pixels off it. */
  border-top:1px solid var(--rule); margin-top:3rem; padding:1.5rem 1.5rem 2.5rem;
  font-size:.85rem; color:var(--ink-faint);
}
.site-foot nav{display:flex; flex-wrap:wrap; gap:1.25rem; margin-bottom:.75rem}
.site-foot a{color:var(--ink-muted)}
.site-foot p{margin:0}
/* The rail is a grid column, so the footer has to be told to span both or it
   sits under the navigation and beside nothing.

   48rem is THE breakpoint in this file: below it the rail is a scrolling strip
   of tabs and the page is one column, at or above it the rail is a sidebar and
   the page is a grid. 768px is an iPad held upright, which is the narrowest
   screen with room for a 13.5rem sidebar and a readable measure beside it.
   Three rules depend on it and they have to move together. */
@media (min-width:48rem){
  body.has-rail > .site-foot{grid-column:1/-1}
}

/* ── a published legal document ───────────────────────────────────────────
   Measured for reading rather than for print: the generated-document styles
   in stylesheet() are sized in millimetres for a renderer, and a privacy
   policy is read on a phone. */
.legal{max-width:42rem}
.legal h2{margin:2rem 0 .5rem; font-size:1.25rem}
.legal h3{margin:1.5rem 0 .5rem; font-size:1.05rem}
.legal p,.legal li{line-height:1.6}
.legal ul,.legal ol{margin:.5rem 0 1rem; padding-left:1.25rem}
.legal li{margin-bottom:.35rem}
.legal table{width:100%; border-collapse:collapse; margin:1rem 0; font-size:.9rem}
.legal th,.legal td{border:1px solid var(--rule); padding:.5rem .6rem; text-align:left; vertical-align:top}
.legal th{background:var(--wash)}
.legal blockquote{
  margin:1rem 0; padding:.1rem 0 .1rem 1rem; border-left:3px solid var(--rule); color:var(--ink-muted);
}
.legal hr{border:0; border-top:1px solid var(--rule); margin:2rem 0}
.legal code{font-family:var(--mono); font-size:.9em}
/* A wide sub-processor table should scroll rather than push the page sideways —
   tools/proof-web.mjs reports horizontal overflow and this is where it would
   come from. */
@media (max-width:40rem){
  .legal table{display:block; overflow-x:auto}
}

/* ── the index rail ────────────────────────────────────────────────────── */
.rail{border-right:1px solid var(--rule)}
.rail-list{list-style:none; margin:0; padding:1rem 0; }
.rail-link{
  display:flex; gap:.6rem; align-items:baseline;
  padding:.3rem 1.5rem; color:var(--ink-muted); text-decoration:none; font-size:.875rem;
  border-left:2px solid transparent;
}
.rail-link:hover{color:var(--ink); background:var(--wash)}
.rail-link.is-here{color:var(--ink); border-left-color:var(--accent); font-weight:700}
.rail-n{font-family:var(--mono); font-size:.75rem; color:var(--ink-faint)}
/* ── the rail on a phone ──────────────────────────────────────────────────
   Below the breakpoint the rail is not a sidebar, because there is no side.
   Stacked, it is thirteen rows of navigation above the content on every single
   page — the reader scrolls past the index to reach the thing they opened.

   So it turns on its side and becomes a strip of tabs that scrolls on its own,
   which is the one place in this interface where horizontal scrolling is right:
   it is an index, an index is read along, and the alternative is pushing the
   page itself sideways. The marker moves from the left edge to the underside
   for the same reason — a left border on a horizontal tab marks nothing.

   'overscroll-behavior-x:contain' stops a swipe that runs off the end of the
   strip from being taken as a back gesture by the browser. */
@media (max-width:47.99rem){
  .rail{
    border-right:0; border-bottom:1px solid var(--rule);
    overflow-x:auto; overscroll-behavior-x:contain;
  }
  .rail-list{display:flex; padding:0}
  .rail-link{
    border-left:0; border-bottom:2px solid transparent;
    padding:.65rem .85rem; white-space:nowrap;
  }
  .rail-link.is-here{border-left-color:transparent; border-bottom-color:var(--accent)}
}

/* ── layout ────────────────────────────────────────────────────────────── */
.main{padding:2rem 1.5rem 5rem; max-width:62rem}
.main.is-wide{max-width:none}
@media (min-width:48rem){
  body.has-rail{display:grid; grid-template-columns:var(--rail-w) 1fr; grid-template-rows:auto 1fr}
  body.has-rail > .top{grid-column:1/-1}
  body.has-rail > .rail{grid-row:2; min-height:100%}
  body.has-rail > .main{grid-row:2}
}
/* 1.5rem of gutter on each side is right on a laptop and is a seventh of a
   phone screen spent on nothing. The footer's side padding is deliberately the
   same number as the main column's, so that the footer's first link sits under
   the page's first word — the two move together or that stops being true. */
@media (max-width:47.99rem){
  .main{padding:1.5rem 1rem 3.5rem}
  .site-foot{padding:1.25rem 1rem 2rem}
}

/* ── type ──────────────────────────────────────────────────────────────── */
h1{font-size:1.75rem; line-height:1.2; margin:0 0 .25rem; font-weight:700; letter-spacing:-.01em}
h2{font-size:1.125rem; margin:0 0 .5rem; font-weight:700}
h3{font-size:1rem; margin:0 0 .5rem; font-weight:700}
p{margin:0 0 .75rem; max-width:66ch}
.lede{color:var(--ink-muted); max-width:62ch; margin-bottom:1rem}
.note{color:var(--ink-muted); font-size:.875rem; max-width:62ch}
.hint{color:var(--ink-muted); font-size:.8125rem; margin:.1rem 0 .35rem; max-width:62ch}
/* Burgundy, not gold. Gold is the accent the brand sheet gives for marks and
   rules, and a gold link on cream is a word the reader cannot make out. */
a{color:var(--link)}
a:hover{color:var(--ink)}

.page-head{margin-bottom:1.75rem; padding-bottom:1rem; border-bottom:1px solid var(--rule)}
.page-actions{display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.75rem}
.block{margin:0 0 2.5rem}
/* A button offered on its own between two sections — "Export everything",
   "Transcribe the workbook" — is an inline-block with no margin of its own, so
   the next heading lands against it. Spaced here rather than by wrapping every
   such call site in a div. */
.banner + .button,.empty + .button{margin-bottom:.5rem}
/* A section carries its spacing below itself, which is right between sections
   and wrong after anything else — a table, a banner or a row of records ran
   straight into the next heading with no gap at all. */
.button + .block,.button + h2,.table-scroll + .block,.banner + .block,
.record + .block,.row + .block,.empty + .block,.form + .block{margin-top:2.25rem}

/* ── THE FIGURE: the one bold thing ────────────────────────────────────── */
.figure{display:inline-block; margin:0 1.25rem .9rem 0; vertical-align:top}
.figure-label{display:block; font-size:.75rem; color:var(--ink-muted)}
.figure-value{display:block; font-size:1.5rem; font-weight:700; line-height:1.15; letter-spacing:-.01em}
.figure-unit{font-size:.75em; color:var(--ink-muted); margin-left:.15em}
/* 2px, not the hairline this was when the accent was a purple at 5.5:1 against
   a white page. The accent is now gold on cream, which is 2.1:1 — a 1px gold
   line on this ground is nearly not there, and this line is the one component
   the whole interface is built around. Widened for every state rather than for
   the traced one alone, so that width stays free of meaning: what distinguishes
   the three is still colour and dash pattern. */
.figure-source{
  display:block; position:relative; margin-top:.3rem; padding-left:.7rem;
  font-size:.75rem; color:var(--ink-muted);
  border-left:2px solid var(--rule-firm);
}
.figure-source::before{
  content:''; position:absolute; left:0; top:.6em; width:.45rem;
  border-top:2px solid var(--rule-firm);
}
.figure.is-traced .figure-source{border-left-color:var(--accent); color:var(--ink-muted)}
.figure.is-traced .figure-source::before{border-top-color:var(--accent)}
.figure.is-calculated .figure-source{border-left-style:dotted}
.figure.is-calculated .figure-source::before{border-top-style:dotted}
.figure.is-unconfirmed .figure-value{color:var(--caution)}
.figure.is-unconfirmed .figure-source{border-left-style:dashed; border-left-color:var(--caution); color:var(--caution)}
.figure.is-unconfirmed .figure-source::before{border-top-style:dashed; border-top-color:var(--caution)}

.ref{font-family:var(--mono); font-size:.8125em; color:var(--ink-muted); word-break:break-all}

/* ── records ───────────────────────────────────────────────────────────── */
.record{
  display:flex; gap:1rem; align-items:flex-start; justify-content:space-between;
  padding:.7rem 0 .7rem .85rem; border-bottom:1px solid var(--rule);
  border-left:2px solid var(--rule);
}
.record:hover{background:var(--wash)}
.record.state-done{border-left-color:var(--positive)}
.record.state-blocked{border-left-color:var(--negative)}
.record.state-attention{border-left-color:var(--caution)}
.record.state-active{border-left-color:var(--accent)}
.record-main{min-width:0}
.record-title{font-weight:700; display:block}
a.record-title{text-decoration:none; color:var(--ink)}
a.record-title:hover{color:var(--link)}
.record-meta{display:block; font-size:.8125rem; color:var(--ink-muted)}
.record-body{margin-top:.35rem; font-size:.875rem}
.record-actions{display:flex; gap:.4rem; flex:0 0 auto; flex-wrap:wrap}
/* A record puts its controls beside its title, which stops being possible on a
   phone: the data room's "not applicable" row carries a reason field as well as
   a button, and that pair alone is wider than the screen. Because the actions
   are 'flex:0 0 auto' they refused to shrink and pushed the whole page sideways
   — 46px of horizontal scroll on /room, the only overflow in the app.
   Below the breakpoint the record stacks instead, and the field inside it is
   allowed to shrink. 'min-width:0' is the half of that which is easy to miss:
   an input carries an intrinsic width from its 'size' attribute and will not go
   below it otherwise. */
@media (max-width:47.99rem){
  .record{flex-direction:column; gap:.5rem}
  .record-actions{width:100%}
  .record-actions form.inline{display:flex; gap:.4rem; width:100%}
  .record-actions input{min-width:0; flex:1 1 auto}
}

/* ── pills ─────────────────────────────────────────────────────────────── */
.pill{
  display:inline-block; font-size:.75rem; font-weight:700; padding:.08rem .45rem;
  border:1px solid var(--rule-firm); color:var(--ink-muted); white-space:nowrap;
}
.pill-good{border-color:var(--positive); color:var(--positive)}
.pill-bad{border-color:var(--negative); color:var(--negative)}
.pill-warn{border-color:var(--caution); color:var(--caution)}
.pill-active{border-color:var(--accent); color:var(--link)}

/* ── tables ────────────────────────────────────────────────────────────── */
.table-scroll{overflow-x:auto}
table.data{width:100%; border-collapse:collapse; font-size:.875rem}
table.data th{
  text-align:left; font-size:.6875rem; letter-spacing:.04em; text-transform:uppercase;
  color:var(--ink-faint); font-weight:700; padding:0 .6rem .35rem 0;
  border-bottom:1px solid var(--rule-firm); white-space:nowrap;
}
table.data td{padding:.5rem .6rem .5rem 0; border-bottom:1px solid var(--rule); vertical-align:top}
table.data .right{text-align:right; font-variant-numeric:tabular-nums}
.table-caption{margin:1.25rem 0 .5rem}

/* ── forms ─────────────────────────────────────────────────────────────── */
/* 34rem is a readable measure for a form somebody fills in from their head.
   is-compact is for a form inside a list row, and is-sheet for one being copied
   off paper, where the label is the thing being read and needs the room. */
.form{max-width:34rem; margin:0 0 1.5rem}
.form.is-compact,.form.is-sheet{max-width:none}
.form.is-sheet .field input:not([type=number]),.form.is-sheet .field select,
.form.is-sheet .field textarea{max-width:34rem}
.field{margin-bottom:1rem}
.field label{display:block; font-weight:700; font-size:.875rem; margin-bottom:.15rem}
input,textarea,select{
  width:100%; font:inherit; font-size:.9375rem; padding:.45rem .55rem;
  border:1px solid var(--rule-firm); background:var(--paper); color:var(--ink); border-radius:0;
}
textarea{line-height:1.5; resize:vertical}
input:focus,textarea:focus,select:focus,button:focus,a:focus{
  /* Navy rather than the accent, and offset clear of the control: a focus ring
     has to be seen on both grounds, and gold is 2.1:1 on the cream one. */
  outline:2px solid var(--ink); outline-offset:2px;
}
.form-actions{display:flex; gap:.5rem; align-items:center; margin-top:1rem}

.button{
  display:inline-block; font:inherit; font-size:.875rem; font-weight:700;
  padding:.4rem .8rem; border:1px solid var(--ink); background:var(--ink); color:var(--on-navy);
  cursor:pointer; text-decoration:none; border-radius:0;
}
/* Gold fill, navy type: 6.7:1, and the one place gold carries a word — a
   16px label on a fill, which is not body text. */
.button:hover{background:var(--accent); border-color:var(--accent); color:var(--navy)}
.button-quiet{background:transparent; color:var(--ink); border-color:var(--rule-firm)}
.button-quiet:hover{border-color:var(--accent); color:var(--link); background:transparent}
.button-danger{background:transparent; color:var(--negative); border-color:var(--negative)}
.button-danger:hover{background:var(--negative); color:var(--on-navy)}
.link-button{
  background:none; border:0; padding:0; font:inherit; font-size:.8125rem;
  color:var(--link); cursor:pointer; text-decoration:underline;
}
.inline{display:inline}

/* ── banners and empty states ──────────────────────────────────────────── */
.banner{padding:.7rem .9rem; margin:0 0 1.5rem; border-left:3px solid var(--rule-firm); background:var(--wash)}
.banner p{margin:0; max-width:70ch}
.banner-detail{font-size:.875rem; color:var(--ink-muted); margin-top:.3rem !important}
.banner-code{margin-top:.4rem !important}
.banner-code code{font-family:var(--mono); font-size:.6875rem; color:var(--ink-faint)}
.banner-error{border-left-color:var(--negative); background:#F6EAEC}
.banner-good{border-left-color:var(--positive); background:#ECF4EE}
.banner-warn{border-left-color:var(--caution); background:#F7EFD9}

/* ── a generated document, shown as what it is ─────────────────────────── */
/* The one place in the interface with a shadow. A generated document is a
   different kind of object from the tool that made it — it will be printed,
   attached, and read by somebody who has never seen this app — and lifting it
   off the page is the cheapest way to say so. Everything else here is flat. */
/* The surround behind a preview of a generated page. A shade of the ground
   rather than the ground itself, because what sits inside it is white paper and
   the frame exists to show that the paper is white. */
.paper-frame{background:#E6DECD; padding:1.5rem; border:1px solid var(--rule)}
/* The grey mount is what says "this is a different kind of object". On a phone
   it was 48px of a 343px screen spent making that point, around a document that
   then had 246px to be read in. The point survives at 4px a side; the rest goes
   to the document. It is still an A4 page in a narrow window — that is the
   shape of the thing, not a layout fault — and the reader scrolls it inside its
   own frame rather than dragging the page about underneath it. */
@media (max-width:47.99rem){
  .paper-frame{padding:.25rem}
}
.paper{
  display:block; width:100%; height:min(80vh,56rem); border:0;
  background:var(--paper); box-shadow:0 1px 3px rgba(0,0,0,.18);
}

.illus{
  margin:0 0 1.5rem; padding:.55rem .9rem; border:1px solid var(--ink);
  background:var(--paper); font-size:.8125rem;
}
.illus p{margin:0; max-width:none}

.empty{padding:1.75rem 0; color:var(--ink-muted); border-top:1px solid var(--rule)}
.empty p{margin:0 0 .75rem}
/* The page head already draws a rule under itself, so an empty state as the
   first thing on a page drew a second one a few pixels below it. */
.page-head + .empty,.block > .empty:first-child{border-top:0; padding-top:.25rem}

.grid{display:grid; gap:1.5rem; grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}
.row{display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start}

/* ── two records side by side, neither preferred ───────────────────────── */
/* The conflict page and the translation page both show two versions of the
   same thing and must not imply a verdict. So the two columns are identical:
   same width, same weight, same rule. A highlight on either one would be the
   product taking a side it has no business taking. */
.sides{display:grid; gap:1rem; grid-template-columns:1fr; margin:.5rem 0 .75rem}
@media (min-width:44rem){.sides{grid-template-columns:1fr 1fr}}
.side{padding-left:.75rem; border-left:1px solid var(--rule-firm)}
.side-head{
  font-size:.6875rem; letter-spacing:.04em; text-transform:uppercase;
  color:var(--ink-faint); margin:0 0 .25rem;
}
.side p{margin:0; max-width:52ch}
.passage{font-size:.875rem}

/* ── fieldsets ─────────────────────────────────────────────────────────── */
fieldset.block{border:0; padding:0; margin:0 0 2rem; min-width:0}
fieldset.block legend{padding:0; margin-bottom:.5rem}

/* ── the transcription grid ────────────────────────────────────────────── */
/* Thirty-two boxes being copied off paper. Two columns on a laptop so the eye
   travels down a short column rather than across a wide one, and the label
   stays full-length because a truncated criterion is a box filled in wrong. */
.grid-scores{display:grid; gap:.75rem 1.5rem; grid-template-columns:1fr}
@media (min-width:52rem){.grid-scores{grid-template-columns:1fr 1fr}}
.field.is-tight{margin-bottom:0}
.field.is-tight label{font-weight:400; font-size:.8125rem}
.field.is-tight input{max-width:5rem}
.row-fields{display:grid; gap:.5rem 1rem; grid-template-columns:1fr; margin-bottom:1rem}
@media (min-width:44rem){.row-fields{grid-template-columns:1fr 1fr 1fr}}
.row-fields .field{margin-bottom:0}

/* ── a drafted message, shown as text to be copied ─────────────────────── */
pre.draft{
  font-family:var(--mono); font-size:.8125rem; line-height:1.5; white-space:pre-wrap;
  margin:0 0 .75rem; padding:.75rem; border:1px solid var(--rule); background:var(--wash);
  max-width:72ch; overflow-x:auto;
}
.link-out{word-break:break-all}
.write-own{margin-top:.5rem}
.write-own summary{font-size:.8125rem; color:var(--link); cursor:pointer}
.write-own summary:hover{color:var(--ink)}
.button-solid{background:var(--ink); color:var(--on-navy); border-color:var(--ink)}

/* ── the counterparty's page ───────────────────────────────────────────── */
/* No rail, so the content is centred and narrower: this is a document being
   read, not a tool being worked. The attribution sits in the markup top and
   bottom so that printing or saving the page takes it along — which is the only
   thing a watermark actually achieves, and the product says so in words. */
body.is-shared .main{margin:0 auto; max-width:54rem}
/* The counterparty's page is the company's, not the product's: the navy bar and
   the mark belong to RaiseRoom, so this header reverts to the light ground with
   the company's own name in it. */
.top-shared{
  background:var(--paper); color:var(--ink); border-bottom:1px solid var(--ink);
}
.top-shared .wordmark{color:var(--ink)}
.mark{text-align:right; font-size:.75rem; line-height:1.3}
.mark-line{display:block}
.mark-faint{color:var(--ink-faint)}
.mark-footer{
  border-top:1px solid var(--rule); padding:.75rem 1.5rem;
  font-size:.75rem; color:var(--ink-muted);
}
.mark-footer p{margin:0; max-width:none}
/* ── touch ────────────────────────────────────────────────────────────────
   Two triggers, because width alone is the wrong question and pointer alone is
   not testable. A touchscreen laptop is wide and still being prodded with a
   finger, which 'pointer:coarse' catches and a width query does not; and a
   browser being driven by a script reports a fine pointer whatever size it is,
   which is how a rule like this goes unverified for a year. Below the
   breakpoint the screen is a phone often enough that the larger controls are
   right there anyway, so the two conditions sit side by side.

   44px is the figure both platform guidelines land on. It is applied by
   padding rather than by 'height', so a control that wraps onto two lines still
   grows instead of clipping what is inside it. A mouse on a desktop-width
   window matches neither condition and sees none of this. */
@media (pointer:coarse),(max-width:47.99rem){
  .button{padding:.65rem .9rem}
  /* px, not rem, and deliberately: 44 is a measurement of a fingertip, not of
     this page's type. A select does not take padding the way a text input does
     — the control is drawn by the platform — so it is given the floor directly
     rather than being padded towards it and left short. */
  input,textarea,select,.button,.link-button{min-height:44px}
  input,textarea,select{padding:.6rem .6rem}
  /* Buttons that are styled as text — "Sign out", "Remove" — have no padding
     by design, so they get their hit area vertically and keep their baseline. */
  .link-button{padding:.75rem 0}
  .site-foot a{display:inline-block; padding:.75rem 0}
  .site-foot nav{gap:.25rem 1.25rem}
  .write-own summary{padding:.6rem 0}
}

@media print{
  .skip,.rail,.top-end form{display:none}
  .mark-footer{position:fixed; bottom:0; left:0; right:0}
}

@media (prefers-reduced-motion:reduce){*{animation:none !important; transition:none !important}}
`;
}
