/**
 * Valuation readiness — preparing for a valuation, which is not the same thing
 * as producing one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO, AND WHY THAT IS THE POINT
 *
 * **This file contains no opinion about what any company is worth.** Not an
 * estimate, not a range, not a multiple, not a comparison. The advisor refuses
 * valuation questions and tells the user why — *a valuation is a number, and
 * this product does not originate numbers about your business* — and a feature
 * that quietly contradicted that sentence would make every other provenance
 * claim in the product into marketing copy.
 *
 * It also makes no claim about what a valuer, an investor or a buyer will do.
 * The knowledge corpus forbids speaking for counterparties the product has not
 * met, and that rule is not suspended because the subject is valuation. So every
 * area below is phrased as a property of the COMPANY'S OWN RECORDS — something
 * that can be checked against the file itself and that the company can be right
 * or wrong about — rather than as a prediction about somebody else's judgement.
 *
 * The honest version of this feature is therefore narrow and genuinely useful:
 * *here is what you will be asked to evidence, here is what you currently have,
 * and here is what is missing.* Whoever performs the valuation is a separate,
 * independent professional, and that separation is a feature rather than a
 * limitation — a number produced by software sold by a party connected to the
 * firm that then advises on the transaction is worth less than one produced by
 * somebody with no stake in it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND NO TAX OR LEGAL GUIDANCE
 *
 * There is a strong temptation to explain the rules — when a valuation must be
 * refreshed, what happens if it is wrong. The product does not do this. Those
 * rules are jurisdiction-specific, they change, and getting one subtly wrong in
 * software is worse than staying silent: a founder who relies on it has a tax
 * problem and a screenshot. What this file says instead is what the two common
 * kinds of valuation are FOR, so a founder knows which conversation they are
 * having, and then points at the professionals who have those conversations.
 */

export class ValuationError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * The two things people mean by "valuation", kept apart.
 *
 * Founders routinely conflate these, and the conflation is expensive in both
 * directions: treating a negotiated round price as a fair market value, or
 * expecting an appraisal to match what an investor just paid.
 *
 * Both descriptions are orientation, not advice, and neither says what anybody
 * should do. The sourcing for the distinction is recorded in
 * `docs/VALUATION-SOURCES.md` rather than asserted here as common knowledge.
 */
export const VALUATION_KINDS = Object.freeze([
  {
    key: 'FUNDRAISING',
    name: 'A fundraising valuation',
    what: 'The price a round is done at. It is negotiated with investors, and it is usually a price '
        + 'for preferred shares, which carry rights that ordinary shares do not.',
    who: 'Agreed between the company and its investors. Nobody appraises it; it is the outcome of a '
       + 'negotiation.',
    what_this_product_does: 'Prepares the evidence you will be asked for, and shows what is missing '
                          + 'from it. It does not estimate the number and will not.',
  },
  {
    key: 'APPRAISAL',
    name: 'An independent appraisal',
    what: 'A formal opinion of fair market value, produced by a qualified independent appraiser. In '
        + 'the United States the common example is the valuation used to set the exercise price of '
        + 'employee share options.',
    who: 'An independent valuation professional with no stake in the outcome. That independence is '
       + 'the point of it, which is why no software — including this — can produce one.',
    what_this_product_does: 'Gets your records into the state an appraiser will ask for, so the '
                          + 'engagement is short and the result is defensible.',
  },
]);

/**
 * Why the two numbers differ, when a founder notices that they do.
 *
 * Stated because the question is asked constantly and the absence of an answer
 * sends people somewhere worse. Deliberately an explanation of mechanism rather
 * than a rule of thumb, and carrying no figure of any kind.
 */
export const WHY_THEY_DIFFER =
  'An appraisal of ordinary shares commonly lands below the price investors paid for preferred '
  + 'shares in the same company. The two are measuring different instruments: preferred shares '
  + 'usually carry rights ordinary shares do not — a liquidation preference being the usual one — '
  + 'and an appraisal of a private company also has to account for the fact that its shares cannot '
  + 'readily be sold. This product does not estimate the size of either effect, and nobody should '
  + 'infer one number from the other.';

