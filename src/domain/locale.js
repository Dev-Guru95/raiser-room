/**
 * Locale — formatting figures and dates for a reader elsewhere.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHY IT IS STRUCTURAL RATHER THAN A POLICY
 *
 * **A figure never passes through a translation model.** Not once, not for
 * convenience, not for a locale nobody checks.
 *
 * It is not a hypothetical risk. "1,234.56" and "1.234,56" are the same number
 * written for different readers, and a model asked to translate a document
 * containing the first will sometimes produce the second, sometimes produce
 * "1.234.56", and occasionally produce a different number entirely — confidently,
 * in fluent German, in a document whose entire claim is that no figure in it was
 * typed. The failure is invisible to anyone who does not read both languages and
 * hold the accounts.
 *
 * So figures are formatted here, by `Intl`, from the stored numeric value. The
 * translation layer never sees them. This is the same shape of answer as every
 * other guarantee in this product: not "the model is instructed not to", but
 * "the model is not given the opportunity".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THIS SAFE IS A RULE FROM THE PREVIOUS PHASE
 *
 * Prose in this product cannot contain a numeral — every figure is a
 * `{{fact:key}}` reference, enforced when the prose is written. So by the time a
 * passage reaches a translator, **there is no figure in it to corrupt**. The
 * references are masked, the words are translated, the references are restored
 * and counted.
 *
 * That is not a happy accident. It is why the number rule was worth being strict
 * about: a guarantee made in one phase turns out to be the thing that makes the
 * next one possible.
 */

export class LocaleError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * The locales this product actually supports.
 *
 * Four, and stated rather than implied. The brand faces — Cinzel, Lora, Raleway,
 * Source Code Pro — carry Latin script and nothing else. A Japanese or Arabic
 * document set in them renders as a page of empty boxes, and Arabic additionally
 * needs the whole layout mirrored, which is a different design system rather
 * than a font substitution.
 *
 * Offering a language the typography cannot set would be worse than not
 * offering it: the customer only finds out when the PDF reaches the investor.
 */
export const LOCALES = Object.freeze([
  {
    code: 'en-GB', name: 'English (UK)', endonym: 'English',
    currency_default: 'GBP', direction: 'ltr', script: 'Latn',
  },
  {
    code: 'en-US', name: 'English (US)', endonym: 'English',
    currency_default: 'USD', direction: 'ltr', script: 'Latn',
  },
  {
    code: 'fr-FR', name: 'French', endonym: 'Français',
    currency_default: 'EUR', direction: 'ltr', script: 'Latn',
  },
  {
    code: 'de-DE', name: 'German', endonym: 'Deutsch',
    currency_default: 'EUR', direction: 'ltr', script: 'Latn',
  },
  {
    code: 'es-ES', name: 'Spanish', endonym: 'Español',
    currency_default: 'EUR', direction: 'ltr', script: 'Latn',
  },
]);

export const LOCALE_CODES = Object.freeze(LOCALES.map((l) => l.code));
export const DEFAULT_LOCALE = 'en-GB';

export const localeFor = (code) => LOCALES.find((l) => l.code === code) ?? null;

/**
 * Why a locale someone asked for is not available.
 *
 * Named, because "unsupported" invites the question and the answer is a real
 * engineering constraint rather than a shrug.
 */
export function localeRefusal(code) {
  const requested = String(code ?? '');
  const script = scriptOf(requested);

  if (script === 'rtl') {
    return {
      code: 'rtl_unsupported',
      problem: 'Documents here are laid out left to right, and a right-to-left language needs the '
             + 'whole layout mirrored — tables, charts, page furniture — not a font swap. A '
             + 'half-converted document reads worse than an English one.',
    };
  }
  if (script === 'non_latin') {
    return {
      code: 'script_unsupported',
      problem: 'The typefaces these documents are set in carry Latin script only, so this language '
             + 'would render as empty boxes in a PDF. Adding it means licensing and embedding a '
             + 'different face, not changing a setting.',
    };
  }
  return {
    code: 'locale_unsupported',
    problem: `Documents can be produced in ${LOCALES.map((l) => l.name).join(', ')}. `
           + 'Anything else has not been reviewed, and an unreviewed translation of a document going '
           + 'to an investor is not something to discover later.',
  };
}

const RTL = /^(ar|he|fa|ur|yi)\b/i;
const NON_LATIN = /^(zh|ja|ko|ru|uk|bg|el|hi|bn|ta|th|ka|hy|am)\b/i;

function scriptOf(code) {
  if (RTL.test(code)) return 'rtl';
  if (NON_LATIN.test(code)) return 'non_latin';
  return 'latin';
}

export function assertLocale(code) {
  const locale = localeFor(code);
  if (!locale) {
    const refusal = localeRefusal(code);
    throw new LocaleError(refusal.code, refusal.problem, 400, {
      requested: code, supported: LOCALE_CODES,
    });
  }
  return locale;
}

// ──────────────────────────────────────────────────── figures, by Intl only ──

/**
 * A figure, formatted for a locale.
 *
 * Takes the stored numeric value and a locale. Does not take, and cannot be
 * given, a figure that has been through anything else — which is the entire
 * design. `Intl` is a formatting function with published rules; a model is not.
 */
