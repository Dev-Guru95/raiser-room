/**
 * Phase 11 — localisation.
 *
 * The rule under test is one sentence: **a figure never passes through a
 * translation model.** Most of what follows is proving that holds even when the
 * translator misbehaves in each of the specific ways translation systems do.
 *
 * The second theme is that a machine translation is not a translation yet. It is
 * a proposal, in the same sense an unconfirmed extraction is — and for a sharper
 * reason, because the person who would catch the mistake cannot read it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, ctxFor, expectRefusal, fakeStorage } from './helpers.js';
import * as svc from '../src/api/service.js';
import * as prose from '../src/api/prose.js';
import * as artifacts from '../src/api/artifacts.js';
import * as api from '../src/api/localisation.js';
import { fakeTranslator } from '../src/translate/fake.js';
import {
  LOCALES, LOCALE_CODES, DEFAULT_LOCALE, formatNumberIn, formatDateIn, formatPeriodIn,
  assertLocale, localeRefusal, isTranslatable, NEVER_MACHINE_TRANSLATED,
} from '../src/domain/locale.js';
import { mask, unmask, accept, invention, referencesIn } from '../src/domain/translation.js';
import { s, coverage, missingFor, STRING_KEYS, CATALOGUE_VERSION } from '../src/i18n/strings.js';
import { withLocale, currentLocale, formatNumber } from '../src/render/theme.js';

function world() {
  const db = freshDb();
  const ctx = ctxFor(db, 'u-owner');
  const storage = fakeStorage();
  const org = svc.createOrganisation(ctx, { name: 'Northwind Systems', path: 'RAISE' }).body.organisation;
  return { db, ctx, org, storage };
}

/** An org with a confirmed revenue fact and a passage that references it. */
function withProse(ctx, org, storage) {
  const doc = svc.createUploadTicket(ctx, org.id, {
    filename: 'accounts.pdf', size_bytes: 1_000, mime_type: 'application/pdf', kind: 'ACCOUNTS',
  }, storage).body.document;
  svc.confirmUpload(ctx, org.id, doc.id);
  svc.createFact(ctx, org.id, {
    fact_key: 'financials.revenue.ttm', label: 'Revenue', value_numeric: 4_200_000, unit: 'USD',
    source: 'USER_CONFIRMED', source_doc_id: doc.id, source_page: 4,
  });
  svc.createFact(ctx, org.id, {
    fact_key: 'company.name', label: 'Registered name',
    value_text: 'Northwind Systems Inc.', source: 'USER_ENTERED',
  });
  return prose.writeProse(ctx, org.id, 'default',
    'Revenue reached {{fact:financials.revenue.ttm}} in the last full year.').body.prose;
}

// ──────────────────────────────────────────────── figures, formatted not translated ──

test('a figure is written for the locale, and is the same figure', () => {
  const value = 1_234_567.89;
  const written = LOCALE_CODES.map((code) => formatNumberIn(value, code, { unit: 'USD', decimals: 2 }));
  // Different strings — that is the point of localising.
  assert.ok(new Set(written).size > 1, 'every locale wrote the figure identically');
  // Same digits in every one of them. This is the assertion the phase exists for.
  for (const text of written) {
    assert.equal(text.replace(/[^\d]/g, ''), '123456789',
      `the digits changed: ${text}`);
  }
});

test('thousands and decimal separators follow the locale', () => {
  assert.match(formatNumberIn(1_234.56, 'en-GB', { decimals: 2 }), /1,234\.56/);
  assert.match(formatNumberIn(1_234.56, 'de-DE', { decimals: 2 }), /1\.234,56/);
  assert.match(formatNumberIn(1_234.56, 'fr-FR', { decimals: 2 }), /1\s234,56/);
});

test('negatives stay in brackets in every locale', () => {
  // A financial convention rather than a locale one, and it survives
  // photocopying in a way a minus sign before a currency symbol does not.
  for (const code of LOCALE_CODES) {
    assert.match(formatNumberIn(-4_200, code, { unit: 'USD' }), /^\(.*\)$/,
      `${code} did not bracket a negative`);
  }
});