/**
 * The five areas a company is asked to evidence.
 *
 * Each is a property of the company's own records. `demonstrates` is what the
 * company would be showing; `reproducible_when` is the test — stated so that two
 * people could agree whether it has been met, which is the same bar the gap
 * register uses for its done-when.
 *
 * None of them says what a valuer will conclude.
 */
export const EVIDENCE_AREAS = Object.freeze([
  {
    key: 'NORMALISED_EARNINGS',
    name: 'Normalised earnings, with the bridge evidenced',
    demonstrates: 'What the business earns once one-off and owner-specific items are taken out, and '
                + 'exactly how that was arrived at from the statutory accounts.',
    reproducible_when: 'Somebody who did not prepare the bridge can start from the filed accounts, '
                     + 'follow each adjustment to a document, and arrive at the same figure.',
    requires: ['financials.reported_profit', 'financials.normalised_earnings'],
    uses: ['financials.revenue.ttm', 'financials.cogs.ttm', 'financials.gross_margin'],
    group: 'financials.adjustment.',
    // The commonest reason this area fails, and it is never the arithmetic.
    usual_weakness: 'An adjustment everybody in the company agrees about, with nothing on file that '
                  + 'shows it happened.',
  },
  {
    key: 'CONCENTRATION',
    name: 'Customer concentration, and its direction of travel',
    demonstrates: 'How much of the revenue depends on how few customers, and whether that dependence '
                + 'is increasing or decreasing.',
    reproducible_when: 'The concentration figures can be rebuilt from the sales ledger for each '
                     + 'period shown, by the same definition each time.',
    requires: ['commercial.concentration.top1'],
    uses: ['commercial.concentration.top3', 'commercial.concentration.top5',
      'commercial.concentration.top1.prior'],
    usual_weakness: 'A single current figure with nothing to compare it to, which cannot show a '
                  + 'direction.',
  },
  {
    key: 'RETENTION',
    name: 'Retention, defined and reproducible',
    demonstrates: 'Whether customers stay, measured by a definition that is written down and applied '
                + 'the same way in every period.',
    reproducible_when: 'The definition is stated, and running it again over the same data gives the '
                     + 'same number.',
    requires: ['commercial.retention.net'],
    uses: ['commercial.retention.gross', 'commercial.churn'],
    group: 'metrics.cohort.',
    usual_weakness: 'A retention number whose definition changed between periods, which makes a '
                  + 'trend that is not there.',
  },
  {
    key: 'TRANSFERABILITY',
    name: 'Contract transferability',
    demonstrates: 'Whether the revenue survives a change of ownership, or whether contracts can be '
                + 'terminated or need consent when control changes.',
    reproducible_when: 'Every material contract is on file and its change-of-control position has '
                     + 'been read and recorded.',
    requires: ['commercial.contracts.change_of_control_count'],
    uses: ['commercial.contracts.material_count'],
    usual_weakness: 'Contracts filed but never read for this specific clause, so nobody knows the '
                  + 'answer until a buyer\'s lawyer finds it.',
  },
  {
    key: 'KEY_PERSON',
    name: 'Key-person exposure',
    demonstrates: 'How much of the business depends on individuals, and what is in place if one of '
                + 'them stops.',
    reproducible_when: 'The dependencies are named, and for each one the position is recorded — '
                     + 'documented, insured, delegated, or acknowledged as open.',
    requires: ['people.key_person_count'],
    uses: ['people.headcount', 'people.founders'],
    usual_weakness: 'A dependency everybody knows about that appears nowhere in the file, which a '
                  + 'buyer then discovers for themselves.',
  },
]);

export const AREA_KEYS = Object.freeze(EVIDENCE_AREAS.map((a) => a.key));
export const areaFor = (key) => EVIDENCE_AREAS.find((a) => a.key === key) ?? null;

