/**
 * The Transfer Sheet — field definitions and the deterministic reader.
 *
 * WHAT IT IS
 *
 * A short fillable PDF, given away free, that carries the work out of the
 * *Before They Ask* workbook and into the app. Someone who has spent four
 * sessions scoring 32 criteria and writing down their concentration figures
 * should not then retype them, and the number of people who abandon a product
 * at a retyping step is high.
 *
 * WHY A PDF FORM AND NOT A SCAN
 *
 * Reading an AcroForm field is not extraction. The value is stored in the file
 * as the characters the user typed; reading it back is lossless and identical
 * every time. There is no model, no inference, and no confidence score, which
 * is why these values are USER_ENTERED — the author of the value is the user,
 * and the read is transcription.
 *
 * A handwritten-and-scanned sheet is deliberately NOT read. Handwriting
 * recognition is at its worst on digits and decimal points, which is exactly
 * what this sheet is made of: a concentration figure mangled from 68 to 6.8
 * would enter the fact store wearing a clean provenance label, and the first
 * time anyone noticed would be in a meeting. A scanned sheet is stored as a
 * reference document and the user is asked to type the figures instead.
 *
 * SINGLE SOURCE OF TRUTH
 *
 * These field definitions are the only place the mapping lives. The PDF
 * generator reads them, the reader reads them, and `src/api/onramp.js` derives
 * its worksheet mapping from them. The alternative — a field list in the
 * generator and a parallel mapping in the importer — is a drift waiting to
 * happen, and the drift would be silent.
 */

import { ALL_REFS } from './criteria.js';

export class TransferSheetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Bumped whenever a field is added, removed or re-meaninged.
 *
 * The version is written into a hidden field in every generated sheet, so a
 * sheet filled in on an older edition is identified rather than guessed at. A
 * reader that silently maps an unknown field name to its best guess is how
 * someone's revenue ends up in the headcount column.
 */
export const TRANSFER_SHEET_VERSION = '1.0';

export const META_FIELDS = Object.freeze({
  version: 'sheet_version',
  receipt: 'receipt_ref',
});

/** Direction-of-travel choices for worksheet 4. */
export const DIRECTION_CHOICES = Object.freeze(['INCREASING', 'STABLE', 'DECREASING']);

/**
 * Worksheet 1 — the 32 criterion scores.
 * Field name is the criterion ref with dots replaced: `1.1` -> `s_1_1`.
 */
export const SCORE_FIELD_OF = (ref) => `s_${String(ref).replace('.', '_')}`;
export const SCORE_FIELDS = Object.freeze(ALL_REFS.map((ref) => ({
  field: SCORE_FIELD_OF(ref), ref, worksheet: 1, type: 'score',
})));

/**
 * Worksheets 3, 4 and 9 — figures that become facts.
 *
 * `group` and `member` are the shape `redeemWorkbook()` expects, so the onramp
 * mapping is derived from this list rather than written twice.
 */
export const FACT_FIELDS = Object.freeze([
  // Worksheet 3 — the normalisation bridge
  { field: 'norm_reported_profit', group: 'normalisation', member: 'reported_profit', worksheet: 3, type: 'number', unit: 'USD', fact_key: 'financials.reported_profit', label: 'Reported profit' },
  { field: 'norm_normalised_earnings', group: 'normalisation', member: 'normalised_earnings', worksheet: 3, type: 'number', unit: 'USD', fact_key: 'financials.normalised_earnings', label: 'Normalised earnings' },
  { field: 'norm_period', group: 'normalisation', member: 'period', worksheet: 3, type: 'text', fact_key: 'financials.normalisation_period', label: 'Normalisation period' },

  // Worksheet 4 — customer concentration
  { field: 'conc_top1', group: 'concentration', member: 'top_1_pct', worksheet: 4, type: 'number', unit: 'percent', fact_key: 'commercial.concentration.top1', label: 'Top customer share of revenue' },
  { field: 'conc_top3', group: 'concentration', member: 'top_3_pct', worksheet: 4, type: 'number', unit: 'percent', fact_key: 'commercial.concentration.top3', label: 'Top 3 customers share of revenue' },
  { field: 'conc_top5', group: 'concentration', member: 'top_5_pct', worksheet: 4, type: 'number', unit: 'percent', fact_key: 'commercial.concentration.top5', label: 'Top 5 customers share of revenue' },
  { field: 'conc_top1_prior', group: 'concentration', member: 'top_1_pct_two_years_ago', worksheet: 4, type: 'number', unit: 'percent', fact_key: 'commercial.concentration.top1.prior', label: 'Top customer share, two years ago' },
  { field: 'conc_direction', group: 'concentration', member: 'direction', worksheet: 4, type: 'choice', choices: DIRECTION_CHOICES, fact_key: 'commercial.concentration.direction', label: 'Concentration direction of travel' },

  // Worksheet 9 — the three load-bearing assumptions
  { field: 'assum_1', group: 'assumptions', member: 'one', worksheet: 9, type: 'text', fact_key: 'plan.assumption.1', label: 'Load-bearing assumption 1' },
  { field: 'assum_2', group: 'assumptions', member: 'two', worksheet: 9, type: 'text', fact_key: 'plan.assumption.2', label: 'Load-bearing assumption 2' },
  { field: 'assum_3', group: 'assumptions', member: 'three', worksheet: 9, type: 'text', fact_key: 'plan.assumption.3', label: 'Load-bearing assumption 3' },
]);