test('a compact suffix is the same word everywhere, and sits on the number', () => {
  // Two things at once. Intl localises its own compact suffixes ("Mio.", "M"),
  // and a deck saying "4,2 Mio." on one page and "$4.2m" on another is worse
  // than either — so the suffix is ours and does not vary.
  //
  // And it belongs to the DIGITS. German puts the currency symbol last, so
  // formatting as currency and then appending the suffix gave "4,1 $m", which
  // reads as a currency called "$m".
  for (const code of LOCALE_CODES) {
    const written = formatNumberIn(4_200_000, code, { unit: 'USD', compact: true });
    assert.ok(written.includes('m'), `${code} localised the scale suffix: ${written}`);
    assert.ok(!/\$\s*m/.test(written), `${code} put the suffix after the symbol: ${written}`);
    assert.match(written, /4[.,]2m/, `the suffix left the number: ${written}`);
  }
  // And the symbol still lands where the locale puts it.
  assert.match(formatNumberIn(4_200_000, 'en-GB', { unit: 'USD', compact: true }), /^\$/);
  assert.match(formatNumberIn(4_200_000, 'de-DE', { unit: 'USD', compact: true }), /\$$/);
});

test('a date is always written with the month in words', () => {
  // "03/04/2026" means March in one country and April in another, and a data
  // room is read in both.
  for (const code of LOCALE_CODES) {
    const written = formatDateIn('2026-04-03', code);
    assert.ok(/[a-zA-Zé]{3,}/.test(written), `${code} wrote a numeric month: ${written}`);
    assert.match(written, /2026/);
  }
  assert.match(formatDateIn('2026-04-03', 'fr-FR'), /avril/);
  assert.match(formatDateIn('2026-04-03', 'de-DE'), /April/);
});

test('a period reads as a range in every locale', () => {
  const period = formatPeriodIn('2025-01-01', '2025-12-31', 'de-DE');
  assert.match(period, /2025/);
  assert.match(period, /–/);
});

// ───────────────────────────────────────── which locales, and why not the others ──

test('the supported locales are stated, not implied', () => {
  const { ctx, org } = world();
  const res = api.locales(ctx, org.id);
  assert.equal(res.body.locales.length, LOCALES.length);
  assert.ok(res.body.locales.every((l) => l.strings_complete),
    'a locale is offered whose strings are not finished');
  assert.equal(res.body.default, DEFAULT_LOCALE);
});

test('a right-to-left language is refused with the real reason', () => {
  // "Unsupported" invites the question. The answer is a layout constraint, not
  // a shrug.
  const refusal = localeRefusal('ar-SA');
  assert.equal(refusal.code, 'rtl_unsupported');
  assert.match(refusal.problem, /mirrored/);
});

test('a non-Latin script is refused because the typefaces cannot set it', () => {
  for (const code of ['ja-JP', 'zh-CN', 'ru-RU', 'el-GR']) {
    assert.equal(localeRefusal(code).code, 'script_unsupported', `${code} was not caught`);
  }
  assert.match(localeRefusal('ja-JP').problem, /empty boxes/);
});

test('asking for an unsupported locale throws rather than rendering tofu', () => {
  const err = expectRefusal(() => assertLocale('ja-JP'), 'script_unsupported', 400);
  assert.deepEqual(err.supported, LOCALE_CODES);
});

test('the service explains an unsupported locale instead of only refusing it', () => {
  const { ctx, org } = world();
  const res = api.explainLocale(ctx, org.id, 'ar-SA');
  assert.equal(res.status, 200);
  assert.equal(res.body.supported, false);
  assert.equal(res.body.code, 'rtl_unsupported');
});

// ───────────────────────────────────────────── the string catalogue, written by hand ──

test('every supported locale has every string', () => {
  // The claim at the top of the catalogue is that each string was written by a
  // person, and a locale is only offered once that work is done.
  for (const code of LOCALE_CODES) {
    assert.deepEqual(missingFor(code), [], `${code} is missing strings`);
  }
  assert.ok(coverage().every((c) => c.complete));
  assert.ok(CATALOGUE_VERSION);
});

test('a string substitutes its placeholders', () => {
  assert.equal(s('doc.source.confirmed_from_page', 'de-DE', { document: 'accounts.pdf', page: 4 }),
    'Bestätigt aus accounts.pdf, S.4');
  // And the page-less form is a separate string rather than one with an empty
  // placeholder, which would print "S." followed by nothing.
  assert.equal(s('doc.source.confirmed_from', 'de-DE', { document: 'accounts.pdf' }),
    'Bestätigt aus accounts.pdf');
});

