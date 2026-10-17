/**
 * Phase 11 — localisation.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE RULES, AND NONE OF THEM IS A POLICY
 *
 * **1. A figure never passes through a translation model.** Not instructed not
 * to — never given one. References are masked before the text leaves and
 * restored after it returns, and the numbers themselves are formatted by `Intl`
 * from the stored value, in every locale, for ever.
 *
 * **2. A machine translation is not usable until a person approves it.** The
 * same shape as an unconfirmed extraction, and the same reason: a document
 * going to an investor should not contain a sentence nobody has read — least of
 * all in a language the issuer cannot check. `USABLE_TRANSLATION_STATES` has one
 * member, and it is not the machine one.
 *
 * **3. Some things are never machine translated at all.** Disclaimers, legal
 * notices, names. A mistranslated liability limitation is a legal document that
 * says something nobody drafted.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS WAS SAFE TO BUILD
 *
 * Because of a rule from two phases ago. Prose here cannot contain a numeral —
 * every figure is already a reference — so the text handed to a translator
 * contains no figures to corrupt. The strictness that looked like pedantry in
 * Phase 10 is the precondition for this phase existing.
 */

import { authorise, assertBelongsToOrg, AccessError } from '../domain/access.js';
import { createHash } from 'node:crypto';
import {
  LOCALES, LOCALE_CODES, DEFAULT_LOCALE, assertLocale, localeFor, localeRefusal,
  isTranslatable, translationRefusal, NEVER_MACHINE_TRANSLATED, LocaleError,
} from '../domain/locale.js';
import { mask, accept, referencesIn, TranslationError } from '../domain/translation.js';
import { assertTranslator } from '../translate/interface.js';
import { coverage, missingFor, CATALOGUE_VERSION, s } from '../i18n/strings.js';
import { requireEntitlement } from './billing.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * The only state a document will render from.
 *
 * One member. The parallel with `USABLE_SOURCES` excluding `DOCUMENT_EXTRACTED`
 * is deliberate: in both cases the machine has produced something plausible and
 * a person has not yet looked at it, and in both cases the product's answer is
 * that plausible is not the standard.
 */
export const USABLE_TRANSLATION_STATES = Object.freeze(['HUMAN_APPROVED']);

const hashOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);

// ──────────────────────────────────────────────────────────── what is offered ──

export function locales(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  return ok({
    locales: LOCALES.map((l) => ({
      ...l,
      strings_complete: missingFor(l.code).length === 0,
      missing_strings: missingFor(l.code).length,
    })),
    default: DEFAULT_LOCALE,
    catalogue_version: CATALOGUE_VERSION,
    never_translated: NEVER_MACHINE_TRANSLATED,
    // Said plainly rather than left to be discovered. A customer asking for
    // Japanese deserves the real reason, not "not supported".
    note: 'Documents can be produced in these languages. Figures and dates are formatted for each one '
        + 'from the stored value — no number is ever translated, in either direction.',
  });
}

/** Why a language is not on the list. */
export function explainLocale(ctx, orgId, code) {
  authorise(membershipOf(ctx, orgId), 'read');
  if (localeFor(code)) return ok({ supported: true, locale: localeFor(code) });
  return ok({ supported: false, ...localeRefusal(code), supported_locales: LOCALE_CODES });
}

export function stringCoverage(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  return ok({ catalogue_version: CATALOGUE_VERSION, coverage: coverage() });
}

// ─────────────────────────────────────────────────────────────── translating ──

/**
 * Translate a passage of prose.
 *
 * Produces a MACHINE_TRANSLATED row, which no document will render. Approving it
 * is a separate, deliberate act by a named person.
 */
