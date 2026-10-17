/**
 * The advisor — the answer contract, and everything that enforces it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DESIGN DECISION THAT MAKES THIS PHASE WORK
 *
 * The advisor does not write prose that is then checked for citations. It
 * returns STRUCTURED CLAIMS, each carrying the references it rests on, and the
 * prose is rendered from that structure afterwards.
 *
 * The difference is the whole phase. Generate prose and check it afterwards and
 * you are running pattern matching over natural language, hoping to notice an
 * uncited sentence; miss one and it ships looking exactly like the others.
 * Require the model to emit `{ text, cites }` and an uncited claim is not
 * something to detect — it is something that cannot be expressed.
 *
 * This is the same move as the fact store one layer up. Make the bad state
 * unrepresentable rather than detectable.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FOUR RULES A DRAFT MUST SURVIVE
 *
 *   1. Every claim cites something.
 *   2. Every citation resolves to something actually in the context. A
 *      reference to a record that was not retrieved is a fabricated citation,
 *      which is worse than no citation — it looks like diligence.
 *   3. Every numeral is accounted for: it is a cited fact's value at the
 *      precision shown, a figure the app itself computed, a criterion
 *      reference, or text appearing verbatim in a cited record. Anything else
 *      is the model originating a number, in prose, about someone's company.
 *   4. Nothing in the refusal boundary is asserted, whatever the wording.
 *
 * A draft failing any of these is REJECTED, not shown with a caveat. A caveat
 * on an answer containing an invented figure still contains the figure, and the
 * figure is what gets pasted into a deck.
 */

import { criterionByRef } from './criteria.js';
import { recordById, reviewStatus, sourceOf } from '../knowledge/corpus.js';

export class AdvisorError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Reference kinds a claim may cite. Closed set. */
export const CITE_KINDS = Object.freeze(['fact', 'knowledge', 'criterion', 'figure', 'gap']);

const kindOf = (ref) => String(ref).split(':')[0];
const idOf = (ref) => String(ref).slice(String(ref).indexOf(':') + 1);

// ───────────────────────────────────────────────────── the refusal boundary ──

/**
 * Questions the advisor refuses, before any model is called.
 *
 * Screened deterministically and up front, for two reasons. A model asked not
 * to do something complies most of the time, and "most of the time" is not a
 * boundary. And a refusal that costs a model call is a refusal that someone
 * will later be tempted to soften for cost reasons.
 *
 * Each entry says what it refuses and why, because a bare refusal reads as the
 * product being unhelpful rather than as a line drawn on purpose.
 */