test('document furniture is written in the locale the document renders in', () => {
  // Figures being localised while every heading stays English is a half-done
  // document, and the half that is done is the half a reader cannot check.
  const { ctx, org, storage } = world();
  withProse(ctx, org, storage);

  const german = artifacts.generate(ctx, org.id, 'PITCH_DECK', { locale: 'de-DE' }).body.html;
  assert.ok(german.includes('Herkunft jeder Zahl'), 'the appendix heading stayed English');
  assert.ok(german.includes('Bestätigt aus'), 'the provenance wording stayed English');
  assert.ok(!german.includes('Where every figure came from'));

  const english = artifacts.generate(ctx, org.id, 'PITCH_DECK').body.html;
  assert.ok(english.includes('Where every figure came from'));
});

test('a locale that is missing strings is reported as incomplete', () => {
  // The mechanism behind only offering a finished locale. Every locale in the
  // catalogue is complete, so the check is exercised against one that is not.
  assert.equal(missingFor('xx-XX').length, STRING_KEYS.length);
  assert.ok(STRING_KEYS.length > 0);
  for (const code of LOCALE_CODES) assert.equal(missingFor(code).length, 0);
});

test('a missing key throws rather than printing itself into a document', () => {
  // A document with "doc.appendix.heading" printed in it is unmistakably broken.
  assert.throws(() => s('doc.nonexistent', 'fr-FR'), /no string for key/);
});

// ───────────────────────────── masking: the translator never sees a figure ──

test('references are masked before the text leaves', () => {
  const { masked, refs } = mask('Revenue reached {{fact:financials.revenue.ttm}} this year.');
  assert.ok(!masked.includes('fact:'), 'a fact key was handed to the translator');
  assert.ok(!masked.includes('financials'), 'a fact key was handed to the translator');
  assert.equal(refs.length, 1);
});

test('a faithful translation restores every reference', () => {
  const source = 'Revenue reached {{fact:a.b}} with a margin of {{fact:c.d}}.';
  const { masked, refs } = mask(source);
  const restored = accept({ source: masked, translated: `[fr] ${masked}`, refs });
  assert.deepEqual(referencesIn(restored), ['a.b', 'c.d']);
});

test('a dropped reference is refused, not patched', () => {
  // It would leave a blank where a figure goes, in a PDF, in a language the
  // person who built the deck does not read.
  const { masked, refs } = mask('Revenue reached {{fact:a.b}} this year.');
  const err = expectRefusal(() => accept({ source: masked, translated: 'Le revenu a atteint.', refs }),
    'references_not_intact', 422);
  assert.equal(err.problems[0].code, 'reference_lost');
});

test('a duplicated reference is refused', () => {
  const { masked, refs } = mask('Revenue reached {{fact:a.b}}.');
  const err = expectRefusal(
    () => accept({ source: masked, translated: `${masked} ${masked}`, refs }),
    'references_not_intact', 422,
  );
  assert.ok(err.problems.some((p) => p.code === 'reference_duplicated'));
});

test('an ALTERED reference is refused — the one that would be silently wrong', () => {
  // Still well-formed, still the right shape, pointing at a different figure.
  // A fluent, complete, plausible, wrong document.
  const { masked, refs } = mask('Revenue reached {{fact:a.b}}.');
  const altered = masked.replace(/⟦(\d+)⟧/, '⟦7⟧');
  const err = expectRefusal(() => accept({ source: masked, translated: altered, refs }),
    'references_not_intact', 422);
  assert.ok(err.problems.some((p) => p.code === 'reference_invented'));
});

test('a figure that appears during translation is refused', () => {
  // Belt and braces: prose cannot contain a numeral in the first place, so this
  // should never fire — which is exactly why it is here.
  const { masked, refs } = mask('Revenue reached {{fact:a.b}}.');
  const err = expectRefusal(
    () => accept({ source: masked, translated: `${masked} Le total atteint 9,9 millions.`, refs }),
    'figures_invented', 422,
  );
  assert.ok(err.invented.length);
});

test('a reformatted number is not mistaken for an invented one', () => {
  // "1,234.56" and "1.234,56" are the same number. Flagging a legitimate
  // reformat would make the check noise, and a check that fires constantly is
  // one nobody reads.
  assert.deepEqual(invention('total 1,234.56', 'Summe 1.234,56'), []);
  assert.deepEqual(invention('total 1,234.56', 'Summe 9.999,99'), ['999999']);
});

test('an empty translation is refused', () => {
  const { masked, refs } = mask('Revenue reached {{fact:a.b}}.');
  expectRefusal(() => accept({ source: masked, translated: '', refs }), 'references_not_intact', 422);
});

// ───────────────────────────── translating through the service, with a real misbehaver ──

