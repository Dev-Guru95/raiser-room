/**
 * The four legal pages.
 *
 * Public, and they have to be: a policy a reader must sign in to read is not a
 * published policy, and `docs/landing/index.html` already links all four by
 * these exact paths.
 *
 * These handlers decide nothing, as rule 11 requires. The rules about what may
 * be published are in `src/domain/legal.js` and the disk is `src/web/legal.js`;
 * this file maps a path to one of three states and renders what it is handed.
 */

import { layout, page, banner, section, h, raw } from '../html.js';
import { LEGAL_DOCUMENTS } from '../../domain/legal.js';
import { legalDocument, NOT_PUBLISHED, NOT_PUBLISHABLE } from '../legal.js';

/**
 * One route per document, built from the frozen list rather than written out
 * four times — so a document added to the list gets a page, and a path changed
 * in one place changes in both.
 */
export const legalRoutes = LEGAL_DOCUMENTS.map((entry) => ({
  path: entry.path,
  method: 'GET',
  auth: false,
  handle: ({ ctx, user }) => {
    const loaded = legalDocument(ctx, entry.key);
    const shell = (body, status = 200) => ({
      status,
      html: layout({ title: loaded.document.title, user: user ?? null, body }),
    });

    if (loaded.state === 'published') {
      return shell(page({
        title: loaded.document.title,
        // `legal` rather than `prose`: the document's own headings start at
        // h2 and its tables are wide, and the generated-document styles are
        // sized for print rather than for reading on a phone.
        body: `<div class="legal">${raw(loaded.html)}</div>`,
      }));
    }

    if (loaded.state === 'refused') {
      // 503 rather than 404 or 500. The document exists and the route works;
      // what is missing is a step somebody has to take before it may be
      // served, which is exactly what "unavailable" means.
      return shell(page({
        title: loaded.document.title,
        body: banner({ tone: 'warn', says: NOT_PUBLISHABLE.says, detail: NOT_PUBLISHABLE.detail })
          + section({
            title: 'What has to come out first',
            note: `Read from ${loaded.expectedAt}`,
            body: `<ul>${loaded.problems.map((p) => `<li>${h(p.says)}</li>`).join('')}</ul>`,
          }),
      }), 503);
    }

    return shell(page({
      title: loaded.document.title,
      body: banner({ tone: 'info', says: NOT_PUBLISHED.says, detail: NOT_PUBLISHED.detail })
        + section({
          title: 'Where this page reads from',
          note: 'Export the document as Markdown, strip the sections written to the company, fill the '
              + 'sub-processor names, and put it here.',
          body: `<p><code>${h(loaded.expectedAt)}</code></p>`,
        }),
    }), 404);
  },
}));