/**
 * How ready one area is, from the facts actually held.
 *
 * Three states and no score. A percentage here would be a number about the
 * company's prospects dressed as a measurement, which is the thing this feature
 * exists to not do.
 */
export function areaReadiness(area, facts) {
  const byKey = new Map(facts.map((f) => [f.fact_key, f]));
  const has = (key) => byKey.has(key);

  const required = area.requires ?? [];
  const optional = area.uses ?? [];
  const grouped = area.group
    ? facts.filter((f) => f.fact_key.startsWith(area.group))
    : [];

  const missingRequired = required.filter((k) => !has(k));
  const presentOptional = optional.filter(has);
  const anyEvidence = required.some(has) || presentOptional.length > 0 || grouped.length > 0;

  // Required facts decide the state; optional ones strengthen an area without
  // gating it. The first version required an optional fact for EVIDENCED, which
  // meant "optional" was not optional — an area with everything it demanded
  // still reported as partly done, and the user had no way to find out why.
  const state = missingRequired.length
    ? (anyEvidence ? 'PARTIAL' : 'NOT_STARTED')
    : 'EVIDENCED';

  return {
    key: area.key,
    name: area.name,
    state,
    demonstrates: area.demonstrates,
    reproducible_when: area.reproducible_when,
    usual_weakness: area.usual_weakness,
    present: [...required.filter(has), ...presentOptional],
    missing_required: missingRequired,
    missing_optional: optional.filter((k) => !has(k)),
    grouped_count: grouped.length,
    // Evidence is only evidence if it is traceable. A figure somebody typed is
    // worth less here than the same figure confirmed from the accounts, and
    // saying so is the product's whole argument.
    document_backed: [...required.filter(has), ...presentOptional]
      .filter((k) => byKey.get(k)?.source === 'USER_CONFIRMED').length,
  };
}

/**
 * The pack, assembled.
 *
 * Returns areas and what is missing. It does NOT return an overall score, a
 * grade or a readiness percentage: a single number summarising how ready a
 * company is to be valued would be read as a view about the valuation, which is
 * exactly the inference this feature must not invite.
 */
export function valuationReadiness(facts = []) {
  const areas = EVIDENCE_AREAS.map((area) => areaReadiness(area, facts));
  return {
    areas,
    evidenced: areas.filter((a) => a.state === 'EVIDENCED').map((a) => a.key),
    partial: areas.filter((a) => a.state === 'PARTIAL').map((a) => a.key),
    not_started: areas.filter((a) => a.state === 'NOT_STARTED').map((a) => a.key),
    // The one thing this feature is willing to say about the number itself.
    no_estimate: 'This pack contains no estimate of what the company is worth, and will not. It '
               + 'shows what you can currently evidence and what you cannot.',
  };
}

// ──────────────────────────────────────────── the own-assumption calculator ──

/**
 * Arithmetic on the user's own assumption.
 *
 * The distinction this rests on is narrow and it is the whole thing: the user
 * supplies the multiple. The product multiplies. It does not suggest a multiple,
 * does not offer a range, does not say whether one is reasonable, and does not
 * remember one as a recommendation.
 *
 * That makes the output a calculation, which the fact store already has a source
 * for — `CALCULATED`, with the formula and the inputs stored, which means it can
 * be audited and recomputed. A figure produced any other way would have no
 * source that honestly described it.
 */
export const MAX_MULTIPLE = 1000;