export async function translateProse(ctx, orgId, proseId, locale, translator, { kind = 'PROSE' } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  // Translating is a write. Translations already approved keep rendering.
  requireEntitlement(ctx, orgId, 'LOCALISATION');
  const target = assertLocale(locale);
  const model = assertTranslator(translator);

  const block = assertBelongsToOrg(ctx.db.get('prose_block', proseId), orgId);
  if (block.superseded_by) {
    // Translating a superseded passage produces a translation of something the
    // English document no longer says.
    throw new TranslationError('prose_superseded',
      'This passage has been rewritten since. Translate the current version instead.', 409);
  }

  if (!isTranslatable(kind)) {
    throw new TranslationError('not_machine_translatable', translationRefusal(kind), 400, {
      kind, never_translated: NEVER_MACHINE_TRANSLATED,
    });
  }

  // Masked BEFORE it leaves. The translator never holds a fact key, and there is
  // no figure in the text to hold.
  const { masked, refs } = mask(block.body);

  let response;
  try {
    response = await model.translate({ text: masked, from: 'en-GB', to: target.code, kind });
  } catch (err) {
    throw new TranslationError('translator_failed',
      `The translator could not be reached: ${err.message}`, 502);
  }

  if (response?.cannot_translate) {
    // A successful turn. A translator that says it cannot is worth more than one
    // that guesses.
    audit(ctx, orgId, 'translation.declined', 'prose_block', proseId,
      { locale: target.code, why: response.cannot_translate.why });
    return ok({
      translated: false,
      why: response.cannot_translate.why,
      note: 'Nothing was saved. The English stands.',
    });
  }

  if (typeof response?.text !== 'string') {
    throw new TranslationError('translator_malformed',
      'The translator returned no text.', 502);
  }

  // Throws unless every reference came back exactly once and no figure appeared.
  const restored = accept({ source: masked, translated: response.text, refs });

  const before = referencesIn(block.body);
  const after = referencesIn(restored);
  if (before.join('|') !== after.join('|')) {
    // Belt and braces over the marker check: the same references, in the same
    // order. A reordering is legitimate in prose, but here it would mean the
    // restore table and the text have diverged.
    throw new TranslationError('references_reordered',
      'The references came back in a different order, so this translation has been discarded rather '
      + 'than risk a figure appearing under the wrong sentence.', 422, { before, after });
  }

  const existing = currentTranslation(ctx, orgId, proseId, target.code);
  const row = ctx.db.insert('prose_translation', {
    org_id: orgId, prose_id: proseId, locale: target.code,
    body: restored, state: 'MACHINE_TRANSLATED',
    translator_id: model.id, translator_version: model.version,
    approved_by: null, approved_at: null, rejected_reason: null,
    source_hash: hashOf(block.body),
    superseded_by: null,
    created_by: ctx.auth.userId, created_at: ctx.now(),
  });
  if (existing) ctx.db.update('prose_translation', existing.id, { superseded_by: row.id });

  audit(ctx, orgId, 'translation.created', 'prose_translation', row.id, {
    locale: target.code, translator: model.id, references: after.length,
  });

  return ok({
    translated: true,
    translation: present(row),
    usable: false,
    note: 'Translated, and not yet usable. Documents will keep rendering the English until somebody '
        + 'who reads ' + target.name + ' approves this. Every figure in it is still a reference — the '
        + 'numbers were never sent to the translator and are formatted from your fact store.',
  }, 201);
}

const currentTranslation = (ctx, orgId, proseId, locale) =>
  ctx.db.find('prose_translation', { org_id: orgId, prose_id: proseId, locale })
    .find((t) => !t.superseded_by) ?? null;

const present = (row) => ({
  id: row.id, prose_id: row.prose_id, locale: row.locale,
  body: row.body, state: row.state,
  usable: USABLE_TRANSLATION_STATES.includes(row.state),
  translator_id: row.translator_id, translator_version: row.translator_version,
  approved_by: row.approved_by, approved_at: row.approved_at,
  rejected_reason: row.rejected_reason,
  references: referencesIn(row.body),
  created_at: row.created_at,
});

// ────────────────────────────────────────────────────────── approving it ──

/**
 * Approve a translation for use in documents.
 *
 * Refused if the English has changed since — approving a translation of
 * yesterday's sentence would put a paragraph in the French deck that the English
 * deck no longer contains, and nobody comparing the two would be able to say
 * which was right.
 */