export const REFUSALS = Object.freeze([
  {
    code: 'valuation',
    patterns: [
      /\bwhat(?:'s| is| are)?\s+(?:my|our|the)\s+(?:company|business|it)\s+worth\b/i,
      /\b(?:value|valuation)\s+(?:of\s+)?(?:my|our|the)\s+(?:company|business)\b/i,
      /\bhow much (?:is|are) (?:my|our|the) (?:company|business|shares?)\s+worth\b/i,
      /\bwhat\s+(?:multiple|valuation)\s+(?:should|would|could|can)\s+(?:i|we)\b/i,
      /\bhow much (?:should|can|could) (?:i|we) (?:raise|ask for|sell for)\b/i,
    ],
    says:
      'This does not put a value on your company. A valuation is a number, and the product does not '
      + 'originate numbers about your business — every figure here traces to a document you provided. It is '
      + 'also work for an adviser who can look at your market and your actual terms. '
      + 'What this can do is make sure the figures someone else values you on are reconciled, evidenced and '
      + 'consistent across your deck, your model and your accounts.',
  },
  {
    code: 'introductions',
    patterns: [
      /\b(?:introduce|introduction|connect|put me in touch|refer me)\b.{0,40}\b(?:investor|buyer|acquirer|vc|fund|bank)/i,
      /\b(?:which|what|who|any)\b.{0,30}\b(?:investors?|funds?|vcs?|buyers?|acquirers?)\b.{0,30}\b(?:should|would|could|might)\b.{0,20}\b(?:i|we|approach|talk|contact|target)\b/i,
      /\b(?:find|get|source)\s+(?:me|us)\s+(?:an?\s+)?(?:investors?|buyers?|acquirers?)\b/i,
    ],
    says:
      'This product does not make introductions, suggest who to approach, or match companies with '
      + 'counterparties, and it is not going to be built to. It prepares a company so that whoever it talks '
      + 'to finds a business whose records hold up.',
  },
  {
    code: 'professional_advice',
    patterns: [
      // An intervening noun is the normal phrasing — "is this clause legal?",
      // "are these terms enforceable?" — so the pattern allows one.
      /\b(?:is|are)\s+(?:this|that|these|those|it|they|my|our)\b[\w\s]{0,30}\b(?:legal|lawful|enforceable|binding|compliant)\b/i,
      /\b(?:legal|tax|accounting|audit)\s+advice\b/i,
      /\bshould (?:i|we) (?:sign|accept|agree to)\b/i,
      /\bwhat (?:does|do) (?:this|these) (?:clause|term|provision|contract)s?\s+mean\b/i,
      /\bhow (?:do|should) (?:i|we) (?:structure|account for|treat)\b.{0,30}\b(?:for tax|tax|under (?:ifrs|gaap|frs))/i,
    ],
    says:
      'This is a question for a qualified professional in your jurisdiction — a lawyer, an accountant or a '
      + 'tax adviser depending on which it is. The product covers operational preparation: what to gather, '
      + 'what a complete version looks like, and what order to do it in. It does not interpret your '
      + 'documents or tell you what to sign.',
  },
  {
    code: 'readiness_verdict',
    patterns: [
      /\b(?:am|are)\s+(?:i|we)\s+(?:investor[- ]?ready|ready to raise|ready to sell|fundable)\b/i,
      /\b(?:will|would|can)\s+(?:i|we)\s+(?:raise|close|get funded|sell)\b/i,
      /\b(?:what are|do we have)\s+(?:my|our|the)?\s*(?:chances|odds|likelihood)\b/i,
    ],
    says:
      'The product does not give a verdict on whether you will raise or sell, and will not predict an '
      + 'outcome. What it gives is a score against 32 criteria you answered yourself, a band with a published '
      + 'meaning, and the specific gaps behind it. That is a measurement of preparation, which is a different '
      + 'thing from a prediction — and the only one of the two that is honest.',
  },
  {
    code: 'other_organisations',
    patterns: [
      /\b(?:other|similar|comparable|peer)\s+(?:companies|customers|organisations|organizations|users)\b.{0,40}\b(?:score|band|data|average|typical|benchmark)/i,
      /\b(?:how do|where do)\s+(?:i|we)\s+compare\b/i,
      /\b(?:benchmark|average|median)\b.{0,30}\b(?:across|among|for)\b.{0,30}\b(?:companies|users|customers)\b/i,
    ],
    says:
      'There is no benchmarking, and no data from any other organisation is reachable from here — not '
      + 'aggregated, not anonymised, not in any form. Companies in a confidential process are entitled to '
      + 'have their presence here be nobody else\'s information.',
  },
]);

/**
 * Screen a question before any model call.
 * @returns {{refused: boolean, code?: string, says?: string}}
 */
export function screenQuestion(question) {
  const text = String(question ?? '');
  for (const rule of REFUSALS) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { refused: true, code: rule.code, says: rule.says };
    }
  }
  return { refused: false };
}

/**
 * Assertions a draft may not contain, however it arrived at them.
 *
 * `screenQuestion` catches the question; this catches the answer. Both are
 * needed: a question about concentration is perfectly legitimate, and an answer
 * to it that volunteers a valuation is not.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  {
    code: 'claims_valuation',
    pattern: /\b(?:your|the)\s+(?:company|business)\s+(?:is|would be|should be)\s+(?:worth|valued)\b/i,
    why: 'states a valuation',
  },
  {
    code: 'claims_valuation',
    pattern: /\bworth\s+(?:around|about|approximately|roughly|circa|some)?\s*[$£€]/i,
    why: 'states a valuation',
  },
  {
    code: 'claims_readiness',
    pattern: /\b(?:you(?:'re| are)|this (?:company|business) is)\s+(?:now\s+)?(?:investor[- ]?ready|ready to raise|ready to sell|fundable)\b/i,
    why: 'issues a readiness verdict rather than reporting a measured band',
  },
  {
    code: 'claims_outcome',
    pattern: /\b(?:you|this)\s+will\s+(?:raise|close|succeed|get funded|be acquired)\b/i,
    why: 'predicts an outcome',
  },
  {
    code: 'claims_guarantee',
    pattern: /\b(?:guarantee[sd]?|guaranteed|ensures? (?:that )?you will)\b/i,
    why: 'guarantees a result',
  },
  {
    code: 'claims_professional_advice',
    pattern: /\b(?:i|we)\s+(?:recommend|advise)\s+(?:that\s+)?you\s+(?:sign|accept|agree|incorporate|restructure)\b/i,
    why: 'gives professional advice',
  },
  {
    code: 'claims_about_counterparties',
    pattern: /\binvestors?\s+(?:require|expect|demand|insist|always|never|will not)\b/i,
    why: 'speaks for counterparties the product has not met',
  },
  {
    code: 'claims_benchmark',
    pattern: /\b(?:most|typical|average|other)\s+(?:companies|businesses|founders)\s+(?:at|in|with|have|score|achieve)\b/i,
    why: 'asserts a benchmark, and nothing here is measured across companies',
  },
]);

// ──────────────────────────────────────────────────────── numeral accounting ──

const NUMERAL = /(?:[$£€]\s?)?\d[\d,]*(?:\.\d+)?\s*(?:%|bn|billion|m\b|million|k\b|thousand)?/gi;

const SCALE = Object.freeze({
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9,
});

/**
 * Parse a numeral as written, keeping the precision it was written to.
 *
 * Precision is the point. "$4.2m" and "$4,200,000" are the same figure written
 * two ways, and a check that demanded exact string equality would reject the
 * first while a check that compared only magnitudes would accept "$4.3m". The
 * quantum — the smallest step the written form can express — is what settles it.
 */
