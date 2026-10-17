/**
 * The working surfaces: readiness, gaps, the data room, documents and figures.
 *
 * These are the pages somebody spends hours in, so they are built to be worked
 * rather than read — the assessment is one page you can fill in without
 * navigating, and the figures page puts recording a figure next to the list of
 * them rather than behind a button.
 */

import * as svc from '../../api/service.js';
import * as assessments from '../../api/assessments.js';
import * as dataroom from '../../api/dataroom.js';
import * as extraction from '../../api/extraction.js';
import * as factlib from '../../api/factlib.js';
import { GAP_CATEGORIES, CATEGORY_RATIONALE, categoryLabel } from '../../domain/gaps.js';
import { UNITS } from '../../domain/facts.js';
import { isDecided } from '../../domain/extraction.js';
import { suggestKey } from '../../domain/factkeys.js';
import { shell, attempt, wantsJson, json, jsonRefusal } from './shell.js';
import {
  page, section, record, table, form, field, select, figure, emptyState, banner, h, action, csrfField, ref,
} from '../html.js';

const money = (f) => {
  if (f.value_numeric === null || f.value_numeric === undefined) return f.value_text ?? f.value_date ?? '—';
  if (f.unit === 'percent') return `${f.value_numeric}%`;
  const symbol = { USD: '$', GBP: '£', EUR: '€' }[f.unit] ?? '';
  return `${symbol}${Number(f.value_numeric).toLocaleString('en-US')}`;
};

