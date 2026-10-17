/**
 * Fact keys: naming them, grouping them, and guessing the right one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The product refuses to let a figure be typed into a document, and that refusal
 * is correct: a number in front of an investor should have provenance. But a
 * refusal is only half an answer. "Record it as a fact first" is a reasonable
 * thing to be told once and an infuriating thing to be told the fourth time if
 * recording a fact means leaving what you were writing, finding a form, and
 * inventing a key.
 *
 * So the rule stays and the friction goes. Everything here exists to turn
 * "you can't write that" into "here is the fact you already have" or "here is
 * the one you are about to make, named and filled in — save it?".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * KEYS ARE A NAMESPACE, NOT A STRING
 *
 * `financials.revenue.ttm` sorts beside `financials.revenue.arr` and under a
 * heading a person recognises. That is the whole reason for the dots, and it is
 * why a suggested key is built from a known group rather than from whatever the
 * user typed — a fact store where half the keys start `financials.` and half
 * start `finance_` is a fact store nobody can find anything in.
 */

export const KEY_SEPARATOR = '.';

/**
 * The top-level groups, with names a person would use.
 *
 * Ordered as a user would scan them rather than alphabetically: what the
 * company earns, who it sells to, who works there, what it owns, what it has
 * promised, and what it plans.
 */
export const KEY_GROUPS = Object.freeze([
  {
    key: 'financials',
    name: 'Financials',
    hint: 'Revenue, margin, costs, earnings — anything from the accounts.',
    examples: ['financials.revenue.ttm', 'financials.gross_margin', 'financials.arr'],
  },
  {
    key: 'commercial',
    name: 'Customers and contracts',
    hint: 'Concentration, retention, pipeline, contract values.',
    examples: ['commercial.concentration.top1', 'commercial.retention.net'],
  },
  {
    key: 'people',
    name: 'People',
    hint: 'Headcount, roles, key-person dependencies.',
    examples: ['people.headcount', 'people.founders'],
  },
  {
    key: 'company',
    name: 'The company itself',
    hint: 'Registered name, incorporation, structure.',
    examples: ['company.name', 'company.incorporated_on'],
  },
  {
    key: 'cap_table',
    name: 'Ownership',
    hint: 'Holders, holdings, options, dilution.',
    examples: ['cap_table.holder.founders', 'cap_table.option_pool'],
  },
  {
    key: 'metrics',
    name: 'Operating metrics',
    hint: 'Cohorts, unit economics, anything you track monthly.',
    examples: ['metrics.cohort.2025_01', 'metrics.cac'],
  },
  {
    key: 'plan',
    name: 'The plan',
    hint: 'Targets, assumptions, use of funds.',
    examples: ['plan.use_of_funds.engineering', 'plan.assumption.1'],
  },
  {
    key: 'market',
    name: 'Market and external',
    hint: 'Anything from a source outside the company. These need a citation.',
    examples: ['market.size.serviceable'],
  },
]);

const GROUP_KEYS = Object.freeze(KEY_GROUPS.map((g) => g.key));

/** The group a key belongs to, or null for one that fits no group. */
export function groupOf(factKey) {
  const head = String(factKey ?? '').split(KEY_SEPARATOR)[0];
  return GROUP_KEYS.includes(head) ? head : null;
}

export const groupNameOf = (factKey) =>
  KEY_GROUPS.find((g) => g.key === groupOf(factKey))?.name ?? 'Other';