/** Worksheet 5 — key-person dependencies. Four rows is what fits and what people fill in. */
export const KEY_PERSON_ROWS = 4;
export const KEY_PERSON_FIELDS = Object.freeze(
  Array.from({ length: KEY_PERSON_ROWS }, (_, i) => ({
    row: i + 1, worksheet: 5,
    person: `kp${i + 1}_person`,
    holds: `kp${i + 1}_holds`,
    deputy: `kp${i + 1}_deputy`,
  })),
);

/** Every field name a generated sheet contains. Used by the generator and the tests. */
export const ALL_FIELD_NAMES = Object.freeze([
  META_FIELDS.version, META_FIELDS.receipt,
  ...SCORE_FIELDS.map((f) => f.field),
  ...FACT_FIELDS.map((f) => f.field),
  ...KEY_PERSON_FIELDS.flatMap((r) => [r.person, r.holds, r.deputy]),
]);

/**
 * The worksheet mapping `redeemWorkbook()` uses, derived from the field list.
 *
 * Shape: { normalisation: [{ field, key, label, unit, numeric }], ... }
 */
export const WORKSHEET_FACT_MAP = Object.freeze(
  FACT_FIELDS.reduce((acc, f) => {
    (acc[f.group] ??= []).push(Object.freeze({
      field: f.member,
      key: f.fact_key,
      label: f.label,
      unit: f.unit ?? null,
      numeric: f.type === 'number',
    }));
    return acc;
  }, {}),
);

// ──────────────────────────────────────────────────────────────── coercion ──

/** Values that mean "deliberately left blank", not "zero". */
const BLANK = new Set(['', '-', '—', 'n/a', 'na', 'n.a.', 'none', 'tbc', 'tbd', '?']);

const isBlank = (raw) => raw === null || raw === undefined || BLANK.has(String(raw).trim().toLowerCase());

/**
 * Coerce a typed figure.
 *
 * Accepts the ways people actually write numbers into a form: `$1,200,000`,
 * `1.2m`, `68%`, `(4,000)` for a negative. Refuses anything ambiguous rather
 * than picking an interpretation — `60-70` is not 65, and silently making it 65
 * would put an invented figure in the fact store with a clean label on it.
 */
export function coerceNumber(raw, { unit = null } = {}) {
  if (isBlank(raw)) return { present: false, value: null };

  let s = String(raw).trim();
  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);

  s = s.replace(/[\s,$£€]/g, '').replace(/%$/, '');

  // A range, a list, or two numbers in one box.
  if (/\d\s*(?:-|–|to|\/|and)\s*\d/i.test(String(raw).replace(/[\s,$£€]/g, ''))) {
    return { present: false, value: null, problem: `"${raw}" looks like a range. Enter one figure.` };
  }

  let multiplier = 1;
  const suffix = s.match(/([kmbn])$/i);
  if (suffix) {
    multiplier = { k: 1e3, m: 1e6, b: 1e9, n: 1e6 }[suffix[1].toLowerCase()];
    if (suffix[1].toLowerCase() === 'n') {
      return { present: false, value: null, problem: `"${raw}" is ambiguous. Write the figure in full.` };
    }
    s = s.slice(0, -1);
  }

  if (!/^-?\d*\.?\d+$/.test(s)) {
    return { present: false, value: null, problem: `"${raw}" is not a number this sheet can read. Type digits only.` };
  }

  let n = Number(s) * multiplier;
  if (!Number.isFinite(n)) {
    return { present: false, value: null, problem: `"${raw}" is not a finite number.` };
  }
  if (negative) n = -n;

  if (unit === 'percent' && (n < 0 || n > 100)) {
    return {
      present: false, value: null,
      problem: `"${raw}" is outside 0–100 for a percentage. If you meant a proportion, write it as a percentage.`,
    };
  }

  return { present: true, value: n };
}

