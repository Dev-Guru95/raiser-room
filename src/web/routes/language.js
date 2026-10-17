/**
 * Documents in another language.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS PAGE IS ACTUALLY FOR
 *
 * Not "translate my deck". It is a review queue, and it exists because of one
 * rule the service layer enforces and this page has to make legible: a machine
 * translation is never rendered into a document. It sits as a proposal until
 * somebody who reads the language approves it, exactly as a figure read out of a
 * document sits as a candidate until somebody confirms it. The product has one
 * idea about provenance and applies it to prose as well as to numbers.
 *
 * Three things follow, and the page says all three in words rather than relying
 * on a reader to work them out from a status column:
 *
 *   · Where a passage is not approved, the document renders the English. Not a
 *     gap, not a machine draft — the English. A reader of the French deck gets a
 *     paragraph they may not read rather than a paragraph that may be wrong.
 *
 *   · No figure is ever translated, in either direction. Numbers leave the text
 *     before it reaches a translator and are formatted for the target language
 *     from the fact store when the document renders. So a translation cannot go
 *     out of date because a figure moved, and a translator never holds the
 *     company's numbers.
 *
 *   · Some text is never machine-translated at all — disclaimers, legal notices,
 *     confidentiality wording, people's names, company names, signature blocks.
 *     The refusal is the service layer's and is shown as written.
 */

import * as localisation from '../../api/localisation.js';
import { NEVER_MACHINE_TRANSLATED } from '../../domain/locale.js';
import { translatorFor, translatorConfigured, NO_TRANSLATOR } from '../translator.js';
import { shell, attempt, can, gatedNote } from './shell.js';
import {
  page, section, record, table, form, textarea, emptyState, banner, h, action, csrfField, pill, figure,
} from '../html.js';

const stateWords = {
  NOT_TRANSLATED: ['Not translated', 'neutral'],
  MACHINE_TRANSLATED: ['Waiting for a reader', 'warn'],
  HUMAN_APPROVED: ['In use', 'good'],
  REJECTED: ['Rejected', 'bad'],
};