export function parseNumeral(token) {
  const raw = String(token).trim();
  const cleaned = raw.replace(/[$£€\s,]/g, '');
  const m = cleaned.match(/^(-?\d*\.?\d+)(%|bn|billion|m|million|k|thousand)?$/i);
  if (!m) return null;

  const digits = m[1];
  const suffix = (m[2] ?? '').toLowerCase();
  const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
  const multiplier = SCALE[suffix] ?? 1;

  return {
    raw,
    value: Number(digits) * multiplier,
    // The written form can express steps of this size, and no smaller.
    quantum: (10 ** -decimals) * multiplier,
    isPercent: suffix === '%',
  };
}

/** Does `written` legitimately render `actual` at the precision it was written to? */
export function rendersValue(written, actual) {
  if (!Number.isFinite(actual)) return false;
  // Half a quantum each way: 4,199,614 rounds to 4.2m, and 4,250,001 does not.
  return Math.abs(actual - written.value) <= written.quantum / 2;
}

/**
 * Find numerals in a claim that nothing in the cited context accounts for.
 *
 * Spelled-out numbers ("three things") are free and always will be — they
 * cannot carry false precision, and the rule quietly pushes the prose towards
 * words for counts and digits only for measured quantities, which is how it
 * should read anyway.
 */
export function unaccountedNumerals(text, cited) {
  const found = String(text ?? '').match(NUMERAL) ?? [];
  const out = [];

  for (const token of found) {
    const parsed = parseNumeral(token);
    if (!parsed) continue;

    if (accountedFor(parsed, token, cited)) continue;
    out.push(parsed.raw.trim());
  }
  return [...new Set(out)];
}

function accountedFor(parsed, token, cited) {
  const trimmed = String(token).trim();

  // 1 — a cited fact, at the precision written.
  for (const fact of cited.facts) {
    if (fact.value_numeric !== null && fact.value_numeric !== undefined
        && rendersValue(parsed, Number(fact.value_numeric))) return true;
  }

  // 2 — a figure the app computed itself: a band total, a domain subtotal, a
  //     criterion score. These are ours, derived from the user's own answers by
  //     a published method, so they are as citable as a fact.
  for (const figure of cited.figures) {
    if (rendersValue(parsed, Number(figure.value))) return true;
  }

  // 3 — a criterion reference, when a criterion is cited.
  if (cited.criteria.includes(trimmed) && criterionByRef(trimmed)) return true;

  // 4 — text appearing verbatim in a cited record. A record is allowed to
  //     contain a number; quoting it back is not originating one.
  for (const record of cited.records) {
    const haystack = `${record.title} ${record.tested ?? ''} ${record.body} ${(record.pitfalls ?? []).join(' ')}`;
    if (haystack.includes(trimmed)) return true;
  }

  return false;
}

// ───────────────────────────────────────────────────────────────── validation ──

