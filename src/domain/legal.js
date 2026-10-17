/**
 * The published legal documents, and the rules about publishing them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY NO LEGAL TEXT LIVES IN THIS REPOSITORY
 *
 * `docs/legal/README.md` is explicit about it: the four documents are living
 * documents that get edited in review, and a copy committed here is the copy
 * that goes stale first. Meanwhile `raiseroom.app/terms` has to serve something,
 * and the privacy policy names `raiseroom.app/subprocessors` as the
 * authoritative list — so the text has to reach the deployment without being
 * compiled into it.
 *
 * So: the deployment supplies Markdown files in one directory, and this module
 * holds the rules about what may be served from it. The repository knows the
 * four documents exist, where each belongs, and what disqualifies one from
 * being published. It does not know a word of their contents.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY MARKDOWN IS ESCAPED FIRST AND RENDERED SECOND
 *
 * The files are operator-supplied rather than user-supplied, so this is not the
 * usual injection story. It is the quieter one: a legal document exported from
 * a word processor contains angle brackets and ampersands in ordinary prose —
 * "contracts for <$10,000", "Smith & Co" — and a renderer that passes those
 * through produces a page that silently loses a clause to a browser's parser.
 * Escaping first and rendering a known subset second means the worst case is
 * ugly rather than wrong, and a clause cannot vanish.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A DOCUMENT CAN BE REFUSED
 *
 * Two things in `docs/legal/README.md` have to happen before publication, and
 * both are the kind of thing that gets forgotten at 6pm on a Friday:
 *
 *   1. The working notes come out. Each document contains sections addressed to
 *      the client rather than to the customer — "A note for you, not for the
 *      terms", "What still needs a person", "Decisions a person still needs to
 *      make". Publishing those is a disclosure of the company's own
 *      deliberations on the page a reviewer reads most carefully.
 *
 *   2. The four placeholders get real names — hosting, email, model provider,
 *      and whether Whop is the only payment party. A privacy policy published
 *      with `[email provider]` in its sub-processor table is worse than one not
 *      published at all: it is a public admission that nobody checked.
 *
 * Neither can be enforced by asking people to remember. So a document carrying
 * either is REFUSED rather than served, the page says which document and why,
 * and the deployment's own smoke test catches it before a customer does.
 */

export class LegalError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * The four documents, their URLs, and what each one is for.
 *
 * Frozen, and the single source of the URL each lives at. The landing page in
 * `docs/landing/index.html` already links all four by these exact paths, and
 * the privacy policy names `/subprocessors` in its own text — so a path changed
 * here without changing those is a broken link on the page a reviewer checks.
 */
export const LEGAL_DOCUMENTS = Object.freeze([
  Object.freeze({
    key: 'terms',
    path: '/terms',
    file: 'terms.md',
    title: 'Terms of service',
    linked: 'Footer of every page, sign-up, and checkout',
  }),
  Object.freeze({
    key: 'privacy',
    path: '/privacy',
    file: 'privacy.md',
    title: 'Privacy policy',
    linked: 'Footer, sign-up',
  }),
  Object.freeze({
    key: 'dpa',
    path: '/dpa',
    file: 'dpa.md',
    title: 'Data processing addendum',
    linked: 'Footer, and offered by name in any enterprise sales conversation',
  }),
  Object.freeze({
    key: 'subprocessors',
    path: '/subprocessors',
    file: 'subprocessors.md',
    title: 'Sub-processors',
    // The privacy policy calls this page the authoritative list, which is why
    // it cannot be the one page nobody got round to.
    linked: 'Named by the privacy policy and the addendum as the authoritative list',
  }),
]);

export const documentFor = (key) => LEGAL_DOCUMENTS.find((d) => d.key === key) ?? null;

/**
 * Phrases that mean a document still has working notes in it.
 *
 * Matched case-insensitively against the whole file. Deliberately the exact
 * headings `docs/legal/README.md` names, rather than anything cleverer: a
 * heuristic that tries to detect "notes to the client" in general would fire on
 * a legitimate clause and teach everybody to ignore it.
 */
export const WORKING_NOTE_MARKERS = Object.freeze([
  'a note for you, not for the terms',
  'a note for you, not for the policy',
  'a note for you, not for the addendum',
  'what still needs a person',
  'decisions a person still needs to make',
]);