test('a faithful translation is stored and is NOT usable yet', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);

  const res = await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator());
  assert.equal(res.status, 201);
  assert.equal(res.body.translation.state, 'MACHINE_TRANSLATED');
  assert.equal(res.body.usable, false);
  assert.deepEqual(res.body.translation.references, ['financials.revenue.ttm']);
  assert.match(res.body.note, /not yet usable/);
});

for (const [behaviour, code] of [
  ['drops_marker', 'references_not_intact'],
  ['duplicates_marker', 'references_not_intact'],
  ['alters_marker', 'references_not_intact'],
  ['expands_marker', 'references_not_intact'],
  ['invents_figure', 'figures_invented'],
  ['empty', 'references_not_intact'],
]) {
  test(`a translator that ${behaviour.replace(/_/g, ' ')} has its work discarded`, async () => {
    const { ctx, org, storage, db } = world();
    const block = withProse(ctx, org, storage);

    await expectRefusalAsync(
      () => api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator({ behaviour })),
      code,
    );
    // Nothing stored. There is no partially acceptable translation.
    assert.equal(db.count('prose_translation', { org_id: org.id }), 0,
      'a bad translation was saved anyway');
  });
}

test('a translator that declines is a successful turn, and saves nothing', async () => {
  const { ctx, org, storage, db } = world();
  const block = withProse(ctx, org, storage);

  const res = await api.translateProse(ctx, org.id, block.id, 'fr-FR',
    fakeTranslator({ behaviour: 'refuses' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.translated, false);
  assert.ok(res.body.why);
  assert.equal(db.count('prose_translation', { org_id: org.id }), 0);
});

test('a translator returning no text at all is a provider error', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  await expectRefusalAsync(
    () => api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator({ behaviour: 'malformed' })),
    'translator_malformed',
  );
});

test('a translator with no identity cannot be used', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  await expectRefusalAsync(
    () => api.translateProse(ctx, org.id, block.id, 'fr-FR', { translate: async () => ({ text: 'x' }) }),
    'translator_unidentified',
  );
});

test('every stored translation records which model produced it', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const res = await api.translateProse(ctx, org.id, block.id, 'de-DE', fakeTranslator());
  assert.equal(res.body.translation.translator_id, 'fake-translator');
  assert.equal(res.body.translation.translator_version, 'test-1');
});

test('a disclaimer is never sent to a translator at all', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);

  for (const kind of NEVER_MACHINE_TRANSLATED) {
    await expectRefusalAsync(
      () => api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator(), { kind }),
      'not_machine_translatable',
    );
  }
  assert.equal(isTranslatable('PROSE'), true);
  assert.equal(isTranslatable('DISCLAIMER'), false);
});

test('a superseded passage cannot be translated', async () => {
  // It would produce a translation of something the English document no longer
  // says.
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  prose.writeProse(ctx, org.id, 'default', 'Revenue was {{fact:financials.revenue.ttm}} last year.');

  await expectRefusalAsync(
    () => api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator()),
    'prose_superseded',
  );
});

// ──────────────────────────────────────────── approval is what makes it usable ──

test('approving makes a translation usable, and records who', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const t = (await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator())).body.translation;

  const approved = api.approveTranslation(ctx, org.id, t.id);
  assert.equal(approved.body.translation.state, 'HUMAN_APPROVED');
  assert.equal(approved.body.translation.usable, true);
  assert.equal(approved.body.translation.approved_by, 'u-owner');
});

test('a translation of a passage that has since been rewritten cannot be approved', async () => {
  // It would put a paragraph in the French deck that the English deck no longer
  // contains, and nobody comparing them could say which was right.
  const { ctx, org, storage, db } = world();
  const block = withProse(ctx, org, storage);
  const t = (await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator())).body.translation;

  // Rewrite the English in place, standing in for an edit of the same block.
  db.update('prose_block', block.id, {
    body: 'Revenue was {{fact:financials.revenue.ttm}} in the period, up on the year before.',
  });

  expectRefusal(() => api.approveTranslation(ctx, org.id, t.id), 'source_changed', 409);
});

test('a person writing the translation themselves is approved on arrival', () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const res = api.writeTranslation(ctx, org.id, block.id, 'fr-FR',
    'Le chiffre d\'affaires a atteint {{fact:financials.revenue.ttm}} sur le dernier exercice.');
  assert.equal(res.status, 201);
  assert.equal(res.body.translation.state, 'HUMAN_APPROVED');
  assert.equal(res.body.translation.translator_id, null);
});