/** Resolve every reference in a draft against the context it was given. */
function resolveCites(refs, context) {
  const facts = []; const records = []; const criteria = []; const figures = []; const gaps = [];
  const unknown = [];

  for (const ref of refs) {
    const kind = kindOf(ref);
    const id = idOf(ref);

    if (!CITE_KINDS.includes(kind)) { unknown.push(ref); continue; }

    if (kind === 'fact') {
      const hit = context.facts.find((f) => f.id === id);
      hit ? facts.push(hit) : unknown.push(ref);
    } else if (kind === 'knowledge') {
      const hit = context.records.find((r) => r.id === id);
      hit ? records.push(hit) : unknown.push(ref);
    } else if (kind === 'criterion') {
      criterionByRef(id) ? criteria.push(id) : unknown.push(ref);
    } else if (kind === 'figure') {
      const hit = context.figures.find((f) => f.ref === id || f.ref === ref);
      hit ? figures.push(hit) : unknown.push(ref);
    } else if (kind === 'gap') {
      const hit = context.gaps.find((g) => g.id === id);
      hit ? gaps.push(hit) : unknown.push(ref);
    }
  }

  return { facts, records, criteria, figures, gaps, unknown };
}

/** Normalise a context so the validator can rely on every collection existing. */
export function normaliseContext(context = {}) {
  return {
    facts: context.facts ?? [],
    records: context.records ?? [],
    figures: context.figures ?? [],
    gaps: context.gaps ?? [],
    asOf: context.asOf ?? null,
  };
}

/**
 * Validate a draft against its context.
 *
 * Returns `{ ok: true, answer }` or `{ ok: false, code, problems }`. Problems
 * are plural on purpose: a model that produced three uncited claims should be
 * told about three, so a retry can fix all of them rather than discovering the
 * next one each time.
 */
export function validateDraft(draft, rawContext, { asOf = null } = {}) {
  const context = normaliseContext({ ...rawContext, asOf: rawContext?.asOf ?? asOf });
  const problems = [];

  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.sections) || !draft.sections.length) {
    return { ok: false, code: 'malformed_draft', problems: [{ problem: 'the draft has no sections' }] };
  }

  const allCites = new Set();
  let claimCount = 0;

  for (const [s, section] of draft.sections.entries()) {
    const where = section.heading ? `"${section.heading}"` : `section ${s + 1}`;

    if (!Array.isArray(section.claims) || !section.claims.length) {
      problems.push({ section: where, code: 'empty_section', problem: 'a section with no claims' });
      continue;
    }

    for (const [c, claim] of section.claims.entries()) {
      claimCount++;
      const at = `${where}, claim ${c + 1}`;
      const text = String(claim?.text ?? '').trim();

      if (!text) {
        problems.push({ section: where, code: 'empty_claim', problem: 'a claim with no text' });
        continue;
      }

      const cites = Array.isArray(claim.cites) ? claim.cites.map(String) : [];

      // RULE 1 — every claim cites something.
      if (!cites.length) {
        problems.push({
          at, code: 'uncited_claim',
          problem: `nothing is cited for: "${truncate(text)}"`,
        });
        continue;
      }

      const resolved = resolveCites(cites, context);

      // RULE 2 — every citation resolves. A reference to something that was
      // never retrieved is a fabricated citation, and a fabricated citation is
      // worse than none: it looks like the claim was checked.
      if (resolved.unknown.length) {
        problems.push({
          at, code: 'citation_not_in_context',
          problem: `cites ${resolved.unknown.join(', ')}, which was not in the context for this answer`,
        });
      }

      // RULE 3 — every numeral is accounted for.
      const loose = unaccountedNumerals(text, resolved);
      if (loose.length) {
        problems.push({
          at, code: 'unaccounted_number',
          problem: `${loose.map((n) => `"${n}"`).join(', ')} ${loose.length === 1 ? 'is' : 'are'} not in `
                 + 'anything this claim cites. Every figure must come from a document, or from a score the '
                 + 'app calculated.',
        });
      }

      // RULE 4 — nothing in the refusal boundary is asserted.
      for (const rule of FORBIDDEN_CLAIMS) {
        if (rule.pattern.test(text)) {
          problems.push({ at, code: rule.code, problem: `${rule.why}: "${truncate(text)}"` });
        }
      }

      cites.forEach((r) => allCites.add(r));
    }
  }

  // Staleness must be disclosed, not quietly inherited. A corpus that expires
  // silently is the failure a prompt has; reproducing it here would be worse,
  // because it would look as though it had been handled.
  const citedRecords = [...allCites].filter((r) => kindOf(r) === 'knowledge')
    .map((r) => context.records.find((x) => x.id === idOf(r))).filter(Boolean);

  const overdue = context.asOf
    ? citedRecords.filter((r) => reviewStatus(r, context.asOf).state === 'OVERDUE')
    : [];

  if (overdue.length && !draft.staleness_acknowledged) {
    problems.push({
      code: 'undisclosed_stale_source',
      problem: `cites ${overdue.map((r) => r.id).join(', ')}, which ${overdue.length === 1 ? 'is' : 'are'} `
             + 'past review date, without saying so',
    });
  }

  if (problems.length) {
    return { ok: false, code: problems[0].code ?? 'invalid_draft', problems, claims: claimCount };
  }

  return {
    ok: true,
    claims: claimCount,
    cites: [...allCites],
    overdue: overdue.map((r) => r.id),
    context,
  };
}