/**
 * Placeholders that must be filled before publication.
 *
 * The first four are the ones the privacy policy and the addendum carry in
 * their sub-processor tables. The hosting region is the fifth, and it is in the
 * same list because it is the same kind of mistake.
 */
export const PLACEHOLDERS = Object.freeze([
  '[hosting provider]',
  '[email provider]',
  '[model provider]',
  '[payment party]',
  '[hosting region]',
]);

/**
 * May this text be published?
 *
 * Pure: takes the text, returns what is wrong with it. No file system, no
 * request, no clock — so every rule above is testable without a deployment.
 */
export function publishability(text) {
  const body = String(text ?? '');
  const problems = [];

  if (!body.trim()) {
    problems.push({
      code: 'empty',
      says: 'The file for this document is empty.',
    });
    return { publishable: false, problems };
  }

  const lower = body.toLowerCase();

  for (const marker of WORKING_NOTE_MARKERS) {
    if (lower.includes(marker)) {
      problems.push({
        code: 'working_notes',
        says: `This document still contains a section headed "${marker}", which is written to the `
          + 'company rather than to the reader. It has to come out before the document is published.',
      });
    }
  }

  for (const placeholder of PLACEHOLDERS) {
    if (lower.includes(placeholder.toLowerCase())) {
      problems.push({
        code: 'placeholder',
        says: `This document still contains the placeholder ${placeholder}. Publishing a policy with `
          + 'an unfilled sub-processor name is a public admission that nobody checked it.',
      });
    }
  }

  return { publishable: problems.length === 0, problems };
}

// ──────────────────────────────────────────────────────────────── rendering ──

const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Inline markup, applied to text that is ALREADY escaped.
 *
 * The order matters: code spans first, so that a backticked `**` is not read as
 * emphasis, and links before emphasis so that an underscore inside a URL stays
 * in the URL.
 *
 * A link's href is checked rather than trusted. `javascript:` in a legal
 * document would be remarkable, but the check costs one line and the
 * alternative is a content-security-policy report nobody reads.
 */
function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => (
      /^(https?:|mailto:|\/)/i.test(href) ? `<a href="${href}">${label}</a>` : whole
    ))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, (_, before, em) => `${before}<em>${em}</em>`);
}

const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isDivider = (row) => /^\|?[\s:-]+\|[\s:|-]*$/.test(row.trim()) && row.includes('-');

/**
 * Render the Markdown subset a legal document actually uses.
 *
 * Headings, paragraphs, bullet and numbered lists, tables, block quotes,
 * horizontal rules, and the inline marks above. Not a general Markdown
 * implementation and not trying to be: anything it does not understand comes
 * out as the escaped text of a paragraph, which is legible and loses nothing.
 */
export function renderLegalMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];

  let paragraph = [];
  let list = null;      // 'ul' | 'ol'
  let quoting = false;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(esc(paragraph.join(' ')))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const closeQuote = () => {
    if (!quoting) return;
    out.push('</blockquote>');
    quoting = false;
  };
  const closeAll = () => { closeParagraph(); closeList(); closeQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { closeAll(); continue; }

    // A table, recognised by its divider row rather than by its first row —
    // a line with pipes in it is not a table, and a legal document contains
    // plenty of those.
    if (trimmed.includes('|') && isDivider(lines[i + 1] ?? '')) {
      closeAll();
      const header = cells(trimmed);
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        rows.push(cells(lines[i + 1]));
        i += 1;
      }
      out.push('<table><thead><tr>'
        + header.map((c) => `<th>${inline(esc(c))}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>');
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAll();
      // Shifted by one: the page's own `<h1>` is the document's title, so a
      // document's `#` is an `<h2>` here. Two `<h1>`s on a page is a thing
      // screen readers announce and nobody intends.
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeAll(); out.push('<hr>'); continue; }

    if (trimmed.startsWith('>')) {
      closeParagraph(); closeList();
      if (!quoting) { out.push('<blockquote>'); quoting = true; }
      out.push(`<p>${inline(esc(trimmed.replace(/^>\s?/, '')))}</p>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      closeParagraph(); closeQuote();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline(esc((bullet ?? numbered)[1]))}</li>`);
      continue;
    }

    closeList(); closeQuote();
    paragraph.push(trimmed);
  }

  closeAll();
  return out.join('\n');
}
