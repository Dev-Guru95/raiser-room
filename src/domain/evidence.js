/**
 * Evidence for claims about the world outside the company.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 *
 * A deck needs market context: how large the market is, how fast it is growing,
 * what the regulatory direction of travel is. None of that comes from the
 * company's own documents, so none of it is covered by the fact store's rules.
 *
 * The obvious thing to build is a feature that asks a model for a market size
 * and prints it with a citation. That feature would be the single most
 * damaging thing in this product. A language model will produce
 * "the global X market was $47.3bn in 2025, growing at 12.4% CAGR" together
 * with a publisher, a report title and a year, and every part of it can be
 * invented — including the report. It reads as more authoritative than a real
 * figure, because real figures are rarely that tidy. A founder would put it in
 * front of an investor, and the investor would be the one to check it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS BUILT INSTEAD
 *
 * An external claim takes exactly the same route as any other figure: the user
 * supplies the source document or page, the extraction pipeline reads a
 * candidate from it with a locator, and a human confirms it against the source.
 * There is no separate path and no model-sourced statistic, which is why this
 * module adds rules rather than machinery.
 *
 * What it adds is the extra burden an external claim has to carry, because
 * "page 3 of a document in my own data room" is not a citation anybody else can
 * follow:
 *
 *   · a named publisher and title
 *   · a publication date
 *   · a locator — the page, table or section
 *   · a verbatim quote, so the figure can be checked without re-reading the
 *     whole report
 *   · a reachable reference: a URL, or a document in the room
 *   · an age, checked against what kind of claim it is
 *
 * A claim missing any of those does not get a caveat. It does not get rendered.
 */

export class EvidenceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Where a document came from. Decides which rules apply to figures read out of it. */
export const PROVENANCE_CLASSES = Object.freeze(['INTERNAL', 'EXTERNAL']);

/**
 * Kinds of external source, ordered roughly by how well a reader can check them.
 *
 * The ordering is not a quality judgement about the contents — it is about
 * verifiability. A regulatory filing can be looked up by anyone; a subscription
 * analyst report usually cannot, which is worth flagging to someone about to
 * rest an argument on it.
 */
export const SOURCE_KINDS = Object.freeze([
  { id: 'OFFICIAL_STATISTICS', label: 'Official statistics', checkable: 'PUBLIC' },
  { id: 'REGULATORY_FILING', label: 'Regulatory or company filing', checkable: 'PUBLIC' },
  { id: 'ACADEMIC', label: 'Peer-reviewed research', checkable: 'PUBLIC' },
  { id: 'INDUSTRY_BODY', label: 'Trade or industry body', checkable: 'PUBLIC' },
  { id: 'NEWS', label: 'News reporting', checkable: 'PUBLIC' },
  { id: 'ANALYST_REPORT', label: 'Analyst or market research report', checkable: 'RESTRICTED' },
  { id: 'COMPANY_DISCLOSURE', label: "Another company's own disclosure", checkable: 'PUBLIC' },
  { id: 'OTHER', label: 'Other', checkable: 'UNKNOWN' },
]);

const kindById = new Map(SOURCE_KINDS.map((k) => [k.id, k]));
export const sourceKind = (id) => kindById.get(id) ?? null;

/**
 * How long a claim stays usable, by what it is about.
 *
 * Market sizes and growth rates age quickly and a reader knows it: a 2019
 * market figure in a 2026 deck invites the question of why nothing newer was
 * found, which is a worse conversation than the figure itself. Historical
 * statements do not age at all — the year a regulation took effect is still the
 * year it took effect.
 */
export const CLAIM_CLASSES = Object.freeze([
  { id: 'MARKET_SIZE', label: 'Market size or share', maxMonths: 24 },
  { id: 'GROWTH_RATE', label: 'Growth or forecast rate', maxMonths: 24 },
  { id: 'PRICING_BENCHMARK', label: 'Pricing or cost benchmark', maxMonths: 18 },
  { id: 'REGULATORY', label: 'Regulatory position', maxMonths: 36 },
  { id: 'COMPETITOR', label: 'Named competitor fact', maxMonths: 24 },
  { id: 'HISTORICAL', label: 'Historical fact', maxMonths: null },
  { id: 'OTHER_EXTERNAL', label: 'Other external claim', maxMonths: 36 },
]);

const classById = new Map(CLAIM_CLASSES.map((c) => [c.id, c]));
export const claimClass = (id) => classById.get(id) ?? null;

export const MIN_QUOTE_CHARS = 20;

/**
 * Check a citation for completeness.
 *
 * Returns problems rather than throwing, so a user fixing three fields is told
 * about three. Every problem names the field and says what it is for — "add a
 * publisher" is an instruction, "nobody can check a figure attributed to
 * nothing" is a reason, and people fix reasons.
 */
