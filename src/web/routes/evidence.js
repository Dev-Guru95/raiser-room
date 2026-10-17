/**
 * The evidence surfaces: contradictions, reviewing what was read out of a
 * document, and transcribing the paper workbook.
 *
 * These three belong together because they are the places where a figure's
 * standing changes — where something becomes trusted, stays untrusted, or turns
 * out to disagree with something else. Everywhere else in the product a figure
 * is just displayed with its provenance; here is where the provenance is decided.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ONE THING THE CONFLICT PAGE MUST NOT DO
 *
 * It must not look like a verdict. The detection rules say so themselves — a
 * detected conflict is a prompt to check your own records, not a finding about
 * which record is right — and the service layer backs that up by refusing to let
 * a resolution touch either figure. Choosing a side records which record you
 * trust. Correcting a figure is a separate, deliberate act.
 *
 * So the page shows the two sides level, with no tick next to either, and says
 * plainly that resolving changes nothing. A product that quietly "fixed" the
 * loser would be doing the single thing this one exists to prevent.
 */

import * as extraction from '../../api/extraction.js';
import * as onramp from '../../api/onramp.js';
import {  } from '../../domain/conflicts.js';
import { isDecided } from '../../domain/extraction.js';
import {
  SCORE_FIELD_OF, FACT_FIELDS, KEY_PERSON_FIELDS, META_FIELDS, TRANSFER_SHEET_VERSION,
} from '../../domain/transfer-sheet.js';
import { DOMAINS, SCALE } from '../../domain/criteria.js';
import { shell, attempt } from './shell.js';
import {
  page, section, record, form, field, select, textarea, emptyState, banner, h, action, csrfField, ref, pill,
} from '../html.js';

/** A severity, in a word rather than only a colour. */
const severityPill = (severity) => pill(
  severity === 'HIGH' ? 'Check this first' : severity === 'MEDIUM' ? 'Worth checking' : 'Minor',
  severity === 'HIGH' ? 'bad' : severity === 'MEDIUM' ? 'warn' : 'neutral',
);

const recordState = (severity) =>
  (severity === 'HIGH' ? 'blocked' : severity === 'MEDIUM' ? 'attention' : null);

