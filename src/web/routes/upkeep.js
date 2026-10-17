/**
 * Keeping it current: what has gone out of date, what would change if you
 * regenerated, and recording that a version was actually sent.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY REGENERATION HAS A PAGE OF ITS OWN
 *
 * Pressing a button marked "Regenerate" and getting a new document back is the
 * obvious design and the wrong one. The useful question is never "can I have a
 * fresh copy" — it is "what will be different, and does anybody outside this
 * company have the old one". Those are the two things the service layer can
 * answer and a one-click button throws away.
 *
 * So regeneration is two steps: see the difference, then make it. The first step
 * changes nothing and can be read as many times as you like.
 *
 * Marking a version as sent is the other half of the same idea. Until somebody
 * records that a document went out, the product cannot tell the difference
 * between a stale draft nobody has seen and a stale document in an investor's
 * inbox — and those warrant completely different warnings.
 */

import * as freshness from '../../api/freshness.js';
import { shell, attempt, can, gatedNote } from './shell.js';
import {
  page, section, record, table, field, emptyState, banner, h, action,
  figure, pill, ref,
} from '../html.js';

/** 30 days back, as an ISO date, for the default window on the digest. */
function defaultSince(nowIso) {
  const d = new Date(nowIso);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

/**
 * The four states a document can be in, and the two that mean anything here.
 *
 * `TIMELESS` is not a missing value. A certificate of incorporation does not go
 * out of date and a contract changes status on its own dates rather than on a
 * clock, so the domain says so explicitly rather than leaving them undated.
 * `UNKNOWN` is the genuinely missing one: a document whose upload date was never
 * recorded, which there is nothing to measure.
 *
 * Conflating the two put six certificates and contracts under a heading reading
 * "worth refreshing", each one explaining that it could not go out of date. A
 * list that flags things it then says are fine is a list people stop reading,
 * which is how the one document that genuinely has gone stale gets missed.
 */
const stateLabel = {
  FRESH: ['Current', 'good'],
  AGEING: ['Ageing', 'warn'],
  STALE: ['Out of date', 'bad'],
  TIMELESS: ['Does not age', 'neutral'],
  UNKNOWN: ['No date recorded', 'neutral'],
};

/** The only two states that are an invitation to do something. */
const NEEDS_ATTENTION = Object.freeze(['AGEING', 'STALE']);

export const upkeepRoutes = [
  // ───────────────────────────────────────── what is going out of date ──
  {
    path: '/org/:org/upkeep', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'room' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const since = req.query.get('since') || defaultSince(ctx.now());
      const room = attempt(s, () => freshness.roomFreshness(ctx, s.org.id).body);
      if (!room.ok) return room.response;

      // `changesSince` wants a timestamp; the form gives a date. Midnight is the
      // reading a person means by a date, and saying so beats silently shifting
      // the window by the current time of day.
      const digest = attempt(s, () =>
        freshness.changesSince(ctx, s.org.id, `${since}T00:00:00.000Z`).body);
      if (!digest.ok) return digest.response;

      const documents = room.value.documents ?? [];
      const ageing = documents.filter((d) => NEEDS_ATTENTION.includes(d.state));
      const timeless = documents.filter((d) => d.state === 'TIMELESS');
      const undated = documents.filter((d) => d.state === 'UNKNOWN');

      const docRows = (list) => list.map((d) => {
        const [label, tone] = stateLabel[d.state] ?? stateLabel.UNKNOWN;
        return record({
          title: d.filename,
          meta: `${String(d.kind).replace(/_/g, ' ').toLowerCase()}`
            + `${d.uploaded_at ? ` · uploaded ${String(d.uploaded_at).slice(0, 10)}` : ''}`
            + `${Number.isFinite(d.days) ? ` · ${d.days} days old` : ''}`,
          state: d.state === 'STALE' ? 'blocked' : d.state === 'AGEING' ? 'attention' : 'done',
          body: `<p>${pill(label, tone)}</p><p class="note">${h(d.why ?? '')}</p>`
            + (d.policy?.staleAfterDays
              ? `<p class="note">Judged against ${d.policy.staleAfterDays} days for this kind of document, `
                + 'not against one interval for everything.</p>'
              : ''),
          actions: action({
            href: `/org/${s.org.id}/documents/${h(d.document_id)}/review`,
            label: 'Open', tone: 'quiet',
          }),
        });
      }).join('');

      // Facts corrected since the window opened. The additions list is usually
      // long and rarely interesting; a correction is the thing that invalidates
      // a document somebody is holding.
      const corrections = digest.value.corrections ?? [];
      const alsoMoved = [
        [digest.value.facts_added ?? [], 'figure recorded', 'figures recorded'],
        [digest.value.documents_added ?? [], 'document uploaded', 'documents uploaded'],
        [digest.value.gaps_closed ?? [], 'gap closed', 'gaps closed'],
        [digest.value.variances_explained ?? [], 'variance explained', 'variances explained'],
        [digest.value.assessments_completed ?? [], 'assessment completed', 'assessments completed'],
      ].filter(([list]) => list.length)
        .map(([list, one, many]) => `${list.length} ${list.length === 1 ? one : many}`);

      return s.render('Keeping it current', page({
        title: 'Keeping it current',
        lede: 'A document ages at the rate its own kind ages at. Management accounts go off in six '
            + 'weeks; a certificate of incorporation does not go off at all. One interval applied to '
            + 'everything would flag the certificate and miss the accounts.',
        body: (ageing.length
          ? section({
            title: `${ageing.length} document${ageing.length === 1 ? '' : 's'} worth refreshing`,
            note: 'Ordered worst first. Nothing here is wrong — it is old, which a counterparty reads '
                + 'as a signal about the rhythm of the business rather than about the document.',
            body: docRows(ageing),
          })
          : banner({
            tone: 'good',
            says: 'Every document in the room that ages on a clock is current for its kind.',
          }))
          + (undated.length
            ? section({
              title: `${undated.length} document${undated.length === 1 ? ' has' : 's have'} no date to measure from`,
              note: 'Not a judgement about them — there is simply nothing recorded to count from, so '
                  + 'this page cannot say either way.',
              body: docRows(undated),
            })
            : '')
          + (timeless.length
            ? section({
              title: `${timeless.length} document${timeless.length === 1 ? '' : 's'} that will never appear above`,
              note: 'Listed once, quietly, so that an empty section above is not mistaken for a page '
                  + 'that has not looked at them.',
              body: `<p class="note">${timeless.map((d) => h(d.filename)).join(' · ')}</p>`
                + '<p class="note">A contract changes status when its term, notice or renewal date '
                + 'arrives, and a constitutional document does not go out of date at all. Putting a '
                + 'review interval on either would invent a deadline, and a product that invents '
                + 'deadlines is one whose warnings get ignored.</p>',
            })
            : '')
          + section({
            title: 'What moved',
            note: 'Corrections first. A figure that was corrected is what makes a document somebody '
                + 'already has wrong; a figure newly added only makes it incomplete.',
            body: `<form class="form is-compact" method="get" action="/org/${s.org.id}/upkeep">
                ${field({ name: 'since', label: 'Since', type: 'date', value: since })}
                <div class="form-actions"><button class="button button-quiet" type="submit">Show</button></div>
              </form>`
              + (corrections.length
                ? banner({
                  tone: 'warn',
                  says: `${corrections.length} figure${corrections.length === 1 ? ' was' : 's were'} corrected. `
                      + 'Any document generated before that is wrong, not merely old.',
                  detail: 'Check which documents rest on them, and whether any of those went out.',
                }) + table({
                  columns: [
                    { key: 'label', label: 'Figure' },
                    { key: 'key', label: 'Key', raw: true },
                    { key: 'was', label: 'Was', align: 'right' },
                    { key: 'now', label: 'Now', align: 'right' },
                  ],
                  rows: corrections.map((c) => ({
                    label: c.label ?? c.fact_key,
                    key: ref(c.fact_key),
                    was: String(c.was ?? '—'),
                    now: String(c.now ?? '—'),
                  })),
                })
                : `<p class="note">No figure has been corrected since ${h(since)}. That is the one `
                  + 'change that makes a document somebody already holds wrong, so it is reported on '
                  + 'its own rather than buried in a feed.</p>')
              + (alsoMoved.length
                ? `<p class="note">Also in this period: ${h(alsoMoved.join(', '))}. None of these makes `
                  + 'an existing document wrong, so they are counted rather than listed.</p>'
                : ''),
          })
          + section({
            title: 'Why documents are not quietly rewritten',
            body: '<p>Nothing in this product edits a document that has already been generated. '
                + 'Regenerating writes a new version and keeps the old one exactly as it was, because '
                + 'somebody may be holding it and the only honest answer to "what did they see" is the '
                + 'document they were sent.</p>',
          }),
      }), { wide: true });
    },
  },

  // ──────────────────────────────────────────── regeneration, in two steps ──
  {
    path: '/org/:org/artifacts/:artifact/regenerate', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const gate = can(ctx, s.org.id, 'GENERATE_ARTIFACTS');
      const preview = attempt(s, () =>
        freshness.previewRegeneration(ctx, s.org.id, req.params.artifact).body);
      if (!preview.ok) return preview.response;

      const { artifact, changes, figures_moving: moving, provenance_only: provenance, note } = preview.value;

      const changeTable = changes.length
        ? table({
          columns: [
            { key: 'label', label: 'Figure' },
            { key: 'was', label: 'In this version', align: 'right' },
            { key: 'now', label: 'Now', align: 'right' },
            { key: 'what', label: 'What changed' },
          ],
          rows: changes.map((c) => ({
            label: c.label ?? c.fact_key,
            was: String(c.was ?? '—'),
            now: String(c.now ?? '—'),
            what: c.value_moved
              ? 'The value'
              : `Where it came from — ${String(c.was_source).replace(/_/g, ' ').toLowerCase()} `
                + `to ${String(c.now_source).replace(/_/g, ' ').toLowerCase()}`,
          })),
        })
        : emptyState({
          says: 'Nothing behind this document has changed. Regenerating would produce the same '
              + 'figures from the same sources.',
        });

      return s.render(`Regenerate ${artifact.title}`, page({
        title: `Regenerate ${artifact.title}`,
        lede: note,
        actions: action({
          href: `/org/${s.org.id}/artifacts/${h(artifact.id)}`, label: 'Back to the document', tone: 'quiet',
        }),
        body: gatedNote(gate)
          + `<div class="row">${figure({
            label: 'Figures whose value moved',
            value: String(moving),
            from: moving ? 'These make the current version wrong' : 'None',
          })}${figure({
            label: 'Figures whose source changed',
            value: String(provenance),
            from: provenance
              ? 'Same number, better or worse evidence behind it'
              : 'None',
          })}</div>`
          + (artifact.released_at
            ? banner({
              tone: 'warn',
              says: `This version was sent out on ${String(artifact.released_at).slice(0, 10)}.`,
              detail: `${artifact.released_note ?? ''} Whoever has it keeps what they were sent. If `
                    + 'figures moved, telling them yourself is a short conversation and them finding '
                    + 'it is a different one.',
            })
            : '')
          + section({ title: 'What would be different', body: changeTable })
          + (gate.allowed
            ? section({
              title: 'Make the new version',
              note: 'The current version is kept and marked superseded. It is not overwritten and it '
                  + 'is still readable afterwards.',
              body: action({
                label: changes.length ? 'Regenerate' : 'Regenerate anyway',
                tone: 'solid',
                confirm: `/org/${s.org.id}/artifacts/${h(artifact.id)}/regenerate`,
                csrf: s.csrf,
              }),
            })
            : ''),
      }));
    },
  },

  {
    path: '/org/:org/artifacts/:artifact/regenerate', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts' });
      if (!s.ok) return s.response;

      const r = attempt(s, () => freshness.regenerate(req.ctx, s.org.id, req.params.artifact));
      if (!r.ok) return r.response;
      const result = r.value.body;

      if (result.blocked) {
        return s.render('Not regenerated', page({
          title: 'Not regenerated',
          lede: result.note,
          body: result.blockers.map((b) => record({
            title: b.problem, meta: b.code, state: 'blocked',
          })).join('')
            + action({
              href: `/org/${s.org.id}/artifacts/${h(result.previous.id)}`,
              label: 'Back to the version you have', tone: 'quiet',
            }),
        }));
      }

      if (result.outstanding) {
        // Shown rather than redirected past. This is the one moment the product
        // knows something the user needs to act on outside it.
        return s.render(result.artifact.title, page({
          title: 'New version made',
          lede: 'And somebody outside the company has the previous one.',
          body: banner({ tone: 'warn', says: result.outstanding })
            + section({
              title: 'The new version',
              body: record({
                title: result.artifact.title,
                meta: `generated ${String(result.artifact.generated_at ?? '').slice(0, 10)}`,
                state: 'done',
                href: `/org/${s.org.id}/artifacts/${result.artifact.id}`,
              }),
            })
            + section({
              title: 'Who has the old one',
              body: action({ href: `/org/${s.org.id}/sharing`, label: 'Open sharing', tone: 'quiet' }),
            }),
        }));
      }

      return { redirect: `/org/${s.org.id}/artifacts/${result.artifact.id}` };
    },
  },

  {
    path: '/org/:org/artifacts/:artifact/release', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        freshness.markReleased(req.ctx, s.org.id, req.params.artifact, { note: req.body.note }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/artifacts/${req.params.artifact}` };
    },
  },
];