export function checkAssumption({ multiple, base }) {
  const problems = [];

  // `Number(null)` is 0 and `Number('')` is 0. That single piece of JavaScript
  // has now produced a bug in four separate places in this codebase, and here it
  // turned "you have not entered a multiple" into "your multiple is not
  // positive" — a confusing message about a field the user had not touched.
  const m = multiple === null || multiple === undefined || multiple === ''
    ? null
    : Number(multiple);

  if (m === null || !Number.isFinite(m)) {
    problems.push({ code: 'multiple_required', problem: 'Enter the multiple you want to apply.' });
  } else if (m <= 0) {
    problems.push({ code: 'multiple_not_positive', problem: 'A multiple has to be greater than zero.' });
  } else if (m > MAX_MULTIPLE) {
    // Not a judgement about plausibility — a guard against a typo producing a
    // figure with three extra digits in a document.
    problems.push({
      code: 'multiple_implausible',
      problem: `${m}× is almost certainly a typo. If you mean it, record it as a fact with a note `
             + 'explaining why.',
    });
  }

  if (!base) {
    problems.push({
      code: 'no_base_figure',
      problem: 'There is no confirmed figure to apply a multiple to. Record and confirm the figure '
             + 'you want to use first.',
    });
  } else if (base.value_numeric === null || base.value_numeric === undefined) {
    problems.push({ code: 'base_not_numeric', problem: 'That fact has no number in it.' });
  } else if (base.source === 'DOCUMENT_EXTRACTED') {
    // The same bar as everywhere else: an unconfirmed extraction is a proposal.
    problems.push({
      code: 'base_not_confirmed',
      problem: 'That figure was read from a document and nobody has confirmed it yet. Confirm it '
             + 'first — a calculation built on an unconfirmed figure inherits the doubt.',
    });
  }

  return problems;
}

/**
 * The calculation, and how to describe it honestly.
 *
 * `formula` is stored on the fact, so the arithmetic can be checked and redone.
 * `label` deliberately contains the word "assumption" and names the multiple:
 * a figure labelled "Valuation" in somebody's data room, produced by software,
 * is the thing this whole design exists to avoid.
 */
export function applyAssumption({ multiple, base, note = null }) {
  const problems = checkAssumption({ multiple, base });
  if (problems.length) {
    throw new ValuationError('assumption_rejected', 'that assumption cannot be applied', 400, { problems });
  }

  const m = Number(multiple);
  const value = Number(base.value_numeric) * m;

  return {
    value_numeric: value,
    unit: base.unit,
    formula: `${base.fact_key} × ${m}`,
    input_fact_ids: [base.id],
    label: `${trimMultiple(m)}× ${base.label} — your assumption`,
    // Returned alongside so a UI shows it next to the figure rather than in a
    // footnote nobody reads.
    disclosure: `This is ${trimMultiple(m)} times ${base.label}, which you supplied. It is arithmetic `
              + 'on your own assumption, not a valuation and not an opinion about one. Nobody has '
              + 'assessed whether that multiple is appropriate for this business.',
    note: note ? String(note).trim() : null,
  };
}

const trimMultiple = (m) => (Number.isInteger(m) ? String(m) : String(Number(m.toFixed(2))));

/**
 * What to do with the pack once it is complete.
 *
 * Describes the KIND of professional, never a firm. The product names no vendors
 * anywhere, and a recommendation from software sold by a party connected to a
 * firm that advises on transactions would be worth less than no recommendation
 * at all.
 */
export const NEXT_STEPS = Object.freeze([
  {
    for: 'APPRAISAL',
    step: 'Engage an independent valuation professional',
    detail: 'Appraisals are produced by qualified valuation specialists with no stake in the result. '
          + 'Your accountant can usually point you at firms that do this work, and the pack below is '
          + 'most of what they will ask you for.',
  },
  {
    for: 'FUNDRAISING',
    step: 'Take the pack into the conversation',
    detail: 'A round price is negotiated, not appraised. What the pack changes is how long the '
          + 'conversation takes and how much of it is spent establishing figures rather than '
          + 'discussing the business.',
  },
  {
    for: 'TAX_AND_LEGAL',
    step: 'Ask your accountant and your lawyer about the rules that apply to you',
    detail: 'When a valuation is needed, how long it lasts, and what happens if it is wrong are '
          + 'jurisdiction-specific and they change. This product does not give tax or legal advice '
          + 'and will not summarise those rules, because a summary that is subtly out of date is '
          + 'worse than no summary.',
  },
]);