export const evidenceRoutes = [
  // ─────────────────────────────────────────────────────── contradictions ──
  {
    path: '/org/:org/conflicts', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'facts' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const showResolved = req.query.get('resolved') === '1';
      const found = attempt(s, () =>
        extraction.listConflicts(ctx, s.org.id, { includeResolved: showResolved }).body);
      if (!found.ok) return found.response;

      const { conflicts, summary, source } = found.value;
      const readiness = extraction.generationReadiness(ctx, s.org.id).body;

      const rows = conflicts.map((c) => record({
        title: c.detail,
        meta: `${String(c.kind).replace(/_/g, ' ').toLowerCase()}${c.rule ? ` · ${c.rule.name ?? c.rule_ref}` : ''}`,
        state: c.resolved_at ? 'done' : recordState(c.severity),
        body: `<p>${severityPill(c.severity)}</p>
          <div class="sides">
            <div class="side">
              <h3 class="side-head">One record says</h3>
              <p>${h(c.left_summary)}</p>
            </div>
            <div class="side">
              <h3 class="side-head">The other says</h3>
              <p>${h(c.right_summary)}</p>
            </div>
          </div>
          ${c.rule?.why ? `<p class="note">${h(c.rule.why)}</p>` : ''}
          ${c.resolved_at
    ? `<p class="note">Settled ${String(c.resolved_at).slice(0, 10)}: kept ${
      c.resolution === 'LEFT' ? 'the first record'
        : c.resolution === 'RIGHT' ? 'the second record' : 'neither'
    }. ${h(c.resolution_note ?? '')}</p>`
    : `<form class="form is-compact" method="post" action="/org/${s.org.id}/conflicts/${h(c.id)}">
                ${csrfField(s.csrf)}
                ${select({
      name: 'resolution', label: 'Which record do you trust?',
      hint: 'Neither figure changes. This records which one you went with, and that is a '
                      + 'different act from correcting a number.',
      options: [
        { value: 'LEFT', label: 'The first record' },
        { value: 'RIGHT', label: 'The second record' },
        { value: 'NEITHER', label: 'Neither — both need checking' },
      ],
    })}
                ${textarea({
      name: 'note', label: 'Why', rows: 2,
      hint: 'In six months this is the only record of why one figure was preferred, and that '
                      + 'is the question you will be asked. At least a sentence.',
    })}
                <div class="form-actions"><button class="button" type="submit">Record this</button></div>
              </form>`}`,
      })).join('');

      return s.render('Contradictions', page({
        title: 'Contradictions',
        lede: source.note,
        body: (readiness.can_generate
          ? ''
          : banner({
            tone: 'warn',
            says: readiness.reason ?? 'Documents cannot be generated while a serious contradiction is open.',
            detail: 'Rendering a document from figures known to contradict each other would put this '
                  + 'product\'s name on the contradiction. Settle the ones marked "check this first" '
                  + 'and generation opens again.',
          }))
          + (summary.total
            ? `<p class="note">${summary.open} open, ${summary.resolved} settled. `
              + `${summary.open_high} to check first, ${summary.open_medium} worth checking, `
              + `${summary.open_low} minor.</p>`
            : '')
          + (rows || emptyState({
            says: showResolved
              ? 'Nothing has been detected, settled or otherwise.'
              : 'No contradictions open. Two records disagreeing about the same figure is the single '
                + 'most common thing a counterparty finds, so an empty list here is worth having.',
            action: summary.resolved
              ? action({ href: `/org/${s.org.id}/conflicts?resolved=1`, label: 'Show settled ones' })
              : null,
          }))
          + section({
            title: 'How these are detected',
            note: `${source.title}, version ${source.version}, reviewed ${source.reviewed}.`,
            body: '<p>Rounding is not a contradiction. A figure quoted as $4.2m against $4,199,614 in '
                + 'the accounts is one number presented two ways, and flagging it would train you to '
                + 'dismiss this list — which is how a real contradiction gets missed. Percentages are '
                + 'checked both ways, absolute and relative, because neither bound works alone at '
                + 'both ends of the scale.</p>'
              + (showResolved
                ? `<p><a href="/org/${s.org.id}/conflicts">Show only what is open</a></p>`
                : summary.resolved
                  ? `<p><a href="/org/${s.org.id}/conflicts?resolved=1">Show settled ones too</a></p>`
                  : ''),
          }),
      }));
    },
  },

  {
    path: '/org/:org/conflicts/:conflict', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'facts' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => extraction.resolveConflict(req.ctx, s.org.id, req.params.conflict, {
        resolution: req.body.resolution,
        note: req.body.note,
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/conflicts` };
    },
  },

  // ──────────────────────────────────── what was read out of a document ──
  {
    path: '/org/:org/documents/:document/review', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const document = ctx.db.get('document', req.params.document);
      if (!document || document.org_id !== s.org.id) {
        return s.refuse({ code: 'not_found', status: 404 }, 'Not found');
      }

      const kind = attempt(s, () => extraction.suggestKind(ctx, s.org.id, document.id).body);
      if (!kind.ok) return kind.response;

      const runs = ctx.db.find('extraction', { document_id: document.id });
      const candidates = runs.flatMap((run) =>
        ctx.db.find('extraction_candidate', { extraction_id: run.id }));
      // `isDecided` is the domain's own predicate over the state enum. Writing
      // the state names out here is how this page first came to filter for
      // `PENDING` and `VIEWED`, neither of which exists — which put every
      // candidate in the "already decided" list and none in the one asking for
      // a decision.
      const outstanding = candidates.filter((c) => !isDecided(c.state));
      const decided = candidates.filter((c) => isDecided(c.state));

      const candidateRecord = (c) => record({
        title: `${c.label ?? c.fact_key}: ${c.value_numeric ?? c.value_text ?? '—'}${c.unit ? ` ${c.unit}` : ''}`,
        meta: `${c.fact_key}${c.source_page ? ` · page ${c.source_page}` : ''}`,
        state: 'attention',
        body: (c.locator ? `<p class="note">Read from: ${h(c.locator)}</p>` : '')
          + `<form class="form is-compact" method="post" action="/org/${s.org.id}/documents/${h(document.id)}/review">
              ${csrfField(s.csrf)}
              <input type="hidden" name="candidate" value="${h(c.id)}">
              ${field({
    name: 'value_numeric', label: 'Confirm, or correct it first',
    type: 'number', step: 'any',
    value: String(c.value_numeric ?? ''),
    hint: 'Change the number and what the extractor read stays on the record beside what you '
                    + 'corrected it to. Both are kept, permanently.',
  })}
              <div class="form-actions">
                <button class="button" type="submit" name="decision" value="CONFIRM">Confirm</button>
              </div>
            </form>
            <form class="form is-compact" method="post" action="/org/${s.org.id}/documents/${h(document.id)}/review">
              ${csrfField(s.csrf)}
              <input type="hidden" name="candidate" value="${h(c.id)}">
              ${field({
    name: 'reason', label: 'Or reject it, and say why',
    hint: 'In three months this is the only record of why a figure in your own document was '
                    + 'not used.',
  })}
              <div class="form-actions">
                <button class="button button-danger" type="submit" name="decision" value="REJECT">Reject</button>
              </div>
            </form>`,
      });

      return s.render(document.filename, page({
        title: document.filename,
        lede: `${String(document.kind).replace(/_/g, ' ').toLowerCase()}`
            + `${document.uploaded_at ? `, uploaded ${String(document.uploaded_at).slice(0, 10)}` : ''}.`,
        actions: action({
          href: `/org/${s.org.id}/documents`, label: 'Back to documents', tone: 'quiet',
        }),
        body: (kind.value.suggestion && kind.value.suggestion.kind !== document.kind
          ? banner({
            tone: 'info',
            says: `This looks like ${String(kind.value.suggestion.kind).replace(/_/g, ' ').toLowerCase()} `
                + `rather than ${String(document.kind).replace(/_/g, ' ').toLowerCase()}.`,
            detail: `Because ${kind.value.suggestion.basis}. That is a guess from the filename, not a `
                  + 'reading of the contents, so it is shown rather than applied.',
          })
          : '')
          + (outstanding.length
            ? section({
              title: `${outstanding.length} figure${outstanding.length === 1 ? '' : 's'} waiting`,
              note: 'A figure read from a document is a proposal until somebody confirms it. Nothing '
                  + 'uses these until you do — not a generated document, not the assessment, not the '
                  + 'advisor.',
              body: outstanding.map(candidateRecord).join(''),
            })
            : section({
              title: 'Nothing waiting',
              body: emptyState({
                says: candidates.length
                  ? 'Every figure read from this document has been decided.'
                  : 'Nothing has been read out of this document. Extraction proposes figures; it never '
                    + 'records them, so a document with nothing extracted is a document whose figures '
                    + 'you record by hand.',
                action: action({ href: `/org/${s.org.id}/facts`, label: 'Record a figure by hand' }),
              }),
            }))
          + (decided.length
            ? section({
              title: 'Already decided',
              note: 'Kept so that what the extractor read and what a person made of it are both on '
                  + 'the record.',
              body: decided.map((c) => record({
                title: `${c.label ?? c.fact_key}: ${c.value_numeric ?? c.value_text ?? '—'}`,
                meta: `${String(c.state).replace(/_/g, ' ').toLowerCase()}`
                  + `${c.decided_at ? ` ${String(c.decided_at).slice(0, 10)}` : ''}`,
                state: c.state === 'REJECTED' ? null : 'done',
                body: c.reject_reason ? `<p class="note">${h(c.reject_reason)}</p>` : '',
              })).join(''),
            })
            : ''),
      }));
    },
  },

  {
    path: '/org/:org/documents/:document/review', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'documents' });
      if (!s.ok) return s.response;

      const decision = req.body.decision === 'REJECT' ? 'REJECT' : 'CONFIRM';
      // An edit is only an edit if the number actually changed; sending the
      // value back untouched must record a plain confirmation, not an
      // "edited" one. `decideCandidate` compares for us, so the value is
      // passed as an edit and it decides which it was.
      const edits = decision === 'CONFIRM' && req.body.value_numeric !== ''
        ? { value_numeric: Number(req.body.value_numeric) }
        : null;

      const r = attempt(s, () => extraction.decideCandidate(req.ctx, s.org.id, req.body.candidate, {
        decision, edits, reason: req.body.reason,
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/documents/${req.params.document}/review` };
    },
  },

  // ───────────────────────────────────────────────── the paper workbook ──

  /**
   * Transcribing the Transfer Sheet.
   *
   * The sheet is the last page of the printed workbook, and it exists so that
   * somebody who filled in a book by hand does not have to start again. So this
   * page is laid out as the sheet is laid out, worksheet by worksheet, in the
   * same order — because the person using it is reading from paper and typing,
   * and any other order makes them hunt.
   *
   * A blank box is deliberately blank, never zero. The parser knows the
   * difference and so does this form: nothing is pre-filled with a default.
   */
  {
    path: '/org/:org/transfer-sheet', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const credit = onramp.creditStatus(ctx, s.org.id).body;
      const already = ctx.db.findOne('workbook_redemption', { org_id: s.org.id });

      if (already) {
        return s.render('Transfer Sheet', page({
          title: 'Already transcribed',
          lede: 'This organisation has redeemed a workbook.',
          body: banner({
            tone: 'info',
            says: 'One redemption per organisation, and one per receipt.',
            detail: 'A credit that can be claimed twice is a credit that will be. Everything the sheet '
                  + 'carried is in your figures and your assessment now.',
          }) + action({ href: `/org/${s.org.id}/facts`, label: 'Go to your figures', tone: 'quiet' }),
        }));
      }

      const scoreGrid = DOMAINS.map((d) => `
        <fieldset class="block">
          <legend><h3>${h(d.n)}. ${h(d.name)}</h3></legend>
          <div class="grid-scores">
            ${d.criteria.map((c) => `
              <div class="field is-tight">
                <label for="f-${h(SCORE_FIELD_OF(c.ref))}">
                  <span class="ref">${h(c.ref)}</span> ${h(c.text)}
                </label>
                <input id="f-${h(SCORE_FIELD_OF(c.ref))}" name="${h(SCORE_FIELD_OF(c.ref))}"
                  type="number" min="0" max="5" step="1" inputmode="numeric"
                  placeholder="blank">
              </div>`).join('')}
          </div>
        </fieldset>`).join('');

      const factField = (f) => (f.type === 'choice'
        ? select({
          name: f.field,
          label: f.label,
          options: [{ value: '', label: 'Left blank' },
            ...f.choices.map((c) => ({ value: c, label: c.toLowerCase() }))],
        })
        : field({
          name: f.field,
          label: f.label,
          type: f.type === 'number' ? 'number' : 'text',
          step: f.type === 'number' ? 'any' : null,
          hint: f.unit === 'percent' ? 'A percentage, so 34 rather than 0.34.' : null,
          placeholder: 'blank',
        }));

      const byWorksheet = (n) => FACT_FIELDS.filter((f) => f.worksheet === n).map(factField).join('');

      return s.render('Transfer Sheet', page({
        title: 'Transcribe the workbook',
        lede: 'The sheet from the back of the book, box for box and in the same order. A box you left '
            + 'blank stays blank here — blank is not zero, and the difference matters to the score.',
        body: (credit.credit
          ? banner({
            tone: 'good',
            says: `A ${credit.credit.display ?? ''} credit is already recorded for this organisation.`,
          })
          : banner({
            tone: 'info',
            says: credit.note,
            detail: 'The receipt reference is on your purchase confirmation. It is checked for having '
                  + 'been used before, not for being valid — verification happens before it reaches '
                  + 'this form.',
          }))
          // A form the width of a login box would put thirty-two criteria in a
          // single narrow column with the text wrapping four lines deep, next
          // to half a screen of nothing. Somebody copying from paper reads the
          // criterion and types a digit, so the criterion gets the room.
          + `<form class="form is-sheet" method="post" action="/org/${s.org.id}/transfer-sheet">
              ${csrfField(s.csrf)}
              <input type="hidden" name="${h(META_FIELDS.version)}" value="${h(TRANSFER_SHEET_VERSION)}">
              ${section({
    title: 'Your receipt',
    body: field({
      name: META_FIELDS.receipt, label: 'Receipt reference', required: true,
      hint: 'From the purchase confirmation.',
    }),
  })}
              ${section({
    title: 'Worksheet 1 — the thirty-two scores',
    note: `Nought to five, as the book defines them: ${SCALE.map((sc) => `${sc.score} is ${sc.means.toLowerCase()}`).join('; ')}.`,
    body: scoreGrid,
  })}
              ${section({
    title: 'Worksheet 3 — the normalisation bridge',
    note: 'Reported profit and the normalised figure, with the period both refer to.',
    body: byWorksheet(3),
  })}
              ${section({
    title: 'Worksheet 4 — customer concentration',
    note: 'The share of revenue your largest customers account for, and whether it is going up.',
    body: byWorksheet(4),
  })}
              ${section({
    title: 'Worksheet 5 — key people',
    note: 'Who holds something the business cannot lose, what they hold, and who could cover it. '
                  + 'A row with no deputy named is the point of the worksheet, not a gap in it.',
    body: KEY_PERSON_FIELDS.map((rowFields) => `
                  <div class="row-fields">
                    ${field({ name: rowFields.person, label: `Person ${rowFields.row}`, placeholder: 'blank' })}
                    ${field({ name: rowFields.holds, label: 'Holds', placeholder: 'blank' })}
                    ${field({ name: rowFields.deputy, label: 'Deputy', placeholder: 'nobody named' })}
                  </div>`).join(''),
  })}
              ${section({
    title: 'Worksheet 9 — the three load-bearing assumptions',
    note: 'Each one written so that it could be shown to be wrong.',
    body: byWorksheet(9),
  })}
              <div class="form-actions">
                <button class="button" type="submit">Transcribe and claim the credit</button>
              </div>
            </form>`,
      }), { wide: true });
    },
  },

  {
    path: '/org/:org/transfer-sheet', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;

      // The whole body is handed to the parser, which knows every field name and
      // ignores anything else — including the CSRF token. Picking out the fields
      // here would mean maintaining the sheet's field list in two places, and the
      // copy in the web layer would be the one that fell behind.
      const r = attempt(s, () => extraction.importTransferSheet(req.ctx, s.org.id, req.body, {
        redeem: onramp.redeemWorkbook,
      }));
      if (!r.ok) return r.response;

      const result = r.value.body;
      const problems = result.sheet?.problems ?? [];

      return s.render('Transfer Sheet', page({
        title: 'Transcribed',
        lede: `${result.sheet?.fields_read ?? 0} boxes read.`,
        body: banner({
          tone: 'good',
          says: 'Everything legible went in. Figures from the sheet are recorded as entered by hand, '
              + 'because that is what they are.',
          detail: 'Nothing was inferred, so nothing is marked as having been. Confirming any of them '
                + 'against the document it came from raises it from typed to confirmed.',
        })
          + (problems.length
            ? section({
              title: `${problems.length} box${problems.length === 1 ? '' : 'es'} could not be read`,
              note: 'Named rather than dropped. Refusing the whole sheet over one typo is how people '
                  + 'give up; dropping them quietly is how a figure goes missing without anybody '
                  + 'knowing.',
              body: problems.map((p) => record({
                title: p.field ?? 'a box',
                meta: p.severity === 'ERROR' ? 'not imported' : 'imported with a note',
                state: p.severity === 'ERROR' ? 'blocked' : 'attention',
                body: `<p class="note">${h(p.problem ?? p.says ?? String(p))}</p>`,
              })).join(''),
            })
            : '')
          + section({
            title: 'Where to go next',
            body: [
              ['Figures', 'facts', 'What the sheet put in, each marked as entered by hand.'],
              ['Readiness', 'readiness', 'Your scores from worksheet 1, now scoreable and banded.'],
              ['Gaps', 'gaps', 'Anything scoring three or below, in fix order.'],
            ].map(([title, path, meta]) => record({
              title, meta, href: `/org/${s.org.id}/${path}`, state: 'active',
            })).join(''),
          }),
      }));
    },
  },
];
