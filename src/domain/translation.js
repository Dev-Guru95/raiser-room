/**
 * Translation — and what has to survive it intact.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SHAPE OF THE PROBLEM
 *
 * A translation model is given words and returns words. It is not a function; it
 * cannot be asked to guarantee that anything in particular comes back unchanged,
 * and it is at its least reliable on exactly the tokens that matter most here —
 * strings that are not words. `{{fact:financials.revenue.ttm}}` is a plausible
 * thing for a model to "helpfully" translate, reformat, or drop.
 *
 * If it drops one, the sentence renders with a hole in it. If it alters one, the
 * sentence renders a different company figure. Both arrive in a PDF, in a
 * language the person who built the deck does not read.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ANSWER: MASK, TRANSLATE, RESTORE, COUNT
 *
 * References are replaced with opaque markers before the text leaves, restored
 * after it comes back, and the result is REFUSED unless every marker returned
 * exactly once. Not warned about. Refused.
 *
 * The markers are deliberately ugly and un-word-like — a model is far less
 * likely to improve `⟦7⟧` than to improve something that looks like a word, and
 * if it does mangle one, the count catches it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND THE THING THAT MAKES ALL OF THIS TRACTABLE
 *
 * Prose in this product cannot contain a numeral; every figure is already a
 * reference, enforced when the prose is written. So the text handed to a
 * translator contains **no figures at all** — only words and markers. The number
 * rule, which looked like strictness for its own sake two phases ago, is what
 * makes translation safe to offer.
 */

export class TranslationError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const FACT_REF = /\{\{\s*fact:([a-z0-9_.]+)\s*\}\}/gi;

/**
 * Markers chosen to be unlike anything a model would try to improve.
 *
 * Mathematical white square brackets: not letters, not punctuation a translator
 * localises, and absent from ordinary prose in every supported language.
 */
const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';
const markerFor = (i) => `${MARK_OPEN}${i}${MARK_CLOSE}`;
const MARKER = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, 'g');

/**
 * Replace every fact reference with a marker.
 *
 * Returns the masked text and the table to restore from. The translator is given
 * the masked text and nothing else — it never holds a fact key, let alone a
 * figure.
 */
export function mask(text) {
  const refs = [];
  const masked = String(text ?? '').replace(FACT_REF, (whole) => {
    const index = refs.length;
    refs.push(whole);
    return markerFor(index);
  });
  return { masked, refs };
}

/**
 * Put the references back, and refuse if anything about them changed.
 *
 * Every check here has a failure it is for, and all of them have been seen from
 * real translation systems:
 *
 *   · a marker dropped          → a sentence with a hole where a figure goes
 *   · a marker duplicated       → one figure printed twice, another missing
 *   · a marker invented         → an index pointing at nothing
 *   · a marker's digits altered → the WRONG company figure, silently
 *
 * The last is the one worth refusing loudly for. It produces a document that is
 * fluent, complete, plausible and wrong.
 */
export function unmask(translated, refs) {
  const text = String(translated ?? '');
  const seen = new Map();

  const found = [...text.matchAll(MARKER)];
  for (const m of found) {
    const index = Number(m[1]);
    seen.set(index, (seen.get(index) ?? 0) + 1);
  }

  const problems = [];

  for (let i = 0; i < refs.length; i++) {
    const count = seen.get(i) ?? 0;
    if (count === 0) {
      problems.push({
        code: 'reference_lost', index: i, reference: refs[i],
        problem: `The translation dropped ${refs[i]}, which would leave a blank where that figure goes.`,
      });
    } else if (count > 1) {
      problems.push({
        code: 'reference_duplicated', index: i, reference: refs[i], count,
        problem: `The translation repeated ${refs[i]} ${count} times.`,
      });
    }
  }

  for (const [index] of seen) {
    if (index >= refs.length || !Number.isInteger(index)) {
      problems.push({
        code: 'reference_invented', index,
        problem: 'The translation produced a reference marker that was not in the original, which '
               + 'means it altered one. The figure it points at would be the wrong one.',
      });
    }
  }

  if (problems.length) {
    throw new TranslationError('references_not_intact',
      'This translation did not bring the figures back intact, so it has been discarded. Nothing was '
      + 'saved and the original is unchanged.',
      422, { problems });
  }

  return text.replace(MARKER, (_, i) => refs[Number(i)]);
}

/**
 * A numeral that appears in a translation but not in the source.
 *
 * Belt and braces. Prose cannot contain a numeral in the first place, so this
 * should never fire — which is exactly why it is here. If it ever does, either
 * the number rule has been weakened upstream or the translator is inventing
 * figures, and both are things to find out about from a refusal rather than from
 * a customer.
 */
const NUMERAL = /\d[\d.,]*/g;

export function invention(source, translated) {
  const before = new Set((String(source ?? '').match(NUMERAL) ?? []).map(normaliseDigits));
  const after = (String(translated ?? '').match(NUMERAL) ?? []).map(normaliseDigits);
  return [...new Set(after.filter((n) => !before.has(n)))];
}

/**
 * Compare digits, not punctuation.
 *
 * "1,234.56" and "1.234,56" are the same number for this purpose — the point is
 * to catch a figure that was INVENTED, not one that was reformatted, and marking
 * a legitimate reformat as an invention would make the check noise.
 */
const normaliseDigits = (token) => String(token).replace(/[^\d]/g, '');

/**
 * Everything that has to hold for a translation to be accepted.
 *
 * Returns the restored text. Throws rather than returning problems, because
 * there is no partially acceptable translation: either the figures came back
 * intact or the whole thing is discarded.
 */
export function accept({ source, translated, refs }) {
  const restored = unmask(translated, refs);

  const invented = invention(source, restored);
  if (invented.length) {
    throw new TranslationError('figures_invented',
      `The translation contains ${invented.length === 1 ? 'a figure' : 'figures'} that the original `
      + `did not: ${invented.join(', ')}. Discarded. A figure that appears during translation has no `
      + 'source, and a document carrying it would be making a claim nobody made.',
      422, { invented });
  }

  if (!restored.trim()) {
    throw new TranslationError('empty_translation',
      'The translation came back empty.', 422);
  }

  return restored;
}

/** The references a passage carries, for comparing before and after. */
export function referencesIn(text) {
  return [...String(text ?? '').matchAll(FACT_REF)].map((m) => m[1]);
}
