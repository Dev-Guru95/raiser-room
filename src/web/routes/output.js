/**
 * What leaves the building: writing, generated documents, sharing.
 *
 * The writing page is the one that matters most. It is where the product's
 * central rule — no figure is ever typed — meets a person trying to write a
 * sentence, and where that rule either feels like help or like an obstacle.
 */

import * as prose from '../../api/prose.js';
import * as factlib from '../../api/factlib.js';
import * as artifacts from '../../api/artifacts.js';
import * as sharing from '../../api/sharing.js';
import * as freshness from '../../api/freshness.js';
import { PROSE_SLOTS } from '../../api/prose.js';
import { shell, attempt, can, gatedNote } from './shell.js';
import {
  page, section, record, form, field, textarea, select, figure, emptyState, banner, h, action, csrfField, ref,
} from '../html.js';

export const outputRoutes = [
  // ─────────────────────────────────────────────────────────── writing ──
  {
    path: '/org/:org/writing', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const guide = factlib.writingGuide(ctx, s.org.id).body;
      const blocks = prose.listProse(ctx, s.org.id).body.prose ?? [];
      const slot = req.query.get('slot') ?? 'default';
      const current = blocks.find((b) => b.slot === slot);
      const draft = req.query.get('draft') ?? current?.body ?? '';

      // Checked as the page renders, so the writer sees the state of what they
      // last saved rather than finding out on the next save.
      const checked = draft ? factlib.checkAndRepair(ctx, s.org.id, draft).body : null;

      const repairs = (checked?.repairs ?? []).map((r) => record({
        title: r.numeral,
        meta: r.matches.length ? 'You already have this figure' : 'Not recorded yet',
        state: r.matches.length ? 'active' : 'attention',
        body: r.matches.length
          ? r.matches.map((m) => `<p class="note">${h(m.label)} — ${h(m.group_name)}</p>
              <form method="post" action="/org/${s.org.id}/writing/repair" class="inline">
                ${csrfField(s.csrf)}
                <input type="hidden" name="slot" value="${h(slot)}">
                <input type="hidden" name="body" value="${h(draft)}">
                <input type="hidden" name="numeral" value="${h(r.numeral)}">
                <input type="hidden" name="use_existing" value="1">
                <input type="hidden" name="fact_key" value="${h(m.fact_key)}">
                <button class="button button-quiet" type="submit">Insert reference</button>
              </form>`).join('')
          : `<form method="post" action="/org/${s.org.id}/writing/repair" class="form is-compact">
              ${csrfField(s.csrf)}
              <input type="hidden" name="slot" value="${h(slot)}">
              <input type="hidden" name="body" value="${h(draft)}">
              <input type="hidden" name="numeral" value="${h(r.numeral)}">
              ${field({ name: 'label', label: 'Name this figure', value: r.draft?.label ?? '' })}
              ${field({ name: 'fact_key', label: 'Key', value: r.draft?.fact_key ?? '' })}
              ${field({ name: 'value_numeric', label: 'Value', value: String(r.draft?.value_numeric ?? ''), type: 'number', step: 'any' })}
              ${field({ name: 'unit', label: 'Unit', value: r.draft?.unit ?? '', hint: r.draft?.needs?.includes('unit') ? 'The way you wrote it did not say, so this is blank rather than guessed.' : '' })}
              <div class="form-actions"><button class="button" type="submit">Save and insert</button></div>
            </form>`,
      })).join('');

      return s.render('Writing', page({
        title: 'Writing',
        lede: guide.body,
        actions: action({
          href: `/org/${s.org.id}/languages`, label: 'Other languages', tone: 'quiet',
        }),
        body: (guide.empty_state ? banner({ tone: 'warn', says: guide.empty_state }) : '')
          + `<nav class="row">${PROSE_SLOTS.map((sl) =>
    `<a class="button button-quiet" href="/org/${s.org.id}/writing?slot=${h(sl)}">${h(sl)}</a>`).join('')}</nav>`
          + section({
            title: `The “${slot}” passage`,
            note: 'Type {{ wherever a number goes and pick from your figures. The document fills in '
                + 'the value when it renders — and keeps being right after the figure is corrected.',
            body: form({
              action: `/org/${s.org.id}/writing`, csrf: s.csrf, submit: 'Save',
              body: `<input type="hidden" name="slot" value="${h(slot)}">`
                + textarea({ name: 'body', label: 'Passage', value: draft, rows: 10 }),
            }),
          })
          + (checked && !checked.ok
            ? section({
              title: checked.summary,
              note: 'Nothing was saved. Each figure below is one click from being sorted.',
              body: repairs,
            })
            : '')
          + section({
            title: 'Your figures',
            note: 'Paste a reference straight into a sentence.',
            body: (factlib.suggestFacts(ctx, s.org.id, '').body.suggestions ?? [])
              .map((f) => record({
                title: f.label,
                meta: `${f.group_name} · ${f.preview}`,
                body: `<p class="note">${ref(f.insert)}</p>`,
              })).join('') || emptyState({
              says: 'No confirmed figures yet, so there is nothing to reference.',
              action: action({ href: `/org/${s.org.id}/facts`, label: 'Record a figure' }),
            }),
          }),
      }));
    },
  },

  {
    path: '/org/:org/writing', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const slot = req.body.slot || 'default';
      try {
        prose.writeProse(req.ctx, s.org.id, slot, req.body.body);
        return { redirect: `/org/${s.org.id}/writing?slot=${encodeURIComponent(slot)}` };
      } catch (err) {
        // A refusal here is not an error page: the writer keeps their draft and
        // the repairs appear under it. Losing somebody's paragraph to a
        // validation message is how a rule becomes a reason to write elsewhere.
        return {
          redirect: `/org/${s.org.id}/writing?slot=${encodeURIComponent(slot)}`
            + `&draft=${encodeURIComponent(req.body.body ?? '')}`,
        };
      }
    },
  },

  {
    path: '/org/:org/writing/repair', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const slot = req.body.slot || 'default';

      const r = attempt(s, () => factlib.recordAndInsert(req.ctx, s.org.id, {
        body: req.body.body,
        numeral: req.body.numeral,
        use_existing: Boolean(req.body.use_existing),
        fact_key: req.body.fact_key,
        fact: {
          fact_key: req.body.fact_key,
          label: req.body.label,
          value_numeric: req.body.value_numeric,
          unit: req.body.unit || null,
        },
      }));
      if (!r.ok) return r.response;

      const repaired = r.value.body.body;
      // Saved outright once every figure resolves; otherwise handed back as a
      // draft with the next repair waiting.
      if (r.value.body.ok) {
        const saved = attempt(s, () => prose.writeProse(req.ctx, s.org.id, slot, repaired));
        if (!saved.ok) return saved.response;
        return { redirect: `/org/${s.org.id}/writing?slot=${encodeURIComponent(slot)}` };
      }
      return {
        redirect: `/org/${s.org.id}/writing?slot=${encodeURIComponent(slot)}`
          + `&draft=${encodeURIComponent(repaired)}`,
      };
    },
  },

  // ──────────────────────────────────────────────────── documents out ──
  {
    path: '/org/:org/artifacts', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const gate = can(ctx, s.org.id, 'GENERATE_ARTIFACTS');
      const list = attempt(s, () => artifacts.listArtifacts(ctx, s.org.id).body);
      if (!list.ok) return list.response;

      const generated = ctx.db.find('artifact', { org_id: s.org.id })
        .filter((a) => !a.superseded_by)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

      let health = { artifacts: [] };
      try { health = freshness.artifactHealth(ctx, s.org.id).body; } catch { /* none yet */ }
      // `artifact_id` is the field freshness reports; `id` is also present and
      // is the same value. Reading the named one rather than either keeps this
      // honest if they ever diverge.
      const severityOf = new Map((health.artifacts ?? []).map((a) => [a.artifact_id, a.severity]));

      return s.render('Documents out', page({
        title: 'Documents out',
        lede: 'Every figure in a generated document is a reference into your figures. Nothing is '
            + 'typed, and the appendix lists each one with where it came from.',
        body: gatedNote(gate)
          + (generated.length
            ? section({
              title: 'Generated',
              body: generated.map((a) => {
                const sev = severityOf.get(a.id);
                return record({
                  title: a.title,
                  href: `/org/${s.org.id}/artifacts/${a.id}`,
                  meta: `${a.state.toLowerCase()}${a.generated_at ? `, ${String(a.generated_at).slice(0, 10)}` : ''}`,
                  state: sev && sev !== 'CURRENT' ? 'attention' : 'done',
                  body: sev && sev !== 'CURRENT'
                    ? `<p class="note">Figures behind this have changed since it was generated. Regenerate before sending.</p>`
                    : '',
                  // "Regenerate" opens the preview rather than regenerating.
                  // The useful question is never "can I have a fresh copy" — it
                  // is what will be different and whether anybody outside the
                  // company holds the old one, and a one-click button answers
                  // neither.
                  actions: (gate.allowed
                    ? action({
                      href: `/org/${s.org.id}/artifacts/${a.id}/regenerate`,
                      label: 'Regenerate', tone: 'quiet',
                    })
                    : '')
                    + action({ href: `/org/${s.org.id}/artifacts/${a.id}`, label: 'Read', tone: 'quiet' }),
                });
              }).join(''),
            })
            : '')
          + section({
            title: 'What you can produce',
            note: 'A document that cannot be generated says exactly what is missing rather than '
                + 'coming out with holes in it.',
            body: list.value.artifacts.map((a) => record({
              title: a.title,
              meta: a.purpose,
              body: `<p class="note">${a.coverage.required_present} of ${a.coverage.required_total} required figures present.</p>`,
              actions: gate.allowed
                ? `<form method="post" action="/org/${s.org.id}/artifacts" class="inline">
                    ${csrfField(s.csrf)}<input type="hidden" name="kind" value="${h(a.kind)}">
                    <button class="button button-quiet" type="submit">Generate</button></form>`
                : '',
            })).join(''),
          }),
      }));
    },
  },

  {
    path: '/org/:org/artifacts', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'artifacts' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => artifacts.generate(req.ctx, s.org.id, req.body.kind));
      if (!r.ok) return r.response;

      if (r.value.body.blocked) {
        return s.render('Documents out', page({
          title: 'Not yet',
          lede: 'This document was not generated, because it would have been wrong.',
          body: r.value.body.blockers.map((b) => record({
            title: b.problem,
            meta: b.code,
            state: 'blocked',
          })).join('') + `<p><a href="/org/${s.org.id}/artifacts">Back</a></p>`,
        }));
      }
      return { redirect: `/org/${s.org.id}/artifacts` };
    },
  },

  // ─────────────────────────────────────────────────────────── sharing ──
  {
    path: '/org/:org/sharing', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const gate = can(ctx, s.org.id, 'LIVE_SHARING');
      const listed = attempt(s, () => sharing.listShares(ctx, s.org.id).body);
      if (!listed.ok) return listed.response;
      const shares = [...listed.value.shares]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const generated = ctx.db.find('artifact', { org_id: s.org.id })
        .filter((a) => a.generated_at && !a.superseded_by)
        .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));

      const pending = sharing.pendingUpdates(ctx, s.org.id).body;
      const questions = sharing.questionLog(ctx, s.org.id).body;

      return s.render('Sharing', page({
        title: 'Sharing',
        lede: 'One link per recipient, never one link for everybody. A link you cannot withdraw from '
            + 'one person is a link you cannot withdraw.',
        actions: [
          action({ href: `/org/${s.org.id}/questions`, label: 'Questions', tone: 'quiet' }),
          action({ href: `/org/${s.org.id}/access`, label: 'Who has looked', tone: 'quiet' }),
          action({ href: `/org/${s.org.id}/sharing/updates`, label: 'Updates waiting', tone: 'quiet' }),
        ].join(''),
        body: gatedNote(gate)
          + (questions.unanswered
            ? banner({
              tone: 'warn',
              says: `${questions.unanswered} question${questions.unanswered === 1 ? '' : 's'} from a `
                  + 'recipient, unanswered.',
              detail: 'In a live process this is usually the thing holding it up.',
            })
            : '')
          + (pending.headline ? banner({ tone: 'info', says: pending.headline }) : '')
          + banner({
            tone: 'info',
            says: 'A link is a deterrent and a way to trace a leak. It is not protection.',
            detail: 'Anyone who can read a page can photograph it, and nothing here recalls a copy '
                  + 'that has already been downloaded. Material you cannot afford to have copied '
                  + 'should not be in the link.',
          })
          + (shares.length
            ? shares.map((sh) => record({
              title: sh.recipient_name,
              meta: `${sh.subject_kind.toLowerCase()} · ${sh.share_mode === 'PINNED' ? 'pinned to a version' : 'follows the latest'} · ${sh.state.toLowerCase()}${sh.expires_at ? `, expires ${String(sh.expires_at).slice(0, 10)}` : ''}`,
              state: sh.state === 'ACTIVE' ? 'active' : null,
              // The token prefix, not the token. It is the only part stored
              // readably, and it is enough to tell two links apart in the
              // access record — which is what somebody looking at this list
              // actually needs to do.
              body: `<p class="note">Link ${h(sh.token_prefix)}… · opened ${sh.views} time${sh.views === 1 ? '' : 's'}`
                + `${sh.last_opened_at ? `, last on ${String(sh.last_opened_at).slice(0, 10)}` : ' — never opened'}`
                + `${sh.questions ? ` · ${sh.questions} question${sh.questions === 1 ? '' : 's'} asked` : ''}</p>`,
              // The reason is labelled as yours, because it is: it goes on your
              // record and into the audit log, and the recipient is told only
              // that access was withdrawn.
              actions: sh.state === 'ACTIVE'
                ? `<form method="post" action="/org/${s.org.id}/sharing/${h(sh.id)}/revoke" class="inline">
                    ${csrfField(s.csrf)}
                    <input type="text" name="reason" size="20"
                      placeholder="Why — for your record" aria-label="Reason, for your own record">
                    <button class="button button-danger" type="submit">Revoke</button></form>`
                : '',
            })).join('')
            : emptyState({ says: 'No links issued yet.' }))
          + (gate.allowed
            ? section({
              title: 'Issue a link',
              note: 'A pinned link shows one version and says so. A document that changes under a '
                  + 'reader is worse than a stale one.',
              body: form({
                action: `/org/${s.org.id}/sharing`, csrf: s.csrf, submit: 'Issue link',
                body: field({ name: 'recipient_name', label: 'Who is it for?', required: true, hint: 'Named, so it can be withdrawn from them specifically.' })
                  + field({ name: 'recipient_org', label: 'Their firm', hint: 'Optional. It appears on the watermark.' })
                  + select({
                    name: 'subject_kind', label: 'What are they seeing?',
                    options: [{ value: 'ROOM', label: 'The data room' }, { value: 'ARTIFACT', label: 'One document' }],
                  })
                  // Offered rather than typed. An artifact link needs to name
                  // which document, and an earlier version of this form let
                  // somebody choose "one document" without saying which — which
                  // the service layer then refused, correctly and unhelpfully.
                  + (generated.length
                    ? select({
                      name: 'artifact_id', label: 'Which document',
                      hint: 'Only used when you chose one document above.',
                      options: generated.map((a) => ({
                        value: a.id,
                        label: `${a.title}${a.generated_at ? ` — ${String(a.generated_at).slice(0, 10)}` : ''}`,
                      })),
                    })
                    : '<p class="hint">Nothing has been generated yet, so only a data room link is '
                      + 'possible.</p>')
                  + select({
                    name: 'stage', label: 'At what stage?',
                    hint: 'Decides which folders they can see.',
                    options: ['PRE_MEETING', 'QUALIFIED', 'TERM_SHEET', 'CONFIRMATORY']
                      .map((v) => ({ value: v, label: v.replace('_', ' ').toLowerCase() })),
                  })
                  + select({
                    name: 'share_mode', label: 'Version',
                    options: [
                      { value: 'PINNED', label: 'Pinned — they see one version, dated' },
                      { value: 'FOLLOW_LATEST', label: 'Follows the latest' },
                    ],
                  }),
              }),
            })
            : ''),
      }));
    },
  },

  {
    path: '/org/:org/sharing', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => sharing.createShare(req.ctx, s.org.id, {
        recipient_name: req.body.recipient_name,
        recipient_org: req.body.recipient_org || null,
        subject_kind: req.body.subject_kind,
        // Sent only for an artifact link. Passing it on a room link would be
        // noise the service layer has to decide to ignore.
        artifact_id: req.body.subject_kind === 'ARTIFACT' ? req.body.artifact_id : null,
        stage: req.body.stage,
        share_mode: req.body.share_mode,
      }));
      if (!r.ok) return r.response;

      // The token is shown once. It is not stored in a readable form, so there
      // is no screen that could show it again — including this one, on a reload.
      const { token, token_note: tokenNote, mode } = r.value.body;
      const origin = req.url?.origin ?? '';

      return s.render('Sharing', page({
        title: 'Link issued',
        lede: tokenNote,
        body: `<p class="link-out"><code class="ref">${h(`${origin}/s/${token}`)}</code></p>`
          + banner({ tone: 'info', says: mode.label, detail: mode.means })
          + `<p class="note">Send it to them however you normally would. This product holds no email `
          + `address for your counterparties and does not contact them.</p>`
          + `<p><a href="/org/${s.org.id}/sharing">Back to sharing</a></p>`,
      }));
    },
  },

  {
    path: '/org/:org/sharing/:share/revoke', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        sharing.revokeShare(req.ctx, s.org.id, req.params.share, { reason: req.body.reason }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/sharing` };
    },
  },
];
