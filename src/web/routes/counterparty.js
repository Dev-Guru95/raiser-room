/**
 * Both ends of a share link: the page a counterparty sees, and the record the
 * company keeps of what they saw and asked.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PUBLIC ROUTES
 *
 * `/s/:token` is the only part of this application reachable without signing
 * in, so it is the only part worth attacking, and it is deliberately thin:
 *
 *   · Every route here hands the raw token to the service layer and renders
 *     what comes back. The access decision — revoked, expired, wrong shape,
 *     never existed — is made in one place below this layer and reaches here as
 *     a refusal with a sentence already written.
 *
 *   · A refusal never says which of those it was in a way that distinguishes a
 *     real token from an invented one. That wording is the service layer's and
 *     is not improved on here.
 *
 *   · The token is in the path, so it is in the browser's history and in any
 *     referrer. The page carries `noindex` and `no-referrer`, and the link is
 *     named to one recipient precisely so that it can be withdrawn from them
 *     when it leaks.
 *
 *   · Nothing on these routes takes a session cookie, so there is no CSRF token
 *     to check and `auth: false` is set on each. The question form is still a
 *     POST because it writes; it is authorised by holding the link, which is the
 *     same thing that authorises reading the page.
 */

import * as sharing from '../../api/sharing.js';
import { shell, attempt } from './shell.js';
import {
  sharedLayout, page, section, record, table, form, textarea, emptyState, banner, h, action, csrfField, pill, ref,
} from '../html.js';

/**
 * A refusal shown to somebody who is not a user of this product.
 *
 * `status` and `says` both come from the access decision taken below this
 * layer. There is no fallback for either: a decision arriving without them
 * would be a bug worth seeing rather than one worth papering over with a 403
 * this layer chose.
 */
const refusedPage = (decision) => ({
  status: decision.status,
  html: sharedLayout({
    title: 'This link is not open',
    body: page({
      title: 'This link is not open',
      body: banner({
        tone: 'warn',
        says: decision.says ?? 'This link cannot be opened.',
        detail: 'If you were expecting to see something here, ask the company that sent it for a new '
              + 'link. Links are issued to one recipient and can be withdrawn, so an old one stops '
              + 'working on purpose.',
      }),
    }),
  }),
});