test('a person who drops a reference is caught too', () => {
  // The consequence is identical whoever did it.
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const err = expectRefusal(
    () => api.writeTranslation(ctx, org.id, block.id, 'fr-FR', 'Le chiffre d\'affaires a progressé.'),
    'references_lost', 422,
  );
  assert.deepEqual(err.missing, ['financials.revenue.ttm']);
});

test('rejecting a translation keeps it, with the reason', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const t = (await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator())).body.translation;

  const res = api.rejectTranslation(ctx, org.id, t.id, { reason: 'Too literal.' });
  assert.equal(res.body.translation.state, 'REJECTED');
  assert.equal(res.body.translation.rejected_reason, 'Too literal.');
});

// ───────────────────────────────────────────────────────── rendering a document ──

test('an unapproved translation does not reach a document', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator());

  const { prose: rendered, fallbacks } = api.proseForLocale(ctx, org.id, 'fr-FR');
  assert.equal(rendered.default[0], block.body, 'an unapproved translation was rendered');
  assert.equal(fallbacks.length, 1);
  assert.match(fallbacks[0].why, /not translated yet/);
});

test('an approved translation does reach a document', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const t = (await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator())).body.translation;
  api.approveTranslation(ctx, org.id, t.id);

  const { prose: rendered, fallbacks } = api.proseForLocale(ctx, org.id, 'fr-FR');
  assert.match(rendered.default[0], /^\[fr-FR\]/);
  assert.deepEqual(fallbacks, []);
});

test('a document falls back per passage, not per document', async () => {
  // A deck with three paragraphs translated and one not is three-quarters in
  // French rather than entirely in English.
  const { ctx, org, storage } = world();
  const first = withProse(ctx, org, storage);
  prose.writeProse(ctx, org.id, 'market', 'The company sells to mid-market logistics operators.');

  const t = (await api.translateProse(ctx, org.id, first.id, 'fr-FR', fakeTranslator())).body.translation;
  api.approveTranslation(ctx, org.id, t.id);

  const { prose: rendered, fallbacks } = api.proseForLocale(ctx, org.id, 'fr-FR');
  assert.match(rendered.default[0], /^\[fr-FR\]/);
  assert.equal(rendered.market[0], 'The company sells to mid-market logistics operators.');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].slot, 'market');
});

test('a translation whose English moved on stops being used, and says why', async () => {
  const { ctx, org, storage, db } = world();
  const block = withProse(ctx, org, storage);
  const t = (await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator())).body.translation;
  api.approveTranslation(ctx, org.id, t.id);

  db.update('prose_block', block.id, { body: 'Revenue was {{fact:financials.revenue.ttm}}, up on last year.' });

  const { prose: rendered, fallbacks } = api.proseForLocale(ctx, org.id, 'fr-FR');
  assert.ok(!rendered.default[0].startsWith('[fr-FR]'), 'a stale translation was still rendered');
  assert.match(fallbacks[0].why, /English has changed/);
});

test('a generated document renders its figures in the locale', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  const t = (await api.translateProse(ctx, org.id, block.id, 'de-DE', fakeTranslator())).body.translation;
  api.approveTranslation(ctx, org.id, t.id);

  const res = artifacts.generate(ctx, org.id, 'PITCH_DECK', { locale: 'de-DE' });
  const html = res.body.html;
  assert.equal(res.body.locale, 'de-DE');
  // 4,200,000 in German is 4.200.000 — same digits, different separators.
  assert.ok(/4[.,]2\s?m|4\.200\.000/.test(html), 'the figure was not written for the locale');
  assert.ok(html.includes('[de-DE]'), 'the approved translation did not reach the document');
});

test('generating in a locale reports what fell back to English', () => {
  const { ctx, org, storage } = world();
  withProse(ctx, org, storage);
  const res = artifacts.generate(ctx, org.id, 'PITCH_DECK', { locale: 'fr-FR' });
  assert.equal(res.body.prose_fallbacks.length, 1);
  assert.match(res.body.locale_note, /rendered in English/);
  assert.match(res.body.locale_note, /never translated/);
});

test('generating leaves no locale set behind it', () => {
  const { ctx, org, storage } = world();
  withProse(ctx, org, storage);
  artifacts.generate(ctx, org.id, 'PITCH_DECK', { locale: 'fr-FR' });
  assert.equal(currentLocale(), null, 'generation left a locale active for the next request');
});

