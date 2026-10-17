/**
 * The bytes: viewing a generated document, downloading a source one, and
 * loading the worked example.
 *
 * These three sit together because they are the routes that deal in actual
 * files rather than in rows, and they share the one decision that matters here:
 * which content-security policy a set of bytes is served under.
 */

import * as artifacts from '../../api/artifacts.js';
import * as svc from '../../api/service.js';
import * as seed from '../../api/seed.js';
import { shell, attempt } from './shell.js';
import { page, section, record, banner, action, field, csrfField, h } from '../html.js';

export const documentRoutes = [
  /**
   * A generated document, rendered.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE POLICY ON THIS ROUTE IS THE WHOLE ROUTE
   *
   * This serves a full HTML document — one this application generated, with its
   * own stylesheet and its own inline SVG charts — inside the app's own origin.
   * Served under the app's ordinary policy it would be a page with access to the
   * app's cookies. Served from a different origin it would need a second
   * deployment to be worth anything.
   *
   * So it is served under a policy of its own: `sandbox` with no tokens, which
   * drops the document into an opaque origin with no script, no forms and no
   * same-origin access, plus `default-src 'none'` so it cannot fetch anything at
   * all. `style-src 'unsafe-inline'` is required because a generated document
   * carries its print stylesheet inline, and under `sandbox` that inline style
   * can do nothing but lay out the page it is in.
   *
   * The result renders exactly as it will print and can reach nothing.
   */
  {
    path: '/org/:org/artifacts/:artifact/view', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts' });
      if (!s.ok) return s.response;

      const r = attempt(s, () => artifacts.readGenerated(req.ctx, s.org.id, req.params.artifact));
      if (!r.ok) return r.response;

      const { html, artifact } = r.value.body;
      if (!html) {
        return s.render('Not stored', page({
          title: artifact.title,
          body: banner({
            tone: 'warn',
            says: 'This document was generated before file storage was configured, so the file itself '
                + 'is not here.',
            detail: 'Regenerating it will produce the current version, which is a different document '
                  + 'from the one this row records — the figures may have moved since.',
          }) + `<p><a href="/org/${s.org.id}/artifacts">Back to documents out</a></p>`,
        }));
      }

      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: {
          'Content-Security-Policy':
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
          // Set here because the app-wide header allows framing from nowhere,
          // and this document is shown in a frame by the page below.
          'X-Frame-Options': 'SAMEORIGIN',
          'Cache-Control': 'private, no-store',
        },
        html,
      };
    },
  },

  /**
   * The page around the document.
   *
   * The document itself is in a frame, which keeps the two policies apart: the
   * app's page can run its own code and the document can run none.
   */
  {
    path: '/org/:org/artifacts/:artifact', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts', wide: true });
      if (!s.ok) return s.response;

      const r = attempt(s, () => artifacts.readGenerated(req.ctx, s.org.id, req.params.artifact));
      if (!r.ok) return r.response;
      const { artifact, superseded, stale, stale_since: staleSince, staleness, html } = r.value.body;

      const refs = artifact.fact_refs ?? [];
      const citations = artifact.citations ?? [];

      return s.render(artifact.title, page({
        title: artifact.title,
        lede: `${refs.length} figure${refs.length === 1 ? '' : 's'}, each one a reference into your `
            + `fact store. ${citations.length} external source${citations.length === 1 ? '' : 's'} cited.`,
        actions: [
          action({ href: `/org/${s.org.id}/artifacts/${artifact.id}/view`, label: 'Open on its own', tone: 'quiet' }),
          superseded
            ? ''
            : action({
              href: `/org/${s.org.id}/artifacts/${artifact.id}/regenerate`,
              label: 'See what would change', tone: 'quiet',
            }),
          action({ href: `/org/${s.org.id}/artifacts`, label: 'Back to documents out', tone: 'quiet' }),
        ].join(''),
        body: (superseded
          ? banner({
            tone: 'warn',
            says: 'A newer version of this document has been generated.',
            detail: 'This one is kept exactly as it was, because somebody may be holding it. It was '
                  + 'not changed when the newer one was made.',
          })
          : '')
          + (stale && !superseded
            ? banner({
              tone: 'warn',
              says: `Figures behind this document have changed${staleSince ? ` since ${String(staleSince).slice(0, 10)}` : ''}.`,
              detail: (staleness?.length
                ? `${staleness.map((x) => x.means).filter(Boolean).join(' ')} `
                : '')
                + 'What you are reading is exactly what was sent. Regenerate before sending it again.',
            })
            : '')
          + (html
            ? `<div class="paper-frame"><iframe title="${h(artifact.title)}" class="paper"
                 src="/org/${s.org.id}/artifacts/${h(artifact.id)}/view"
                 sandbox referrerpolicy="no-referrer" loading="lazy"></iframe></div>`
            : banner({
              tone: 'warn',
              says: 'The file for this document is not in storage, so there is nothing to show.',
              detail: 'Regenerate it to produce the current version.',
            }))
          // Recording that a version went out is what makes staleness mean
          // something. Without it the product cannot tell a stale draft nobody
          // has seen from a stale document in an investor's inbox, and those
          // deserve completely different warnings.
          + (artifact.released_at
            ? section({
              title: 'Sent',
              body: record({
                title: `Sent on ${String(artifact.released_at).slice(0, 10)}`,
                meta: artifact.released_note ?? '',
                state: 'done',
              }),
            })
            : section({
              title: 'Has this gone out?',
              note: 'Recorded with a note, because "sent to whom" is the first question anybody asks '
                  + 'when a figure in it moves later, and that is a bad moment to be reconstructing '
                  + 'it from memory.',
              body: `<form class="form is-compact" method="post" action="/org/${s.org.id}/artifacts/${h(artifact.id)}/release">
                  ${csrfField(s.csrf)}
                  ${field({
    name: 'note', label: 'Who it went to',
    placeholder: 'Emailed to the investment committee at …',
  })}
                  <div class="form-actions">
                    <button class="button button-quiet" type="submit">Mark as sent</button>
                  </div>
                </form>`,
            })),
      }));
    },
  },

  /**
   * A signed download link for a source document.
   *
   * A redirect rather than a proxy: the URL is issued by the service layer,
   * which authorises first, and the bytes then come from storage directly. The
   * same shape works when storage is a bucket on the other side of the world.
   */
  {
    path: '/org/:org/documents/:document/download', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;

      const storage = req.ctx.storage;
      if (!storage) {
        return s.render('No storage', page({
          title: 'No file storage',
          body: banner({
            tone: 'warn',
            says: 'This deployment has no file storage configured, so documents are registered but '
                + 'their contents are not kept.',
          }) + `<p><a href="/org/${s.org.id}/documents">Back</a></p>`,
        }));
      }

      const r = attempt(s, () =>
        svc.createDownloadUrl(req.ctx, s.org.id, req.params.document, storage));
      if (!r.ok) return r.response;

      const { download, document } = r.value.body;
      if (!storage.has?.(req.ctx.db.get('document', req.params.document).storage_key)) {
        return s.render(document.filename, page({
          title: document.filename,
          body: banner({
            tone: 'warn',
            says: 'This document is registered, but no file was ever uploaded against it.',
            detail: 'In the worked example that is deliberate — there is no real set of accounts to '
                  + 'put here, and inventing one would be a forgery rather than an illustration. The '
                  + 'filename and the page numbers the figures cite are what the provenance display '
                  + 'needs, and those are real.',
          }) + `<p><a href="/org/${s.org.id}/documents">Back to documents</a></p>`,
        }));
      }

      return { redirect: download.url };
    },
  },

  // ───────────────────────────────────────────────── the worked example ──

  {
    path: '/org/:org/example', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;

      const already = seed.isSeeded(req.ctx, s.org.id);
      const hasOwnData = req.ctx.db.find('fact', { org_id: s.org.id })
        .filter((f) => !f.superseded_by).length > 0;

      return s.render('The worked example', page({
        title: 'The worked example',
        lede: 'A company with four years of confirmed figures, a scored assessment, an open gap '
            + 'register, three closed forecast cycles and eight generated documents. Every figure in '
            + 'it traces to a document and a page number.',
        body: already
          ? banner({
            tone: 'info',
            says: 'This organisation holds the worked example.',
            detail: 'Every page carries the notice, so a screenshot taken out of context cannot be '
                  + 'mistaken for a real company.',
          }) + `<p><a href="/org/${s.org.id}">Go to the overview</a></p>`
          : (hasOwnData
            ? banner({
              tone: 'warn',
              says: 'This organisation already has figures of its own.',
              detail: 'The example is only loaded into an empty organisation. Once invented figures '
                    + 'and real ones are in the same data room, nobody can tell them apart '
                    + 'afterwards — including the people reading the documents it produces.',
            })
            : section({
              title: 'What it is for',
              note: 'An empty product teaches nothing. The thing this one is built around — that a '
                  + 'figure carries where it came from — is invisible until there are figures.',
              body: '<p>The example company is deliberately not a model citizen. Its largest customer '
                  + 'is a rising share of revenue, its founder holds every top-ten relationship with '
                  + 'no deputy named, and two of its three forecast cycles missed. A demonstration '
                  + 'company that scored well everywhere would show none of the actual work.</p>'
                  + action({
                    label: 'Load the worked example', tone: 'solid',
                    confirm: `/org/${s.org.id}/example`, csrf: s.csrf,
                  }),
            })),
      }));
    },
  },

  {
    path: '/org/:org/example', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;

      const r = attempt(s, () => seed.seedWorkedExample(req.ctx, s.org.id, { entitle: true }));
      if (!r.ok) return r.response;

      const result = r.value.body;
      const blocked = result.produced.filter((p) => p.blocked);

      return s.render('The worked example', page({
        title: 'Loaded',
        lede: `${result.figures} figures, ${result.documents} source documents, ${result.gaps} open `
            + `gaps, and ${result.produced.length - blocked.length} generated documents.`,
        body: banner({
          tone: 'good',
          says: 'The example is loaded, and every page of this organisation now carries the notice.',
        })
          + (blocked.length
            ? section({
              title: 'Not generated',
              note: 'A document that cannot be generated says what is missing rather than coming out '
                  + 'with holes in it. These are the ones that did.',
              body: blocked.map((b) => record({
                title: b.kind.replace(/_/g, ' ').toLowerCase(),
                meta: b.blockers.join(', '),
                state: 'blocked',
              })).join(''),
            })
            : '')
          + (result.skipped.length
            ? section({
              title: 'Left out',
              body: result.skipped.map((sk) => record({
                title: sk.what, meta: sk.why, state: 'attention',
              })).join(''),
            })
            : '')
          + section({
            title: 'Where to look first',
            body: [
              ['Figures', 'facts', 'Every figure, with the document and page it was confirmed from.'],
              ['Documents out', 'artifacts', 'Eight generated documents. Open one and read the appendix.'],
              ['Gaps', 'gaps', 'The register, in fix order rather than score order.'],
              ['Forecasts', 'cadence', 'Three closed cycles, two of which missed and say why.'],
            ].map(([title, path, meta]) => record({
              title, meta, href: `/org/${s.org.id}/${path}`, state: 'active',
            })).join(''),
          }),
      }));
    },
  },
];