export function citationProblems(citation = {}) {
  const problems = [];
  const need = (field, message) => {
    const v = citation[field];
    if (v === null || v === undefined || String(v).trim() === '') problems.push({ field, problem: message });
  };

  need('publisher', 'Name who published it. A figure attributed to nobody cannot be checked by anybody.');
  need('title', 'Give the title of the report, page or filing.');
  need('published_at', 'Give the publication date. Without it nobody can tell whether the figure is current.');
  need('locator', 'Say where in the source it is — page, table or section. '
    + '"It is in the report somewhere" is not a citation.');

  if (!sourceKind(citation.source_kind)) {
    problems.push({
      field: 'source_kind',
      problem: `Say what kind of source it is: ${SOURCE_KINDS.map((k) => k.id).join(', ')}.`,
    });
  }

  const quote = String(citation.quote ?? '').trim();
  if (quote.length < MIN_QUOTE_CHARS) {
    problems.push({
      field: 'quote',
      problem: 'Paste the sentence the figure comes from, verbatim. It is what lets a reader check the '
             + 'claim without re-reading the whole source, and it is what stops a figure drifting from '
             + 'what was actually said.',
    });
  }

  // Reachable one way or the other: a public URL, or a copy in the room.
  if (!String(citation.url ?? '').trim() && !String(citation.document_id ?? '').trim()) {
    problems.push({
      field: 'url',
      problem: 'Give a URL, or upload the source so it sits in your own room. A claim nobody can reach '
             + 'is a claim a counterparty will discount.',
    });
  }

  if (citation.url && !/^https?:\/\/\S+$/i.test(String(citation.url).trim())) {
    problems.push({ field: 'url', problem: 'The URL does not look like a web address.' });
  }

  if (citation.published_at && !Number.isFinite(Date.parse(citation.published_at))) {
    problems.push({ field: 'published_at', problem: 'The publication date cannot be read as a date.' });
  }

  // A URL without an access date is a dead link waiting to happen with no
  // record of when it was alive.
  if (citation.url && !citation.accessed_at) {
    problems.push({
      field: 'accessed_at',
      problem: 'Record when the page was read. Pages change and disappear, and the access date is what '
             + 'makes an archived copy findable later.',
    });
  }

  return problems;
}

/** Age of a citation, judged against what the claim is about. */
export function citationAge(citation = {}, asOf = new Date().toISOString()) {
  const published = Date.parse(citation.published_at);
  if (!Number.isFinite(published)) return { months: null, state: 'UNKNOWN', limit: null };

  const months = monthsBetween(published, Date.parse(asOf));
  const spec = claimClass(citation.claim_class) ?? claimClass('OTHER_EXTERNAL');
  const limit = spec.maxMonths;

  if (limit === null) return { months, state: 'TIMELESS', limit: null };
  if (months > limit) return { months, state: 'STALE', limit };
  if (months > limit * 0.75) return { months, state: 'AGEING', limit };
  return { months, state: 'CURRENT', limit };
}

function monthsBetween(a, b) {
  const from = new Date(a);
  const to = new Date(b);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + (to.getUTCMonth() - from.getUTCMonth())
    + (to.getUTCDate() < from.getUTCDate() ? -1 : 0);
}

/**
 * Can this external claim be rendered into a document?
 *
 * The gate, and it is deliberately hard to pass. Four conditions, each of which
 * exists because of what its absence would put in front of an investor.
 */
export function claimBlockers(claim = {}, asOf = new Date().toISOString()) {
  const blockers = [];

  // 1 — a human has checked it against the source.
  if (claim.fact?.source !== 'USER_CONFIRMED') {
    blockers.push({
      code: 'not_confirmed',
      problem: 'Nobody has confirmed this figure against the source yet. An external claim goes through '
             + 'the same confirmation as everything else — more so, because a reader can check this one.',
    });
  }

  // 2 — the source document is actually external.
  if (claim.provenance_class !== 'EXTERNAL') {
    blockers.push({
      code: 'not_external',
      problem: 'This figure is attributed to an external source but was read from an internal document. '
             + 'A market figure sourced to your own board pack is not a market figure.',
    });
  }

  // 3 — the citation is complete.
  const problems = citationProblems(claim.citation ?? {});
  if (problems.length) {
    blockers.push({
      code: 'incomplete_citation',
      problem: `The citation is missing ${problems.map((p) => p.field).join(', ')}.`,
      fields: problems,
    });
  }

  // 4 — it is still in date for what it claims.
  const age = citationAge(claim.citation ?? {}, asOf);
  if (age.state === 'STALE') {
    blockers.push({
      code: 'stale_citation',
      problem: `This source is ${age.months} months old and this kind of claim is treated as current for `
             + `${age.limit}. Find a newer source, or make the claim historical and say the year.`,
    });
  }

  return blockers;
}

/** Format a citation as a footnote. One shape, everywhere, so a deck reads consistently. */
export function renderCitation(citation = {}, { asOf = null } = {}) {
  const bits = [];
  if (citation.publisher) bits.push(String(citation.publisher));
  if (citation.title) bits.push(`*${citation.title}*`);
  if (citation.published_at) bits.push(formatYearMonth(citation.published_at));
  if (citation.locator) bits.push(String(citation.locator));
  if (citation.url) bits.push(String(citation.url));
  if (citation.accessed_at) bits.push(`accessed ${formatYearMonth(citation.accessed_at)}`);

  const age = asOf ? citationAge(citation, asOf) : null;
  const flag = age && age.state === 'AGEING'
    ? ' — approaching the age at which this kind of figure is usually refreshed'
    : '';

  return `${bits.join('. ')}${flag}`;
}

function formatYearMonth(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Summarise the evidence behind a document, for the appendix every artifact
 * carries.
 *
 * Restricted sources are flagged — not as a criticism, but because an argument
 * resting entirely on a report a reader cannot open is worth knowing about
 * before the meeting rather than during it.
 */
export function evidenceSummary(claims = [], asOf = new Date().toISOString()) {
  const usable = claims.filter((c) => claimBlockers(c, asOf).length === 0);
  const restricted = usable.filter((c) => sourceKind(c.citation?.source_kind)?.checkable === 'RESTRICTED');
  const ageing = usable.filter((c) => citationAge(c.citation ?? {}, asOf).state === 'AGEING');

  return {
    total: claims.length,
    usable: usable.length,
    blocked: claims.length - usable.length,
    restricted_sources: restricted.length,
    ageing_sources: ageing.length,
    note: restricted.length
      ? `${restricted.length} of these rest on sources a reader cannot open without a subscription. `
        + 'That is normal, and worth knowing before someone asks.'
      : null,
  };
}