export function approveTranslation(ctx, orgId, translationId) {
  return usage.around(ctx, orgId, 'TRANSLATION_DECIDED', () => doApproveTranslation(ctx, orgId, translationId));
}

function doApproveTranslation(ctx, orgId, translationId) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('prose_translation', translationId), orgId);

  if (row.state === 'HUMAN_APPROVED') {
    throw new TranslationError('already_approved', 'This was already approved.', 409);
  }
  if (row.superseded_by) {
    throw new TranslationError('translation_superseded',
      'A newer translation of this passage exists.', 409);
  }

  const block = ctx.db.get('prose_block', row.prose_id);
  if (!block || block.org_id !== orgId) {
    throw new TranslationError('prose_gone', 'The passage this translates no longer exists.', 409);
  }
  if (hashOf(block.body) !== row.source_hash) {
    throw new TranslationError('source_changed',
      'The English has been rewritten since this was translated, so approving it would put a '
      + 'paragraph in the translated document that the English one no longer contains. Translate the '
      + 'current version.', 409);
  }

  const updated = ctx.db.update('prose_translation', row.id, {
    state: 'HUMAN_APPROVED', approved_by: ctx.auth.userId, approved_at: ctx.now(),
  });
  audit(ctx, orgId, 'translation.approved', 'prose_translation', row.id,
    { locale: row.locale, translator: row.translator_id });

  return ok({
    translation: present(updated),
    note: 'Approved. Documents in ' + (localeFor(row.locale)?.name ?? row.locale) + ' will use this.',
  });
}

export function rejectTranslation(ctx, orgId, translationId, options = {}) {
  return usage.around(ctx, orgId, 'TRANSLATION_DECIDED', () => doRejectTranslation(ctx, orgId, translationId, options));
}

function doRejectTranslation(ctx, orgId, translationId, { reason = null } = {}) {
  authorise(membershipOf(ctx, orgId), 'write');
  const row = assertBelongsToOrg(ctx.db.get('prose_translation', translationId), orgId);
  if (row.state === 'HUMAN_APPROVED') {
    throw new TranslationError('already_approved',
      'This is in use. Supersede it with a corrected translation rather than rejecting it.', 409);
  }

  const updated = ctx.db.update('prose_translation', row.id, {
    state: 'REJECTED', rejected_reason: reason ? String(reason).trim() : null,
  });
  audit(ctx, orgId, 'translation.rejected', 'prose_translation', row.id,
    { locale: row.locale, reason: reason ?? null });
  return ok({ translation: present(updated) });
}

/**
 * A person writing the translation themselves.
 *
 * Approved on arrival: a human wrote it, which is the whole bar. The references
 * are still checked, because a person retyping a passage can drop one just as a
 * model can — and the consequence is identical.
 */
export function writeTranslation(ctx, orgId, proseId, locale, body) {
  return usage.around(ctx, orgId, 'TRANSLATION_WRITTEN', () => doWriteTranslation(ctx, orgId, proseId, locale, body));
}

function doWriteTranslation(ctx, orgId, proseId, locale, body) {
  authorise(membershipOf(ctx, orgId), 'write');
  const target = assertLocale(locale);
  const block = assertBelongsToOrg(ctx.db.get('prose_block', proseId), orgId);

  const text = String(body ?? '').trim();
  if (!text) throw new AccessError('empty_translation', 400);

  const before = referencesIn(block.body);
  const after = referencesIn(text);
  const missing = before.filter((r) => !after.includes(r));
  if (missing.length) {
    throw new TranslationError('references_lost',
      `This translation is missing ${missing.length === 1 ? 'a reference' : 'references'} the English `
      + `has: ${missing.map((r) => `{{fact:${r}}}`).join(', ')}. Each one would render as a blank.`,
      422, { missing });
  }

  const existing = currentTranslation(ctx, orgId, proseId, target.code);
  const row = ctx.db.insert('prose_translation', {
    org_id: orgId, prose_id: proseId, locale: target.code,
    body: text, state: 'HUMAN_APPROVED',
    translator_id: null, translator_version: null,
    approved_by: ctx.auth.userId, approved_at: ctx.now(), rejected_reason: null,
    source_hash: hashOf(block.body), superseded_by: null,
    created_by: ctx.auth.userId, created_at: ctx.now(),
  });
  if (existing) ctx.db.update('prose_translation', existing.id, { superseded_by: row.id });

  audit(ctx, orgId, 'translation.written', 'prose_translation', row.id, { locale: target.code });
  return ok({ translation: present(row) }, 201);
}