export const counterpartyRoutes = [
  // ──────────────────────────────────────────── the counterparty's page ──
  {
    path: '/s/:token', method: 'GET', auth: false,
    handle: (req) => {
      const { ctx } = req;
      // `openShare` returns a refusal rather than throwing, because a closed
      // link is a normal outcome rather than an error.
      const opened = sharing.openShare(ctx, req.params.token, { clientFamily: null });
      if (!opened.body.allowed) return refusedPage({ ...opened.body, status: opened.status });

      const v = opened.body;
      const asked = req.query.get('asked') === '1';

      const roomBody = v.room
        ? v.room.folders.map((f) => section({
          title: `${f.key} ${f.name}`,
          body: f.items.length
            ? table({
              columns: [
                { key: 'ref', label: 'Ref' },
                { key: 'name', label: 'Document' },
              ],
              rows: f.items.map((i) => ({ ref: i.ref, name: i.name })),
            })
            : emptyState({ says: 'Nothing filed in this folder.' }),
        })).join('')
          + (v.room.withheld_count
            ? banner({
              tone: 'info',
              says: `${v.room.withheld_count} further folder${v.room.withheld_count === 1 ? '' : 's'} `
                  + 'open at later stages of this process.',
              // The service layer's note says the same thing the headline
              // already says, so repeating it under the headline would be a
              // second sentence carrying nothing. What a reader actually wants
              // to know here is whether the index above is complete for them,
              // and it is.
              detail: 'Nothing is missing from the index above at this stage — these were staged '
                    + 'when the link was made, not withheld on request.',
            })
            : '')
        : '';

      const documentBody = v.document
        ? `<div class="paper-frame"><iframe title="${h(v.document.title)}" class="paper"
             src="/s/${h(req.params.token)}/document" sandbox referrerpolicy="no-referrer"></iframe></div>`
        : (v.document === null && !v.room
          ? banner({
            tone: 'warn',
            says: 'The document behind this link is not available.',
            detail: 'Ask the company that sent it.',
          })
          : '');

      return {
        html: sharedLayout({
          title: v.document?.title ?? 'Data room',
          company: v.company,
          watermark: v.watermark,
          illustrative: v.illustrative,
          flash: asked
            ? { tone: 'good', says: 'Your question has been passed on and recorded.' }
            : null,
          body: page({
            title: v.document?.title ?? `${v.company ?? 'Company'} — data room`,
            lede: `Prepared for ${v.recipient}. ${v.mode.means}`,
            body: `<p>${pill(v.mode.label, 'active')} ${
              v.stage ? pill(String(v.stage.id).replace('_', ' ').toLowerCase(), 'neutral') : ''}</p>`
              + `<p class="note">As at ${String(v.as_at).slice(0, 10)}`
              + `${v.expires_at ? `. This link expires on ${String(v.expires_at).slice(0, 10)}` : ''}.</p>`
              + (v.stage ? `<p class="note">${h(v.stage.means)}</p>` : '')
              + (v.updated_since_sent
                ? banner({
                  tone: 'info',
                  says: 'A newer version of this document has been published to you since it was first '
                      + 'sent.',
                  detail: 'What you are reading is the current one.',
                })
                : '')
              + documentBody
              + roomBody
              + section({
                title: 'Ask a question',
                note: 'Questions are recorded, and so is the answer. That is deliberate: the damaging '
                    + 'thing is not an imperfect answer, it is two different answers to the same '
                    + 'question given to two people.',
                body: form({
                  action: `/s/${h(req.params.token)}/ask`,
                  // No session, so no CSRF token to carry. Holding the link is
                  // what authorises this, exactly as it authorises the page.
                  csrf: '',
                  submit: 'Send',
                  body: textarea({
                    name: 'question', label: 'Your question', rows: 3,
                    hint: 'It goes to the company, not to an assistant. Nothing here answers on their '
                        + 'behalf.',
                  }),
                }),
              })
              // ──────────────────────────────────────────────────────────────
              // THE DOWNLOAD POSTURE IS NOT SHOWN HERE, DELIBERATELY
              //
              // `downloadPosture` returns "The recipient can download a
              // watermarked copy" when downloads are allowed, and this page
              // used to print it. There is no download control on it, so that
              // sentence was telling a counterparty they could do something
              // the application does not let them do.
              //
              // The posture is advice to the *company* about what a sharing
              // control does and does not achieve — the function's own comment
              // says overclaiming here is worse than not having the feature —
              // so it belongs on the owner's sharing page, which is where it
              // now is. When a share-scoped download exists, the sentence comes
              // back here alongside the button it describes.
              + '',
          }),
        }),
      };
    },
  },

  /**
   * The document itself, in its own sandbox.
   *
   * Same reasoning as the owner-facing view: a generated document is a full HTML
   * page with inline styles, so it is served under `sandbox` with
   * `default-src 'none'` and shown in a frame. On this route that matters more,
   * not less — the reader is outside the company.
   */
  {
    path: '/s/:token/document', method: 'GET', auth: false,
    handle: (req) => {
      let result;
      try {
        result = sharing.readThroughShare(req.ctx, req.params.token);
      } catch (err) {
        return {
          status: err.status ?? 409,
          contentType: 'text/html; charset=utf-8',
          headers: { 'Content-Security-Policy': "sandbox; default-src 'none'" },
          html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not available</title>`
            + `</head><body><p>${h(err.message ?? 'This link does not carry a document.')}</p></body></html>`,
        };
      }

      if (!result.body.allowed) return refusedPage({ ...result.body, status: result.status });
      if (!result.body.html) {
        return {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'Content-Security-Policy': "sandbox; default-src 'none'" },
          html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not stored</title>'
            + '</head><body><p>This document was generated before file storage was configured, so the '
            + 'file itself is not available.</p></body></html>',
        };
      }

      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: {
          'Content-Security-Policy':
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'private, no-store',
        },
        html: result.body.html,
      };
    },
  },

  {
    path: '/s/:token/ask', method: 'POST', auth: false,
    handle: (req) => {
      const { ctx } = req;
      let result;
      try {
        result = sharing.askThroughShare(ctx, req.params.token, { question: req.body.question });
      } catch (err) {
        return {
          status: err.status ?? 400,
          html: sharedLayout({
            title: 'Not sent',
            body: page({
              title: 'Not sent',
              body: banner({ tone: 'warn', says: err.message ?? 'That question could not be recorded.' })
                + `<p><a href="/s/${h(req.params.token)}">Back</a></p>`,
            }),
          }),
        };
      }

      if (!result.body.allowed && result.body.code) {
        return refusedPage({ ...result.body, status: result.status });
      }
      return { redirect: `/s/${encodeURIComponent(req.params.token)}?asked=1` };
    },
  },

  // ───────────────────────────────────────────── the company's own record ──
  {
    path: '/org/:org/questions', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const log = attempt(s, () => sharing.questionLog(ctx, s.org.id).body);
      if (!log.ok) return log.response;
      const { questions, unanswered, basis } = log.value;

      const rows = questions.map((q) => record({
        title: q.question,
        meta: `${q.asked_by}${q.asked_by_org ? ` · ${q.asked_by_org}` : ''}`
          + ` · asked ${String(q.asked_at).slice(0, 10)}`,
        state: q.answer ? 'done' : 'attention',
        body: q.answer
          ? `<p class="note">Answered ${String(q.answered_at).slice(0, 10)}:</p><p>${h(q.answer)}</p>`
          : `<form class="form is-compact" method="post" action="/org/${s.org.id}/questions/${h(q.id)}/draft">
              ${csrfField(s.csrf)}
              ${textarea({
    name: 'answer', label: 'Draft an answer', rows: 3,
    hint: 'Drafting first checks it against what has already been said to anybody else. '
                    + 'Nothing is sent by drafting.',
  })}
              <div class="form-actions">
                <button class="button button-quiet" type="submit">Check this draft</button>
              </div>
            </form>`,
      })).join('');

      return s.render('Questions', page({
        title: 'Questions',
        lede: basis,
        actions: action({ href: `/org/${s.org.id}/sharing`, label: 'Back to sharing', tone: 'quiet' }),
        body: (unanswered
          ? banner({
            tone: 'warn',
            says: `${unanswered} question${unanswered === 1 ? '' : 's'} unanswered.`,
            detail: 'An unanswered question in a live process is usually the thing holding it up.',
          })
          : '')
          + (rows || emptyState({
            says: 'Nobody has asked anything through a share link yet. When they do it lands here, '
                + 'with who asked and when.',
          })),
      }));
    },
  },

  /**
   * Draft an answer, and see what was already said.
   *
   * Two routes rather than one, because checking and sending are different acts
   * and conflating them is how two parties get told two things.
   */
  {
    path: '/org/:org/questions/:question/draft', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;

      const r = attempt(s, () => sharing.draftAnswer(req.ctx, s.org.id, req.params.question, {
        answer: req.body.answer,
      }));
      if (!r.ok) return r.response;
      const { question, similar, warning } = r.value.body;

      return s.render('Check this answer', page({
        title: 'Before you send this',
        lede: question.question,
        body: (warning
          ? banner({ tone: 'warn', says: warning.says })
          : '')
          + section({
            title: 'Your draft',
            body: `<p>${h(req.body.answer ?? '')}</p>`,
          })
          + (similar.length
            ? section({
              title: `${similar.length} earlier question${similar.length === 1 ? '' : 's'} close to this one`,
              note: 'Read what was said before answering. Two different answers to the same question '
                  + 'given to two parties does more damage than either answer being imperfect. '
                  + 'Similarity is word overlap, not a judgement — it is shown so a person can make one.',
              // `similarQuestions` only ever returns questions that were
              // answered, so every row here has an answer to compare against.
              body: similar.map((q) => record({
                title: q.question,
                meta: `answered ${String(q.answered_at).slice(0, 10)} · ${Math.round(q.score * 100)}% word overlap`,
                state: 'active',
                body: `<p>${h(q.answer)}</p>`,
              })).join(''),
            })
            : section({
              title: 'Nothing like this has been asked before',
              body: '<p class="note">So there is nothing to be inconsistent with.</p>',
            }))
          + section({
            title: 'Send it',
            note: 'Recorded against this question, with who sent it and when.',
            body: `<form class="form is-compact" method="post" action="/org/${s.org.id}/questions/${h(req.params.question)}">
                ${csrfField(s.csrf)}
                ${textarea({ name: 'answer', label: 'The answer', value: req.body.answer ?? '', rows: 4 })}
                <div class="form-actions">
                  <button class="button" type="submit">Send this answer</button>
                  <a class="button button-quiet" href="/org/${s.org.id}/questions">Leave it for now</a>
                </div>
              </form>`,
          }),
      }));
    },
  },

  {
    path: '/org/:org/questions/:question', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => sharing.answerQuestion(req.ctx, s.org.id, req.params.question, {
        answer: req.body.answer,
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/questions` };
    },
  },

  // ───────────────────────────────────────────────────── the access record ──
  {
    path: '/org/:org/access', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const rec = attempt(s, () => sharing.accessRecord(ctx, s.org.id).body);
      if (!rec.ok) return rec.response;
      const { access, active, never_opened: neverOpened, criterion, privacy_note: privacy } = rec.value;

      return s.render('Who has looked', page({
        title: 'Who has looked',
        lede: 'One row per link, with how often it was opened and for how long. This is the record a '
            + 'counterparty\'s own diligence checklist asks for, and it exists because the product was '
            + 'used rather than because somebody kept a spreadsheet.',
        actions: action({ href: `/org/${s.org.id}/sharing`, label: 'Back to sharing', tone: 'quiet' }),
        body: (neverOpened
          ? banner({
            tone: 'info',
            says: `${neverOpened} link${neverOpened === 1 ? ' has' : 's have'} never been opened.`,
            detail: 'Worth knowing before you follow up on something somebody has not read.',
          })
          : '')
          + table({
            columns: [
              { key: 'recipient', label: 'Recipient' },
              { key: 'subject', label: 'Shown' },
              { key: 'state', label: 'Link' },
              { key: 'opens', label: 'Opens', align: 'right' },
              { key: 'time', label: 'Time spent', align: 'right' },
              { key: 'last', label: 'Last opened' },
            ],
            rows: access.map((a) => ({
              recipient: `${a.recipient}${a.recipient_org ? ` (${a.recipient_org})` : ''}`,
              // "artifact" is the word the schema uses; the person reading this
              // page issued a link to one document. And a stage only applies to
              // a room link, so joining it unconditionally printed a dangling
              // separator with nothing after it.
              subject: [
                a.subject === 'ARTIFACT' ? 'one document' : 'the data room',
                a.stage ? String(a.stage).replace('_', ' ').toLowerCase() : null,
              ].filter(Boolean).join(' · '),
              state: String(a.state).toLowerCase(),
              opens: String(a.opens),
              time: a.total_seconds ? `${Math.round(a.total_seconds / 60)} min` : '—',
              last: a.last_opened_at ? String(a.last_opened_at).slice(0, 10) : 'never',
            })),
            empty: 'No link has been issued yet.',
          })
          + section({
            title: 'What is not recorded',
            note: `Criterion ${criterion}.`,
            body: `<p>${h(privacy)}</p>`,
          })
          + `<p class="note">${active} link${active === 1 ? '' : 's'} currently active.</p>`,
      }), { wide: true });
    },
  },

  // ─────────────────────────────── pinned links with a newer version waiting ──
  {
    path: '/org/:org/sharing/updates', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const pend = attempt(s, () => sharing.pendingUpdates(ctx, s.org.id).body);
      if (!pend.ok) return pend.response;
      const { pending, count, headline } = pend.value;

      return s.render('Updates waiting', page({
        title: 'Updates waiting',
        lede: 'A pinned link shows the version it was issued with until you publish the newer one to '
            + 'that recipient. Nothing changes under a reader without them being told.',
        actions: action({ href: `/org/${s.org.id}/sharing`, label: 'Back to sharing', tone: 'quiet' }),
        body: (headline ? banner({ tone: 'info', says: headline }) : '')
          + (count
            ? pending.map((p) => record({
              title: p.share.recipient_name,
              meta: `${p.figures_moving
                ? `${p.figures_moving} figure${p.figures_moving === 1 ? '' : 's'} moved`
                : 'nothing moved'}`
                + `${p.current_artifact_id ? '' : ' · no newer version generated yet'}`,
              state: p.figures_moving ? 'attention' : 'active',
              body: (p.changes.length
                ? table({
                  columns: [
                    { key: 'label', label: 'Figure' },
                    { key: 'was', label: 'They see', align: 'right' },
                    { key: 'now', label: 'Now', align: 'right' },
                  ],
                  rows: p.changes.map((c) => ({
                    label: c.label ?? c.fact_key,
                    was: String(c.was ?? '—'),
                    now: String(c.now ?? '—'),
                  })),
                })
                : '<p class="note">The newer version differs only in where its figures came from.</p>')
                + section({
                  title: 'What to send them',
                  note: p.draft.why,
                  body: `<p class="note">Subject: ${h(p.draft.subject)}</p>`
                    + `<pre class="draft">${h(p.draft.body)}</pre>`,
                }),
              // Publishing is only possible once a newer version exists. Until
              // then the figures have moved but nothing has been regenerated,
              // and the honest control is the one that makes the new version.
              actions: p.current_artifact_id
                ? action({
                  label: 'Publish to them',
                  tone: 'quiet',
                  confirm: `/org/${s.org.id}/sharing/${h(p.share.id)}/publish`,
                  csrf: s.csrf,
                })
                : action({
                  href: `/org/${s.org.id}/artifacts/${h(p.pinned_artifact_id)}/regenerate`,
                  label: 'Make the new version first', tone: 'quiet',
                }),
            })).join('')
            : emptyState({
              says: 'Every pinned link is showing the current version. Nothing is waiting.',
            })),
      }), { wide: true });
    },
  },

  {
    path: '/org/:org/sharing/:share/publish', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'sharing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => sharing.publishUpdate(req.ctx, s.org.id, req.params.share));
      if (!r.ok) return r.response;

      // The reminder is the point of this screen. The product cannot send the
      // message — it holds no address for a counterparty, and a tool that
      // mailed your investors on your behalf would be the wrong kind of
      // helpful — so it says so and the words were on the page before this one.
      return s.render('Published', page({
        title: 'Published to them',
        lede: 'Their link now shows the newer version, and says that it changed.',
        body: banner({ tone: 'warn', says: r.value.body.reminder })
          + action({ href: `/org/${s.org.id}/sharing`, label: 'Back to sharing', tone: 'quiet' }),
      }));
    },
  },
];
