/**
 * Serving the four legal documents, and what to say when one is not there.
 *
 * The same shape as `src/web/advisor.js` and `src/web/mail.js`: a capability
 * this deployment may or may not have, named out loud rather than faked. The
 * rules about what may be published are in `src/domain/legal.js`, pure and
 * tested without a file system; this file is the part that touches disk.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHERE THE TEXT COMES FROM
 *
 * `LEGAL_DIR`, which defaults to `docs/legal/published/`. The documents are not
 * in this repository and should not be — `docs/legal/README.md` explains why,
 * and the short version is that a committed copy of a living document is the
 * copy that goes stale. So a deployment exports them, strips the working notes,
 * fills the four sub-processor names, and drops four Markdown files in one
 * directory.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVERY REQUEST READS THE FILE
 *
 * No cache. These are four pages that get a handful of views a day, and the
 * alternative is a deployment where somebody fixes a clause, sees the old text,
 * and restarts the application to publish a typo fix. A disk read per view is
 * the cheaper mistake by a wide margin.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE STATES, AND WHY "REFUSED" IS NOT AN ERROR
 *
 *   published — the file is there and passes the rules. Served.
 *   absent    — no file. The page says the document is not published yet and
 *               names the path it will be served from, because the person
 *               most likely to be reading it is whoever has to put it there.
 *   refused   — the file is there and still contains working notes or an
 *               unfilled placeholder. NOT served, and the page says which.
 *
 * `refused` is the state this module exists for. The failure it prevents is not
 * a crash; it is a privacy policy going live with `[email provider]` in its
 * sub-processor table, which is the one thing on the page a reviewer is certain
 * to check. A 500 would be wrong — nothing is broken — and serving it anyway
 * would be worse.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { documentFor, publishability, renderLegalMarkdown } from '../domain/legal.js';

/** Where the documents live, unless a deployment says otherwise. */
export const DEFAULT_LEGAL_DIR = 'docs/legal/published';

export const legalDirFor = (ctx) => ctx?.legalDir ?? DEFAULT_LEGAL_DIR;

/**
 * Load one document and decide what the page shows.
 *
 * Returns a state rather than throwing: all three outcomes are ordinary, and a
 * route that has to catch an exception to render a page it was always going to
 * render is a route that eventually catches the wrong one.
 */
export function legalDocument(ctx, key) {
  const document = documentFor(key);
  if (!document) return null;

  const dir = legalDirFor(ctx);
  const file = join(dir, document.file);

  if (!existsSync(file)) {
    return {
      document,
      state: 'absent',
      html: null,
      problems: [],
      // Absolute, because the person reading this is looking for the directory.
      expectedAt: resolve(file),
    };
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return {
      document,
      state: 'absent',
      html: null,
      problems: [{ code: 'unreadable', says: `The file for this document could not be read (${err.code}).` }],
      expectedAt: resolve(file),
    };
  }

  const { publishable, problems } = publishability(text);
  if (!publishable) {
    return { document, state: 'refused', html: null, problems, expectedAt: resolve(file) };
  }

  return {
    document,
    state: 'published',
    html: renderLegalMarkdown(text),
    problems: [],
    expectedAt: resolve(file),
  };
}

/** What a page says when a document is not published yet. */
export const NOT_PUBLISHED = {
  says: 'This document is not published on this deployment yet.',
  detail: 'The four legal documents are written and are kept outside this repository, because they are '
        + 'edited in review and a copy committed to the application is the copy that goes stale. A '
        + 'deployment publishes them by exporting each one as Markdown into the legal directory. Until '
        + 'then this page says so rather than showing nothing.',
};

/** What a page says when a document is there but may not be published. */
export const NOT_PUBLISHABLE = {
  says: 'This document is not being served, because it is not ready to publish.',
  detail: 'It still contains something that has to come out first — see below. This is deliberate: a '
        + 'policy published with an unfilled sub-processor name, or with the notes written to the '
        + 'company rather than to the reader, is worse than a page that says it is not ready.',
};