export function formatNumberIn(value, locale, { unit = null, compact = false, decimals = null, sign = false } = {}) {
  const code = assertLocale(locale).code;
  if (value === null || value === undefined || value === '') return '—';

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new LocaleError('not_a_number', `cannot format ${JSON.stringify(value)}`, 500);
  }

  if (unit === 'percent') {
    const d = decimals ?? (Math.abs(Math.round(n * 10) / 10 - Math.round(n)) > 1e-9 ? 1 : 0);
    const body = new Intl.NumberFormat(code, {
      minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(Math.abs(n));
    return wrapSign(`${body} %`.replace(' %', percentSpacing(code)), n, sign);
  }

  const isCurrency = ['USD', 'GBP', 'EUR'].includes(unit);

  if (compact) {
    const [scale, suffix] = scaleFor(Math.abs(n));
    const scaled = n / scale;
    const d = decimals ?? (suffix && Math.abs(scaled) < 100 ? 1 : 0);
    const digits = new Intl.NumberFormat(code, {
      minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(Math.abs(scaled));

    // THE SCALE SUFFIX BELONGS TO THE NUMBER, NOT AFTER THE CURRENCY.
    //
    // German and French put the symbol last, so formatting "4.1" as currency and
    // then appending the suffix produced "4,1 $m" — which reads as a currency
    // called "$m". The suffix goes on the digits, and the symbol goes wherever
    // the locale puts it.
    //
    // `Intl`'s own compact notation is not used, because it localises the suffix
    // too ("4,2 Mio."), and a deck saying "Mio." on one page and "m" on another
    // is worse than either on its own.
    const body = isCurrency ? placeCurrency(code, unit, `${digits}${suffix}`) : `${digits}${suffix}`;
    return wrapSign(body, n, sign);
  }

  const d = decimals ?? 0;
  const body = new Intl.NumberFormat(code, {
    minimumFractionDigits: d, maximumFractionDigits: d,
    ...(isCurrency ? { style: 'currency', currency: unit, currencyDisplay: 'narrowSymbol' } : {}),
  }).format(Math.abs(n));

  return wrapSign(body, n, sign);
}

/**
 * Put the currency symbol where this locale puts it, around an already-formatted
 * number.
 *
 * The position and spacing are read from `Intl` rather than from a table of our
 * own, so a locale that places its symbol unusually is handled by the same rule
 * as the rest.
 */
function placeCurrency(code, currency, formattedDigits) {
  const parts = new Intl.NumberFormat(code, {
    style: 'currency', currency, currencyDisplay: 'narrowSymbol',
  }).formatToParts(1);

  const currencyAt = parts.findIndex((p) => p.type === 'currency');
  const symbol = parts[currencyAt]?.value ?? '';
  const numberAt = parts.findIndex((p) => p.type === 'integer');
  const spacer = parts.some((p) => p.type === 'literal' && /\s/.test(p.value)) ? '\u00A0' : '';

  return currencyAt < numberAt
    ? `${symbol}${spacer}${formattedDigits}`
    : `${formattedDigits}${spacer}${symbol}`;
}

/**
 * Negatives in brackets, everywhere.
 *
 * A financial convention rather than a locale one, and it survives photocopying
 * in a way a minus sign in front of a currency symbol does not. Applied after
 * `Intl` has formatted the magnitude, so the brackets wrap whatever shape the
 * locale produced.
 */
const wrapSign = (body, n, sign) => (n < 0 ? `(${body})` : (sign && n > 0 ? `+${body}` : body));

const scaleFor = (abs) =>
  (abs >= 1e9 ? [1e9, 'bn'] : abs >= 1e6 ? [1e6, 'm'] : abs >= 1e3 ? [1e3, 'k'] : [1, '']);

/** French and German put a space before the percent sign; English does not. */
const percentSpacing = (code) => (/^(fr|de)/.test(code) ? ' %' : '%');

/**
 * A date, written the unambiguous way for a locale.
 *
 * Always with the month in words. "03/04/2026" means March in one country and
 * April in another, and a data room is read in both.
 */
export function formatDateIn(iso, locale, { style = 'long' } = {}) {
  const code = assertLocale(locale).code;
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  const options = style === 'month'
    ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
    : style === 'short'
      ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };

  return new Intl.DateTimeFormat(code, options).format(d);
}

export function formatPeriodIn(start, end, locale) {
  if (!start && !end) return '';
  if (start && end) {
    return `${formatDateIn(start, locale, { style: 'short' })} – ${formatDateIn(end, locale, { style: 'short' })}`;
  }
  return formatDateIn(start ?? end, locale, { style: 'short' });
}

// ───────────────────────────────────────── what may not be machine translated ──

/**
 * Content a model must never be asked to translate.
 *
 * Not because translation is hard, but because a mistranslated disclaimer is a
 * legal document that says something nobody checked. A jurisdiction's wording
 * for a liability limitation or a forward-looking-statements notice is drafted,
 * not rendered, and the difference between "we do not guarantee" and "nous ne
 * garantissons pas" is the kind of thing that only matters once.
 */
export const NEVER_MACHINE_TRANSLATED = Object.freeze([
  'DISCLAIMER',
  'LEGAL_NOTICE',
  'CONFIDENTIALITY',
  'FORWARD_LOOKING',
  'COMPANY_NAME',
  'PERSON_NAME',
  'SIGNATURE_BLOCK',
]);

export const isTranslatable = (kind) => !NEVER_MACHINE_TRANSLATED.includes(String(kind ?? '').toUpperCase());

export function translationRefusal(kind) {
  const k = String(kind ?? '').toUpperCase();
  if (['COMPANY_NAME', 'PERSON_NAME', 'SIGNATURE_BLOCK'].includes(k)) {
    return 'Names are not translated. A company registered as one name does not have another one in '
         + 'French, and a document that invents one is wrong in a way a counterparty will notice.';
  }
  return 'Legal and disclaimer wording is drafted for a jurisdiction, not rendered from English. A '
       + 'machine translation of it is a legal document nobody has read. Supply reviewed wording for '
       + 'this locale, or the document goes out with the English.';
}