/** Coerce a 0–5 criterion score. Integers only; the scale has no half marks. */
export function coerceScore(raw) {
  if (isBlank(raw)) return { present: false, value: null };

  const s = String(raw).trim();
  if (!/^[0-5]$/.test(s)) {
    return {
      present: false, value: null,
      problem: `"${raw}" is not a score. The scale is 0 to 5, whole numbers only.`,
    };
  }
  return { present: true, value: Number(s) };
}

/** Coerce a choice field against its declared options. */
export function coerceChoice(raw, choices) {
  if (isBlank(raw)) return { present: false, value: null };
  const s = String(raw).trim().toUpperCase();
  const hit = choices.find((c) => c === s || c.startsWith(s));
  if (!hit) {
    return {
      present: false, value: null,
      problem: `"${raw}" is not one of ${choices.join(', ')}.`,
    };
  }
  return { present: true, value: hit };
}

const coerceText = (raw) => (isBlank(raw) ? { present: false, value: null } : { present: true, value: String(raw).trim() });

// ────────────────────────────────────────────────────────────────── reading ──

/**
 * Turn raw AcroForm field values into the input `redeemWorkbook()` expects.
 *
 * Pure, deterministic, and the part of the Transfer Sheet route that is
 * actually tested. The byte-level AcroForm read happens in
 * `tools/read_transfer_sheet.py`; everything that decides what a value *means*
 * is here.
 *
 * @param {object} fieldValues  field name -> string, as read from the PDF
 * @returns {{input: object, problems: object[], version: string|null, filled: number}}
 *
 * Problems are RETURNED, never thrown and never guessed around. A sheet with
 * three unreadable boxes imports the other twenty-nine and tells the user
 * exactly which three to fix — refusing the whole sheet over one typo is how
 * people give up, and silently dropping the three is how a number goes missing
 * without anyone knowing.
 */
export function parseTransferSheet(fieldValues = {}) {
  const problems = [];
  const input = {};
  let filled = 0;

  const version = fieldValues[META_FIELDS.version]
    ? String(fieldValues[META_FIELDS.version]).trim()
    : null;

  if (!version) {
    problems.push({
      field: META_FIELDS.version, severity: 'WARNING',
      problem: 'This file does not identify itself as a Transfer Sheet. It may be a different PDF, or an '
             + 'edition from before versioning. The fields that could be read have been.',
    });
  } else if (version !== TRANSFER_SHEET_VERSION) {
    problems.push({
      field: META_FIELDS.version, severity: 'WARNING',
      problem: `This sheet is edition ${version}; the current edition is ${TRANSFER_SHEET_VERSION}. `
             + 'Fields that still exist have been read. Download the current sheet for the rest.',
    });
  }

  const receipt = coerceText(fieldValues[META_FIELDS.receipt]);
  if (receipt.present) input.receipt_ref = receipt.value;

  // ── worksheet 1 ──
  const scores = {};
  for (const f of SCORE_FIELDS) {
    const r = coerceScore(fieldValues[f.field]);
    if (r.problem) problems.push({ field: f.field, criterion_ref: f.ref, severity: 'ERROR', problem: r.problem });
    if (r.present) { scores[f.ref] = r.value; filled++; }
  }
  if (Object.keys(scores).length) input.scores = scores;

  // ── worksheets 3, 4, 9 ──
  for (const f of FACT_FIELDS) {
    const raw = fieldValues[f.field];
    const r = f.type === 'number' ? coerceNumber(raw, { unit: f.unit })
      : f.type === 'choice' ? coerceChoice(raw, f.choices)
        : coerceText(raw);

    if (r.problem) problems.push({ field: f.field, fact_key: f.fact_key, severity: 'ERROR', problem: r.problem });
    if (r.present) {
      (input[f.group] ??= {})[f.member] = r.value;
      filled++;
    }
  }

  // ── worksheet 5 ──
  const people = [];
  for (const row of KEY_PERSON_FIELDS) {
    const person = coerceText(fieldValues[row.person]);
    const holds = coerceText(fieldValues[row.holds]);
    const deputy = coerceText(fieldValues[row.deputy]);

    if (!person.present && !holds.present) continue;

    // A name with nothing beside it is not a dependency record. The whole point
    // of worksheet 5 is naming what the person uniquely holds; without that it
    // is a staff list.
    if (person.present !== holds.present) {
      problems.push({
        field: person.present ? row.holds : row.person, severity: 'ERROR',
        problem: `Key person ${row.row} is incomplete. A dependency needs both the person and what they `
               + 'uniquely hold — a name on its own records nothing.',
      });
      continue;
    }

    people.push({ person: person.value, holds: holds.value, deputy: deputy.present ? deputy.value : null });
    filled++;
  }
  if (people.length) input.key_people = people;

  return { input, problems, version, filled };
}

/** True when nothing usable came out of the file. */
export const isEmptySheet = (parsed) => parsed.filled === 0;