// ───────────────────────────────────────────────────────────── for rendering ──

/**
 * The prose a document should render, in a locale.
 *
 * Falls back to English per passage rather than per document, so a deck with
 * three paragraphs translated and one not is three-quarters in French rather
 * than entirely in English — and every fallback is reported, because a mixed
 * document is a state the user should be able to see rather than discover.
 */
export function proseForLocale(ctx, orgId, locale) {
  const target = localeFor(locale) ?? localeFor(DEFAULT_LOCALE);
  const blocks = ctx.db.find('prose_block', { org_id: orgId }).filter((p) => !p.superseded_by);

  const out = {};
  const fallbacks = [];

  for (const block of blocks) {
    const translation = ctx.db
      .find('prose_translation', { org_id: orgId, prose_id: block.id, locale: target.code })
      .find((t) => !t.superseded_by && USABLE_TRANSLATION_STATES.includes(t.state)
        && t.source_hash === hashOf(block.body));

    const body = translation?.body ?? block.body;
    if (!translation && !target.code.startsWith('en')) {
      fallbacks.push({
        slot: block.slot,
        // The two reasons differ and the fix differs, so they are not merged.
        why: hasStaleTranslation(ctx, orgId, block)
          ? 'translated, but the English has changed since'
          : 'not translated yet',
      });
    }
    out[block.slot] = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }

  return { prose: out, fallbacks, locale: target.code };
}

function hasStaleTranslation(ctx, orgId, block) {
  return ctx.db.find('prose_translation', { org_id: orgId, prose_id: block.id })
    .some((t) => !t.superseded_by && t.source_hash !== hashOf(block.body));
}

/** What is translated, what is waiting, and what has gone stale. */
export function translationStatus(ctx, orgId, locale) {
  authorise(membershipOf(ctx, orgId), 'read');
  const target = assertLocale(locale);
  const blocks = ctx.db.find('prose_block', { org_id: orgId }).filter((p) => !p.superseded_by);

  const rows = blocks.map((block) => {
    const current = currentTranslation(ctx, orgId, block.id, target.code);
    const stale = current && current.source_hash !== hashOf(block.body);
    return {
      prose_id: block.id,
      slot: block.slot,
      state: current?.state ?? 'NOT_TRANSLATED',
      usable: Boolean(current && !stale && USABLE_TRANSLATION_STATES.includes(current.state)),
      stale: Boolean(stale),
      translation_id: current?.id ?? null,
      // A document will render English here, and saying so is the point of this
      // whole endpoint.
      renders: current && !stale && USABLE_TRANSLATION_STATES.includes(current.state)
        ? target.code : 'en-GB',
    };
  });

  return ok({
    locale: target.code,
    passages: rows,
    awaiting_approval: rows.filter((r) => r.state === 'MACHINE_TRANSLATED' && !r.stale).length,
    stale: rows.filter((r) => r.stale).length,
    not_translated: rows.filter((r) => r.state === 'NOT_TRANSLATED').length,
    complete: rows.length > 0 && rows.every((r) => r.usable),
    strings_missing: missingFor(target.code),
    note: 'Figures and dates are not in this list. They are formatted for ' + target.name
        + ' from your fact store every time a document renders, so they are never out of date and '
        + 'never translated.',
  });
}

export { LocaleError, TranslationError };
export { s as string };