/** A key segment: lower case, words joined by underscores, nothing exotic. */
export function slugSegment(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[''']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Words that carry no meaning in a key.
 *
 * "Total revenue for the last twelve months" should suggest `revenue`, not
 * `total_revenue_for_the_last_twelve_months`.
 */
const NOISE = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'and', 'or', 'our', 'we', 'us',
  'total', 'number', 'amount', 'value', 'figure', 'current', 'last', 'this', 'per',
]);

/**
 * Phrases that reliably indicate a group, so the suggestion lands in the right
 * place rather than defaulting everything to one heading.
 */
const GROUP_HINTS = Object.freeze([
  // Order matters: the more specific term wins. "Net revenue retention" is a
  // customer metric, not a financial one, and it mentions revenue.
  [/\b(customer|client|churn|retention|concentration|contract|pipeline|renewal)\b/i, 'commercial'],
  [/\b(revenue|arr|mrr|margin|profit|ebitda|earnings|cost|cogs|cash|burn|runway|turnover)\b/i, 'financials'],
  [/\b(headcount|employee|staff|hire|founder|team|contractor)\b/i, 'people'],
  [/\b(shareholder|holder|equity|option|dilution|cap table|ownership)\b/i, 'cap_table'],
  [/\b(cohort|cac|ltv|unit econ|conversion|activation)\b/i, 'metrics'],
  [/\b(target|assumption|use of funds|forecast|plan)\b/i, 'plan'],
  [/\b(market|tam|sam|som|industry|sector)\b/i, 'market'],
  [/\b(incorporat|registered|company name|jurisdiction)\b/i, 'company'],
]);

export function suggestGroup(label) {
  for (const [pattern, group] of GROUP_HINTS) {
    if (pattern.test(String(label ?? ''))) return group;
  }
  return null;
}

/**
 * Suggest a key for a new fact.
 *
 * Deterministic, so the same label always suggests the same key — which matters
 * more than it sounds. Two people recording "gross margin" a week apart should
 * land on the same key, or the fact store quietly grows two of everything.
 *
 * Collisions get a numeric suffix rather than silently reusing a key, because a
 * key already in use belongs to a fact that exists, and a new figure under it
 * would read as a correction of that fact rather than a different one.
 */
export function suggestKey(label, { group = null, existing = [] } = {}) {
  const head = group ?? suggestGroup(label) ?? 'financials';

  const words = String(label ?? '')
    .split(/\s+/)
    .map((w) => slugSegment(w))
    .filter(Boolean)
    .filter((w) => !NOISE.has(w));

  const tail = words.slice(0, 3).join('_') || 'figure';
  const base = `${head}${KEY_SEPARATOR}${tail}`;

  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/**
 * A readable label from a key, for a fact store that grew keys before labels.
 * `financials.revenue.ttm` → "Financials · revenue ttm".
 */
export function labelFromKey(factKey) {
  const parts = String(factKey ?? '').split(KEY_SEPARATOR);
  const rest = parts.slice(1).join(' ').replace(/_/g, ' ');
  return rest ? `${groupNameOf(factKey)} · ${rest}` : groupNameOf(factKey);
}

// ───────────────────────────────────────────────── reading a written figure ──

/**
 * What unit a written figure is in, as far as the way it is written says.
 *
 * Only what the notation actually tells us. "$4.2m" is dollars; "4.2" is
 * nothing in particular, and guessing a currency for it would put a unit on a
 * fact that the user never stated — which is the same class of invention the
 * whole architecture exists to prevent, just smaller.
 */
export function unitFromNotation(token) {
  const raw = String(token ?? '').trim();
  if (/%/.test(raw)) return 'percent';
  if (/^\$|\bUSD\b/i.test(raw)) return 'USD';
  if (/^£|\bGBP\b/i.test(raw)) return 'GBP';
  if (/^€|\bEUR\b/i.test(raw)) return 'EUR';
  return null;
}

/**
 * The words around a figure, as a starting label.
 *
 * A guess, offered for editing rather than applied. "Revenue grew to $4.2m last
 * year" should put "Revenue grew" in the box so the user adjusts a draft instead
 * of facing an empty field — the difference between a form and a confirmation.
 */
export function labelFromContext(text, token, { words = 6 } = {}) {
  const haystack = String(text ?? '');
  const at = haystack.indexOf(String(token));
  if (at < 0) return '';

  const picked = haystack.slice(0, at).trim().split(/\s+/).filter(Boolean).slice(-words);

  // Trim from the right first: the words nearest the figure are prepositions and
  // verbs that led into it. "Revenue grew to" is a label of "Revenue"; "the team
  // reached" is a label of "team".
  while (picked.length && (TRAILING.test(picked[picked.length - 1]))) picked.pop();
  // Then from the left, where the previous clause ends: "last year and the" in
  // front of "team" is somebody else's sentence.
  while (picked.length && LEADING.test(picked[0])) picked.shift();

  const label = picked.join(' ').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').trim();
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Words that lead into a figure rather than name it.
 *
 * Prepositions, copulas, and the verbs a figure is usually reached by. Trimmed
 * from the right because they always sit between the name and the number:
 * "revenue grew to 4.2m", "headcount stood at 34", "margin came in at 63.9%".
 */
const TRAILING = /^(to|of|at|in|on|by|from|with|was|is|were|are|be|been|about|around|roughly|just|over|under|some|now|then|grew|rose|fell|reached|hit|totall?ed|stood|stands|came|climbed|dropped|increased|decreased|remains?|sits?|runs?)[.,:;]?$/i;

/** Words that end the previous clause rather than start this label. */
const LEADING = /^(and|but|or|so|then|while|whereas|although|though|because|since|also|last|this|next|the|a|an|our|its|their|year|month|quarter|period)[.,:;]?$/i;