// ──────────────────────────────────────────────────────────── the render scope ──

test('the locale scope restores, including after a throw', () => {
  const before = formatNumber(1_234.5, { decimals: 1 });
  withLocale('de-DE', () => {
    assert.equal(currentLocale(), 'de-DE');
    assert.match(formatNumber(1_234.5, { decimals: 1 }), /1\.234,5/);
  });
  assert.equal(currentLocale(), null);
  assert.equal(formatNumber(1_234.5, { decimals: 1 }), before);

  assert.throws(() => withLocale('fr-FR', () => { throw new Error('block failed'); }), /block failed/);
  assert.equal(currentLocale(), null, 'a throw left a locale set');
});

test('nesting two different locales is refused', () => {
  assert.throws(
    () => withLocale('de-DE', () => withLocale('fr-FR', () => 'never')),
    /escaped its scope/,
  );
  assert.equal(currentLocale(), null);
});

// ─────────────────────────────────────────────────────────────────── status ──

test('the status report says what each passage will actually render as', async () => {
  const { ctx, org, storage } = world();
  const block = withProse(ctx, org, storage);
  prose.writeProse(ctx, org.id, 'market', 'The company sells to mid-market logistics operators.');

  const t = (await api.translateProse(ctx, org.id, block.id, 'fr-FR', fakeTranslator())).body.translation;

  const before = api.translationStatus(ctx, org.id, 'fr-FR').body;
  assert.equal(before.awaiting_approval, 1);
  assert.equal(before.not_translated, 1);
  assert.equal(before.complete, false);
  assert.ok(before.passages.every((p) => p.renders === 'en-GB'));

  api.approveTranslation(ctx, org.id, t.id);
  const after = api.translationStatus(ctx, org.id, 'fr-FR').body;
  assert.equal(after.passages.find((p) => p.slot === 'default').renders, 'fr-FR');
  assert.match(after.note, /never out of date and never translated/);
});

// ───────────────────────────────────────────────────────────── access control ──

test('a non-member gets 404 from every localisation call', async () => {
  const { ctx, org, db, storage } = world();
  const block = withProse(ctx, org, storage);
  const stranger = ctxFor(db, 'u-stranger');

  for (const call of [
    () => api.locales(stranger, org.id),
    () => api.explainLocale(stranger, org.id, 'fr-FR'),
    () => api.stringCoverage(stranger, org.id),
    () => api.translationStatus(stranger, org.id, 'fr-FR'),
    () => api.writeTranslation(stranger, org.id, block.id, 'fr-FR', 'x {{fact:financials.revenue.ttm}}'),
  ]) {
    expectRefusal(call, 'not_found', 404);
  }
  await expectRefusalAsync(
    () => api.translateProse(stranger, org.id, block.id, 'fr-FR', fakeTranslator()), 'not_found');
});

test('a viewer can read but cannot translate or approve', async () => {
  const { ctx, org, db, storage } = world();
  const block = withProse(ctx, org, storage);
  db.insert('membership', {
    org_id: org.id, user_id: 'u-viewer', email: 'v@example.com', role: 'VIEWER', created_at: ctx.now(),
  });
  const viewer = ctxFor(db, 'u-viewer');

  assert.equal(api.locales(viewer, org.id).status, 200);
  await expectRefusalAsync(
    () => api.translateProse(viewer, org.id, block.id, 'fr-FR', fakeTranslator()), 'forbidden');
});

test('a passage from another organisation cannot be translated', async () => {
  const { ctx, org, db, storage } = world();
  const otherCtx = ctxFor(db, 'u-other');
  const other = svc.createOrganisation(otherCtx, { name: 'Elsewhere', path: 'RAISE' }).body.organisation;
  const theirs = prose.writeProse(otherCtx, other.id, 'default', 'Their narrative.').body.prose;

  await expectRefusalAsync(
    () => api.translateProse(ctx, org.id, theirs.id, 'fr-FR', fakeTranslator()), 'not_found');
  void storage;
});

/** `expectRefusal` for an async call. */
async function expectRefusalAsync(fn, code, status) {
  try {
    await fn();
  } catch (err) {
    if (err.code !== code) throw new Error(`expected code "${code}", got "${err.code}" (${err.message})`);
    if (status !== undefined && err.status !== status) {
      throw new Error(`expected status ${status} for "${code}", got ${err.status}`);
    }
    return err;
  }
  throw new Error(`expected a refusal with code "${code}", but the call succeeded`);
}