export const languageRoutes = [
  {
    path: '/org/:org/languages', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const gate = can(ctx, s.org.id, 'LOCALISATION');
      const all = attempt(s, () => localisation.locales(ctx, s.org.id).body);
      if (!all.ok) return all.response;
      const { locales, default: defaultLocale, catalogue_version: version, note } = all.value;

      // The first locale that is a different language, not merely a different
      // code. Defaulting to the next entry in the list opened this page on
      // English (US) with English (UK) as the source — a translation queue
      // between two spellings of the same language, which teaches nothing and
      // makes the page look broken.
      const base = (code) => String(code).split('-')[0];
      const chosen = req.query.get('locale')
        || locales.find((l) => base(l.code) !== base(defaultLocale))?.code
        || defaultLocale;
      const status = attempt(s, () => localisation.translationStatus(ctx, s.org.id, chosen).body);
      if (!status.ok) return status.response;

      const prose = ctx.db.find('prose_block', { org_id: s.org.id }).filter((p) => !p.superseded_by);
      const byId = new Map(prose.map((p) => [p.id, p]));
      const translations = new Map(
        ctx.db.find('prose_translation', { org_id: s.org.id })
          .filter((t) => !t.superseded_by && t.locale === chosen)
          .map((t) => [t.prose_id, t]),
      );

      const target = locales.find((l) => l.code === chosen);

      const passages = status.value.passages.map((p) => {
        const block = byId.get(p.prose_id);
        const existing = translations.get(p.prose_id);
        const [label, tone] = stateWords[p.state] ?? stateWords.NOT_TRANSLATED;

        return record({
          title: `The “${p.slot}” passage`,
          meta: `renders in ${p.renders === chosen ? (target?.name ?? chosen) : 'English'}`,
          state: p.usable ? 'done' : p.stale ? 'blocked' : p.state === 'MACHINE_TRANSLATED' ? 'attention' : null,
          body: `<p>${pill(label, tone)}${p.stale ? ` ${pill('English has changed since', 'bad')}` : ''}</p>`
            + `<div class="sides">
                <div class="side">
                  <h3 class="side-head">English</h3>
                  <p class="passage">${h(block?.body ?? '')}</p>
                </div>
                <div class="side">
                  <h3 class="side-head">${h(target?.name ?? chosen)}</h3>
                  ${existing
    ? `<p class="passage">${h(existing.body)}</p>`
    : '<p class="note">Nothing yet, so the document renders the English.</p>'}
                </div>
              </div>`
            + (p.stale
              ? banner({
                tone: 'warn',
                says: 'The English has been rewritten since this was translated.',
                detail: 'Approving it would put a paragraph in the translated document that the '
                      + 'English one no longer contains. The document is rendering the English until '
                      + 'this is redone.',
              })
              : '')
            + (gate.allowed
              ? `<div class="row">
                  ${p.state === 'MACHINE_TRANSLATED' && !p.stale
    ? `<form method="post" action="/org/${s.org.id}/languages/${h(p.translation_id)}/approve" class="inline">
                        ${csrfField(s.csrf)}
                        <button class="button button-quiet" type="submit">I read ${h(target?.name ?? chosen)} — approve</button>
                      </form>
                      <form method="post" action="/org/${s.org.id}/languages/${h(p.translation_id)}/reject" class="inline">
                        ${csrfField(s.csrf)}
                        <input type="text" name="reason" placeholder="Why not?" aria-label="Reason" size="18">
                        <button class="button button-danger" type="submit">Reject</button>
                      </form>`
    : ''}
                  ${translatorConfigured(req) && !p.usable
    ? `<form method="post" action="/org/${s.org.id}/languages/${h(p.prose_id)}/machine" class="inline">
                        ${csrfField(s.csrf)}
                        <input type="hidden" name="locale" value="${h(chosen)}">
                        <button class="button button-quiet" type="submit">Draft a machine translation</button>
                      </form>`
    : ''}
                </div>
                <details class="write-own">
                  <summary>Write it yourself</summary>
                  <form class="form is-compact" method="post" action="/org/${s.org.id}/languages/${h(p.prose_id)}/write">
                    ${csrfField(s.csrf)}
                    <input type="hidden" name="locale" value="${h(chosen)}">
                    ${textarea({
    name: 'body', label: `In ${target?.name ?? chosen}`, rows: 4,
    value: existing?.body ?? '',
    hint: 'Keep every {{fact:…}} reference exactly as it appears in the English. They are '
                        + 'the figures, and a dropped one is a missing number in the document — which '
                        + 'is why this is checked rather than trusted.',
  })}
                    <div class="form-actions">
                      <button class="button" type="submit">Save, approved</button>
                    </div>
                  </form>
                </details>`
              : ''),
        });
      }).join('');

      return s.render('Languages', page({
        title: 'Languages',
        lede: note,
        body: gatedNote(gate)
          + `<nav class="row">${locales.map((l) =>
    `<a class="button ${l.code === chosen ? 'button-solid' : 'button-quiet'}" `
            + `href="/org/${s.org.id}/languages?locale=${h(l.code)}">${h(l.name)}`
            + `${l.code === defaultLocale ? ' — your source' : ''}</a>`).join('')}</nav>`
          + `<div class="row">${figure({
            label: 'Waiting for a reader',
            value: String(status.value.awaiting_approval),
            from: status.value.awaiting_approval
              ? 'Rendering English until approved'
              : 'Nothing waiting',
          })}${figure({
            label: 'Gone stale',
            value: String(status.value.stale),
            from: status.value.stale ? 'The English changed underneath' : 'None',
          })}${figure({
            label: 'Not translated',
            value: String(status.value.not_translated),
            from: 'These render in English',
          })}</div>`
          + (translatorConfigured(req)
            ? ''
            : banner({ tone: 'info', says: NO_TRANSLATOR.says, detail: NO_TRANSLATOR.detail }))
          + (status.value.strings_missing?.length
            ? banner({
              tone: 'warn',
              says: `${status.value.strings_missing.length} interface string${status.value.strings_missing.length === 1 ? ' is' : 's are'} `
                  + `missing for ${target?.name ?? chosen}.`,
              detail: 'Interface wording ships with the product and is not translated here. A missing '
                    + 'one falls back to English rather than rendering blank.',
            })
            : '')
          + section({
            title: `Passages in ${target?.name ?? chosen}`,
            note: status.value.note,
            body: passages || emptyState({
              says: 'Nothing written yet, so there is nothing to translate. Write the passages first '
                  + 'and they appear here.',
              action: action({ href: `/org/${s.org.id}/writing`, label: 'Go to writing' }),
            }),
          })
          + section({
            title: 'What is never machine-translated',
            note: 'A mistranslated disclaimer is worse than an untranslated one, and a translated '
                + 'person\'s name is simply wrong.',
            body: `<p>${NEVER_MACHINE_TRANSLATED.map((k) =>
              pill(String(k).replace(/_/g, ' ').toLowerCase(), 'neutral')).join(' ')}</p>`
              + '<p class="note">These are refused rather than attempted. A person can still write '
              + 'them, which is the only way they should ever be written.</p>',
          })
          + section({
            title: 'How languages are supported',
            note: `Catalogue version ${version}. ${locales.length} languages.`,
            body: table({
              columns: [
                { key: 'name', label: 'Language' },
                { key: 'endonym', label: 'As it calls itself' },
                { key: 'currency', label: 'Default currency' },
                { key: 'strings', label: 'Interface wording' },
              ],
              rows: locales.map((l) => ({
                name: l.name,
                endonym: l.endonym,
                currency: l.currency_default,
                strings: l.strings_complete ? 'complete' : `${l.missing_strings} missing`,
              })),
            }),
          }),
      }), { wide: true });
    },
  },

  {
    path: '/org/:org/languages/:prose/write', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => localisation.writeTranslation(
        req.ctx, s.org.id, req.params.prose, req.body.locale, req.body.body,
      ));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/languages?locale=${encodeURIComponent(req.body.locale)}` };
    },
  },

  {
    path: '/org/:org/languages/:prose/machine', method: 'POST',
    handle: async (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;

      const translator = translatorFor(req);
      if (!translator) {
        return s.render('Languages', page({
          title: 'Languages',
          body: banner({ tone: 'info', says: NO_TRANSLATOR.says, detail: NO_TRANSLATOR.detail })
            + `<p><a href="/org/${s.org.id}/languages">Back</a></p>`,
        }), { status: 503 });
      }

      try {
        const result = await localisation.translateProse(
          req.ctx, s.org.id, req.params.prose, req.body.locale, translator,
        );
        if (!result.body.translated) {
          // A translator saying it cannot is a successful turn, and the reason
          // it gave is worth more than a retry.
          return s.render('Languages', page({
            title: 'Not translated',
            lede: result.body.note,
            body: banner({ tone: 'info', says: result.body.why })
              + `<p><a href="/org/${s.org.id}/languages?locale=${encodeURIComponent(req.body.locale)}">Back</a></p>`,
          }));
        }
        return { redirect: `/org/${s.org.id}/languages?locale=${encodeURIComponent(req.body.locale)}` };
      } catch (err) {
        return s.refuse(err, 'Languages');
      }
    },
  },

  {
    path: '/org/:org/languages/:translation/approve', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        localisation.approveTranslation(req.ctx, s.org.id, req.params.translation));
      if (!r.ok) return r.response;
      const locale = r.value.body.translation.locale;
      return { redirect: `/org/${s.org.id}/languages?locale=${encodeURIComponent(locale)}` };
    },
  },

  {
    path: '/org/:org/languages/:translation/reject', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'writing' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => localisation.rejectTranslation(
        req.ctx, s.org.id, req.params.translation, { reason: req.body.reason },
      ));
      if (!r.ok) return r.response;
      const locale = r.value.body.translation.locale;
      return { redirect: `/org/${s.org.id}/languages?locale=${encodeURIComponent(locale)}` };
    },
  },
];