export const workRoutes = [
  // ───────────────────────────────────────────────────────── readiness ──
  {
    path: '/org/:org/readiness', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'assessment' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const catalogue = assessments.getCatalogue().body;
      const list = assessments.listAssessments(ctx, s.org.id).body;
      // Oldest first, so the most recent of each is found from the end.
      const open = [...list.assessments].reverse().find((a) => !a.complete) ?? null;
      const latest = [...list.assessments].reverse().find((a) => a.complete) ?? null;

      const current = open ? assessments.getAssessment(ctx, s.org.id, open.id).body : null;
      const scores = current?.scores ?? {};

      const bands = catalogue.bands.map((b) =>
        `<tr><td>${h(String(b.band).replace('_', ' ').toLowerCase())}</td>`
        + `<td class="right tnum">${h(b.min)}–${h(b.max)}</td>`
        // `means` is the only part of a band a user can act on. A table of
        // ranges without it is a table of numbers.
        + `<td>${h(b.means)}</td></tr>`).join('');

      const body = latest
        ? `<div class="row">${figure({
          label: 'Band', value: String(latest.band ?? '').replace('_', ' ').toLowerCase(),
          from: `Scored ${String(latest.completed_at).slice(0, 10)}`,
        })}${figure({
          label: 'Weighted total', value: `${latest.total_weighted} / 200`,
          from: latest.capped ? 'Capped by a hard rule' : 'No cap applied',
        })}</div>`
          + (latest.findings?.length
            ? section({
              title: latest.findings.length === 1
                ? 'A hard rule applied to this score'
                : `${latest.findings.length} hard rules applied to this score`,
              note: 'A hard rule is not a deduction. It holds the band down regardless of the total, '
                  + 'because a counterparty will stop at the same place.',
              body: latest.findings.map((f) => record({
                title: f.detail,
                // The action is the point of a finding, and it is what a banner
                // joining these into one string threw away.
                meta: f.action,
                state: f.rule === 'cap_table_gate' ? 'blocked' : 'attention',
              })).join(''),
            })
            : '')
        : '';

      // The scale is written next to every answer rather than once at the top.
      // A number from 0 to 5 means nothing on its own, and a key the reader has
      // to scroll back to is a key they stop using by question six — at which
      // point the whole assessment is somebody's mood rather than a measurement.
      const scaleOptions = (ref) => catalogue.scale.map((sc) =>
        `<option value="${h(sc.score)}"${String(scores[ref] ?? '') === String(sc.score) ? ' selected' : ''}>`
        + `${h(sc.score)} — ${h(sc.means)}</option>`).join('');

      const formBody = catalogue.domains.map((d) => `
        <fieldset class="block">
          <legend><h2>${h(d.domain)}. ${h(d.name)}</h2></legend>
          <p class="note">${h(d.question)}</p>
          <p class="hint">Weight ×${h(d.weight)} of the total.</p>
          ${d.criteria.map((c) => `
            <div class="field">
              <label for="f-${h(c.ref)}"><span class="ref">${h(c.ref)}</span> ${h(c.text)}</label>
              <select id="f-${h(c.ref)}" name="score.${h(c.ref)}">
                <option value="">Not answered</option>
                ${scaleOptions(c.ref)}
              </select>
            </div>`).join('')}
        </fieldset>`).join('');

      return s.render('Readiness', page({
        title: 'Readiness',
        lede: 'Eight domains, thirty-two questions, scored 0 to 5. Answer honestly — the score is for '
            + 'you, and a flattering one just moves the surprise to diligence.',
        body: body + section({
          title: open ? 'Continue scoring' : 'Start an assessment',
          note: 'Leave anything you do not know unanswered. An unanswered question is not a zero, and '
              + 'the score says so.',
          body: open
            ? `<form class="form is-compact" method="post" action="/org/${s.org.id}/readiness/score">
                ${csrfField(s.csrf)}<input type="hidden" name="assessment" value="${h(open.id)}">
                ${formBody}
                <div class="form-actions">
                  <button class="button" type="submit" name="finish" value="">Save progress</button>
                  <button class="button button-quiet" type="submit" name="finish" value="1">Save and complete</button>
                </div>
               </form>`
            : form({
              action: `/org/${s.org.id}/readiness/start`, csrf: s.csrf, submit: 'Start',
              body: select({
                name: 'scorer_role', label: 'Who is scoring?',
                hint: 'Two people scoring separately and comparing is the most useful thing you can '
                    + 'do with this.',
                options: [
                  { value: 'FOUNDER', label: 'Founder' },
                  { value: 'ADVISER', label: 'Adviser' },
                  { value: 'INVESTOR', label: 'Investor or buyer' },
                ],
              }),
            }),
        }) + section({
          title: 'How the bands work',
          body: '<div class="table-scroll"><table class="data"><thead><tr><th>Band</th>'
              + '<th class="right">Weighted</th><th>What it means</th></tr></thead>'
              + `<tbody>${bands}</tbody></table></div>`,
        }),
      }));
    },
  },

  {
    path: '/org/:org/readiness/start', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'assessment' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => assessments.createAssessment(req.ctx, s.org.id, {
        scorer_role: req.body.scorer_role,
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/readiness` };
    },
  },

  {
    path: '/org/:org/readiness/score', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'assessment' });
      if (!s.ok) return s.response;

      const scores = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (!key.startsWith('score.')) continue;
        // An empty answer clears it rather than scoring zero. `Number('')` is 0,
        // and a zero here would drag the band down for a question nobody reached.
        scores[key.slice(6)] = value === '' ? null : Number(value);
      }

      const scored = attempt(s, () =>
        assessments.scoreAssessment(req.ctx, s.org.id, req.body.assessment, scores));
      if (!scored.ok) return scored.response;

      if (req.body.finish) {
        const done = attempt(s, () =>
          assessments.completeAssessment(req.ctx, s.org.id, req.body.assessment));
        if (!done.ok) return done.response;
        return { redirect: `/org/${s.org.id}/gaps` };
      }
      return { redirect: `/org/${s.org.id}/readiness` };
    },
  },

  // ───────────────────────────────────────────────────────────── gaps ──
  {
    path: '/org/:org/gaps', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'gaps' });
      if (!s.ok) return s.response;
      const { ctx } = req;
      const gaps = assessments.listGaps(ctx, s.org.id).body.gaps ?? [];
      const members = svc.listMembers(ctx, s.org.id).body.members ?? [];

      const rows = gaps.map((g) => record({
        title: g.description,
        meta: `${g.criterion_ref} · ${categoryLabel(g.category)}${g.due_date ? ` · due ${g.due_date}` : ''}`,
        state: g.category === 'BLOCKER' ? 'blocked' : g.category === 'CHEAP' ? 'active' : 'attention',
        body: `<p class="note">Done when: ${h(g.done_when)}</p>
          <form class="inline" method="post" action="/org/${s.org.id}/gaps/${h(g.id)}">
            ${csrfField(s.csrf)}
            <select name="owner_user_id" aria-label="Owner">
              <option value="">No owner</option>
              ${members.map((m) => `<option value="${h(m.user_id)}"${m.user_id === g.owner_user_id ? ' selected' : ''}>${h(m.email ?? m.user_id)}</option>`).join('')}
            </select>
            <input type="date" name="due_date" value="${h(g.due_date ?? '')}" aria-label="Due date">
            <button class="button button-quiet" type="submit">Update</button>
          </form>`,
        actions: `<form method="post" action="/org/${s.org.id}/gaps/${h(g.id)}/close" class="inline">
            ${csrfField(s.csrf)}
            <input type="text" name="evidence" placeholder="What closed it?" aria-label="Evidence" size="18">
            <button class="button button-quiet" type="submit">Close</button>
          </form>`,
      })).join('');

      return s.render('Gaps', page({
        title: 'Gaps',
        lede: 'Sorted in fix order — what unblocks the most, soonest — rather than by score. '
            + 'The lowest score is rarely the first thing to do.',
        body: (rows || emptyState({
          says: 'No open gaps. Complete an assessment and anything scoring three or below appears here.',
          action: action({ href: `/org/${s.org.id}/readiness`, label: 'Go to readiness' }),
        })) + section({
          title: 'What the categories mean',
          body: `<div class="table-scroll"><table class="data"><tbody>${
            GAP_CATEGORIES.map((c) => `<tr><td><strong>${h(categoryLabel(c))}</strong></td><td>${
              h(CATEGORY_RATIONALE[c] ?? '')}</td></tr>`).join('')}</tbody></table></div>`,
        }),
      }));
    },
  },

  {
    path: '/org/:org/gaps/:gap', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'gaps' });
      if (!s.ok) return s.response;
      const input = {};
      if (req.body.owner_user_id !== undefined) input.owner_user_id = req.body.owner_user_id || null;
      if (req.body.due_date !== undefined) input.due_date = req.body.due_date || null;
      const r = attempt(s, () => assessments.updateGap(req.ctx, s.org.id, req.params.gap, input));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/gaps` };
    },
  },

  {
    path: '/org/:org/gaps/:gap/close', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'gaps' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        assessments.closeGap(req.ctx, s.org.id, req.params.gap, { evidence: req.body.evidence }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/gaps` };
    },
  },

  // ───────────────────────────────────────────────────────── data room ──
  {
    path: '/org/:org/room', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'room' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const room = attempt(s, () => dataroom.getRoom(ctx, s.org.id).body);
      if (!room.ok) return room.response;
      // Read from the rows rather than through a service call because a room
      // item carries a document id and the room endpoint does not resolve it to
      // a filename. Showing which file satisfies an item is the difference
      // between a tick and an answer.
      const byId = new Map(ctx.db.find('document', { org_id: s.org.id }).map((d) => [d.id, d]));

      const folders = room.value.folders.map((folder) => section({
        title: `${folder.key} ${folder.name}`,
        note: `${folder.present} filed, ${folder.missing} missing${folder.not_applicable ? `, ${folder.not_applicable} not applicable` : ''} · visible from ${String(folder.stage).replace('_', ' ').toLowerCase()}`,
        body: folder.items.map((item) => record({
          title: `${item.ref} ${item.name}`,
          meta: item.document_id
            ? `Filed: ${byId.get(item.document_id)?.filename ?? 'a document'}`
            : item.state === 'NOT_APPLICABLE' ? `Not applicable — ${item.na_reason ?? ''}` : (item.required ? 'Required' : 'Optional'),
          state: item.state === 'PRESENT' ? 'done'
            : item.state === 'NOT_APPLICABLE' ? null
              : item.required ? 'attention' : null,
          actions: item.state === 'PRESENT' ? '' : `
            <form method="post" action="/org/${s.org.id}/room/${h(item.id)}/na" class="inline">
              ${csrfField(s.csrf)}
              <input type="text" name="reason" placeholder="Why not applicable?" aria-label="Reason" size="22">
              <button class="button button-quiet" type="submit">Not applicable</button>
            </form>`,
        })).join(''),
      })).join('');

      return s.render('Data room', page({
        title: 'Data room',
        lede: `${room.value.required_satisfied} of ${room.value.required_total} required items filled. `
            + 'Not applicable needs a written reason — without one it is missing with better manners, '
            + 'and a counterparty will read it that way.',
        actions: action({
          href: `/org/${s.org.id}/upkeep`, label: 'What is going out of date', tone: 'quiet',
        }),
        body: folders,
      }), { wide: true });
    },
  },

  {
    path: '/org/:org/room/:item/na', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'room' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        dataroom.markNotApplicable(req.ctx, s.org.id, req.params.item, req.body.reason));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/room` };
    },
  },

  // ───────────────────────────────────────────────────────── documents ──
  {
    path: '/org/:org/documents', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const docs = ctx.db.find('document', { org_id: s.org.id })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

      // Figures read from a document that nobody has confirmed. The commonest
      // reason a document will not generate, so it goes at the top. Read from the
      // rows rather than through a service call because there is no list
      // endpoint for them — deciding one goes through the service, which is
      // where the rules are.
      //
      // `isDecided` rather than a list of state names written out here. The
      // first version of this line filtered for `PENDING` or `VIEWED`, neither
      // of which is a state this product has: the real enum is AWAITING_REVIEW,
      // CONFIRMED, EDITED_CONFIRMED, REJECTED, and `viewed_at` is a timestamp
      // rather than a state. So this whole section rendered empty for ever —
      // the one prompt telling somebody that figures were waiting on them was
      // silently dead, and nothing failed, because an empty list is what an
      // organisation with nothing waiting looks like.
      const pending = ctx.db.find('extraction_candidate', { org_id: s.org.id })
        .filter((c) => !isDecided(c.state));

      return s.render('Documents', page({
        title: 'Documents',
        lede: 'What you have uploaded, and anything read out of it that still needs a human to '
            + 'confirm it.',
        actions: action({
          href: `/org/${s.org.id}/transfer-sheet`, label: 'Transcribe the paper workbook', tone: 'quiet',
        }),
        body: (pending.length
          ? section({
            title: `${pending.length} figure${pending.length === 1 ? '' : 's'} waiting for you`,
            note: 'A figure read from a document is a proposal until somebody confirms it. Nothing '
                + 'uses these until you do.',
            body: pending.slice(0, 25).map((c) => record({
              title: `${c.label ?? c.fact_key}: ${c.value_numeric ?? c.value_text ?? ''}`,
              meta: `${c.fact_key}, page ${c.source_page ?? 'unknown'}`,
              state: 'attention',
              body: c.locator ? `<p class="note">Read from: ${h(c.locator)}</p>` : '',
              actions: `<form method="post" action="/org/${s.org.id}/documents/confirm" class="inline">
                ${csrfField(s.csrf)}<input type="hidden" name="candidate" value="${h(c.id)}">
                <button class="button button-quiet" type="submit">Confirm</button></form>`,
            })).join(''),
          })
          : '')
          + section({
            title: 'Uploaded',
            body: docs.length
              ? docs.map((d) => record({
                title: d.filename,
                href: `/org/${s.org.id}/documents/${d.id}/review`,
                meta: `${d.kind}${d.provenance_class === 'EXTERNAL' ? ' · external source' : ''} · ${
                  d.uploaded_at ? `uploaded ${String(d.uploaded_at).slice(0, 10)}` : 'upload not finished'}`,
                state: d.uploaded_at ? 'done' : 'attention',
                actions: d.uploaded_at
                  ? action({
                    href: `/org/${s.org.id}/documents/${d.id}/download`,
                    label: 'Download', tone: 'quiet',
                  })
                  : '',
              })).join('')
              : emptyState({
                says: 'Nothing uploaded yet. Start with your most recent statutory accounts — most of '
                    + 'what the room asks for follows from them.',
              }),
          })
          + section({
            title: 'Add a document',
            note: 'The file goes straight from your browser to storage. It does not pass through '
                + 'this application, and nothing is recorded as uploaded until the file is actually '
                + 'there.',
            body: form({
              action: `/org/${s.org.id}/documents`, csrf: s.csrf, submit: 'Upload',
              data: { upload: true },
              body: field({
                name: 'filename', label: 'File', type: 'file', required: true,
                hint: 'Up to 100 MB.',
              })
                + select({
                  name: 'kind', label: 'What is it?',
                  options: ['ACCOUNTS', 'CONTRACT', 'CAP_TABLE', 'MODEL', 'DECK', 'CONSTITUTIONAL', 'OTHER']
                    .map((k) => ({ value: k, label: k.replace('_', ' ').toLowerCase() })),
                })
                // Filled by the script from the chosen file. Not a field
                // somebody types: a size typed by hand is a figure with no
                // provenance, in a product whose entire argument is provenance.
                + '<input type="hidden" name="size_bytes" value="">'
                + '<input type="hidden" name="mime_type" value="">'
                + '<noscript><p class="note">Uploading needs JavaScript, because the file is sent '
                + 'from your browser straight to storage rather than through this application. '
                + 'Everything else on this page works without it.</p></noscript>',
            }),
          }),
      }), { scripts: ['/assets/upload.js'] });
    },
  },

  {
    path: '/org/:org/documents', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;

      // The deployment's own storage, never a stand-in. An earlier draft of this
      // handler built a dummy driver inline so the form would post on a
      // deployment with no storage configured; what that produced was a document
      // row pointing at a URL that does not exist, discovered weeks later by
      // somebody trying to download their own accounts.
      const { storage } = req.ctx;
      if (!storage) {
        return s.render('Documents', page({
          title: 'No file storage',
          body: banner({
            tone: 'warn',
            says: 'This deployment has no file storage configured, so there is nowhere to put a file.',
            detail: 'Recording the document anyway would create a row pointing at nothing, which is '
                  + 'worse than refusing: it looks filed. Everything else on this page works.',
          }) + `<p><a href="/org/${s.org.id}/documents">Back</a></p>`,
        }), { status: 503 });
      }

      // ─────────────────────────────────────────────────────────────────────
      // THIS ROUTE ISSUES A TICKET AND STOPS THERE
      //
      // It used to call `confirmUpload` in the same breath, which made every
      // document in the product a row claiming a file had been uploaded with
      // nothing behind its key. `confirmUpload` says in its own comment that
      // the client calls it once the PUT succeeds, and there was no PUT.
      //
      // So confirmation is its own route below, reached only after bytes have
      // actually been stored. A document with no file stays in AWAITING_UPLOAD,
      // and the documents page already says what that means — which is the
      // honest outcome when somebody has JavaScript turned off, and a far better
      // one than a row that looks filed.
      const r = attempt(s, () => svc.createUploadTicket(req.ctx, s.org.id, {
        filename: req.body.filename,
        // No fallback. A missing size used to default to one byte, which
        // registered a document carrying a figure nobody supplied; the service
        // layer refuses a size of zero and that refusal is the right answer
        // here — it is what a browser with no JavaScript gets, and it says so.
        size_bytes: Number(req.body.size_bytes),
        // Recorded as given and never trusted: objects are served as
        // attachments under a type this application chooses.
        mime_type: req.body.mime_type || 'application/octet-stream',
        kind: req.body.kind,
      }, storage));

      if (!r.ok) return wantsJson(req) ? jsonRefusal(r.error) : r.response;

      const ticket = r.value.body;
      if (!wantsJson(req)) return { redirect: `/org/${s.org.id}/documents` };

      return json({
        document: ticket.document,
        upload: ticket.upload,
        confirm_url: `/org/${s.org.id}/documents/${ticket.document.id}/uploaded`,
      }, 201);
    },
  },

  {
    // Step three. Separate from the ticket on purpose: nothing but a successful
    // PUT may move a document out of AWAITING_UPLOAD, and a route that cannot
    // be reached without one is a stronger guarantee than a comment asking the
    // caller to be careful.
    path: '/org/:org/documents/:document/uploaded', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;

      const r = attempt(s, () => svc.confirmUpload(req.ctx, s.org.id, req.params.document));
      if (!r.ok) return wantsJson(req) ? jsonRefusal(r.error) : r.response;
      return wantsJson(req)
        ? json({ document: r.value.body.document })
        : { redirect: `/org/${s.org.id}/documents` };
    },
  },

  {
    path: '/org/:org/documents/confirm', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        extraction.decideCandidate(req.ctx, s.org.id, req.body.candidate, { decision: 'CONFIRM' }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/documents` };
    },
  },

  // ─────────────────────────────────────────────────────────── figures ──
  {
    path: '/org/:org/facts', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'facts' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const q = req.query.get('q') ?? '';
      const lib = attempt(s, () => factlib.factLibrary(ctx, s.org.id, { query: q || null }).body);
      if (!lib.ok) return lib.response;

      const groups = lib.value.groups.map((g) => section({
        title: g.name,
        note: g.hint,
        body: g.facts.map((f) => record({
          title: f.label,
          meta: `${f.fact_key}${f.uses ? ` · used in ${f.uses} place${f.uses === 1 ? '' : 's'}` : ''}`,
          state: f.usable ? 'done' : 'attention',
          body: figure({
            value: money(f), source: f.source,
            from: f.source === 'USER_CONFIRMED'
              ? `Confirmed from a document${f.source_page ? `, page ${f.source_page}` : ''}`
              : null,
          }) + `<p class="note">Write ${ref(f.reference)} in a sentence and the document fills it in.</p>`,
        })).join(''),
      })).join('');

      return s.render('Figures', page({
        title: 'Figures',
        lede: 'Every number the product will ever print comes from here. Nothing is typed into a '
            + 'document.',
        actions: action({
          href: `/org/${s.org.id}/conflicts`, label: 'Contradictions', tone: 'quiet',
        }),
        body: `<form class="form is-compact" method="get" action="/org/${s.org.id}/facts">
            ${field({ name: 'q', label: 'Search', value: q, hint: 'Matches the name and the key. Every word has to appear.' })}
            <div class="form-actions"><button class="button button-quiet" type="submit">Search</button></div>
          </form>`
          + (lib.value.awaiting_count
            ? banner({
              tone: 'warn',
              says: `${lib.value.awaiting_count} figure${lib.value.awaiting_count === 1 ? '' : 's'} read from a document, waiting for you to confirm.`,
              detail: 'Nothing uses them until you do — including documents you generate.',
            })
            : '')
          + (groups || emptyState({
            says: q ? 'Nothing matches that.' : 'No figures recorded yet. Record one below, or upload '
              + 'your accounts and confirm what comes out of them.',
          }))
          + section({
            title: 'Record a figure',
            note: 'Recorded by hand is fine, and the product says so wherever the figure appears. '
                + 'A figure confirmed from a document is worth more in a data room.',
            body: form({
              action: `/org/${s.org.id}/facts`, csrf: s.csrf, submit: 'Record',
              body: field({ name: 'label', label: 'What is it?', required: true, placeholder: 'Revenue, trailing twelve months' })
                + field({ name: 'fact_key', label: 'Key', hint: 'Leave blank and one is suggested from the name.' })
                + field({ name: 'value_numeric', label: 'Value', type: 'number', step: 'any', required: true })
                + select({
                  name: 'unit', label: 'Unit',
                  options: [{ value: '', label: 'No unit' }, ...UNITS.map((u) => ({ value: u, label: u }))],
                }),
            }),
          }),
      }));
    },
  },

  {
    path: '/org/:org/facts', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'facts' });
      if (!s.ok) return s.response;
      const existing = req.ctx.db.find('fact', { org_id: s.org.id }).map((f) => f.fact_key);
      const key = String(req.body.fact_key ?? '').trim()
        || suggestKey(req.body.label, { existing });

      const r = attempt(s, () => svc.createFact(req.ctx, s.org.id, {
        fact_key: key,
        label: req.body.label,
        value_numeric: req.body.value_numeric,
        unit: req.body.unit || null,
        source: 'USER_ENTERED',
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/facts` };
    },
  },
];