const truncate = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ───────────────────────────────────────────────────────────────── rendering ──

/**
 * Render a validated draft into the text a user reads.
 *
 * Rendering is ours, not the model's. The model supplies claims; the shape of
 * the answer, the citation markers and the sources block are produced here, so
 * they are consistent, and so a model cannot decline to show its workings by
 * formatting them away.
 */
export function renderAnswer(draft, validation) {
  const { context } = validation;
  const lines = [];
  const used = new Map();

  for (const section of draft.sections) {
    if (section.heading) lines.push(`**${section.heading}**`, '');
    for (const claim of section.claims) {
      const marks = (claim.cites ?? []).map((ref) => marker(ref, context, used)).filter(Boolean);
      lines.push(`${claim.text}${marks.length ? ` [${marks.join('][')}]` : ''}`);
      lines.push('');
    }
  }

  if (used.size) {
    lines.push('---', '', '**Where this comes from**', '');
    for (const [mark, label] of used) lines.push(`[${mark}] ${label}`);
    lines.push('');
  }

  const sources = sourcesFor(validation.cites, context);
  if (sources.length) {
    lines.push(...sources.map((s) =>
      `_${s.title} — ${s.publisher}, version ${s.version}, last reviewed ${s.reviewed}._`));
  }

  if (validation.overdue.length) {
    lines.push('', '> One or more of the records behind this answer is past its review date. '
      + 'It is shown because it is what we have, and flagged because it has not been checked recently.');
  }

  const notAdvice = [...new Set(context.records.filter((r) => r.not_advice).map((r) => r.not_advice))];
  if (notAdvice.length) lines.push('', ...notAdvice.map((n) => `_${n}_`));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function marker(ref, context, used) {
  const kind = kindOf(ref);
  const id = idOf(ref);
  let label = null;

  if (kind === 'fact') {
    const f = context.facts.find((x) => x.id === id);
    if (f) label = `${f.label} — ${describeFactSource(f)}`;
  } else if (kind === 'knowledge') {
    const r = context.records.find((x) => x.id === id) ?? recordById(id);
    if (r) label = `${r.title} (${r.id})`;
  } else if (kind === 'criterion') {
    const c = criterionByRef(id);
    if (c) label = `Criterion ${id} — ${truncate(c.text, 90)}`;
  } else if (kind === 'figure') {
    const f = context.figures.find((x) => x.ref === id || x.ref === ref);
    if (f) label = `${f.label} — calculated by RaiseRoom from your own scores`;
  } else if (kind === 'gap') {
    const g = context.gaps.find((x) => x.id === id);
    if (g) label = `Your open gap on criterion ${g.criterion_ref}`;
  }

  if (!label) return null;
  if (!used.has(ref)) used.set(ref, label);

  return [...used.keys()].indexOf(ref) + 1;
}

function describeFactSource(fact) {
  switch (fact.source) {
    case 'USER_CONFIRMED':
      return `confirmed by you from a document${fact.source_page ? `, page ${fact.source_page}` : ''}`;
    case 'USER_ENTERED': return 'entered by you';
    case 'CALCULATED': return `calculated (${fact.formula ?? 'stored formula'})`;
    default: return 'in your fact store';
  }
}

function sourcesFor(cites, context) {
  const ids = new Set((cites ?? []).filter((r) => kindOf(r) === 'knowledge').map(idOf));
  const seen = new Map();
  for (const id of ids) {
    const record = context.records.find((r) => r.id === id) ?? recordById(id);
    const source = record ? sourceOf(record.source) : null;
    if (source && !seen.has(source.id)) seen.set(source.id, source);
  }
  return [...seen.values()];
}
