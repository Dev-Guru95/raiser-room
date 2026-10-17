/**
 * The readiness criteria catalogue — the content of the Before They Ask audit,
 * encoded as data rather than prose.
 *
 * KNOWLEDGE PROVENANCE
 * Every criterion carries `basis`: where the guidance comes from and when it was
 * last reviewed. The app never asserts what investors "require" — it states the
 * questions a company will be asked, which is defensible, and says who says so.
 *
 * To revise guidance, change the record and bump `reviewed`. Never encode
 * advice in a prompt: a prompt cannot be cited, dated or audited.
 */

export const KNOWLEDGE_SOURCE = Object.freeze({
  id: 'bta-v1',
  title: 'Before They Ask — The RaiseRoom Readiness Audit',
  publisher: 'TekAIDA Consulting LLC',
  version: '1.0',
  reviewed: '2026-10-12',
  reviewIntervalMonths: 6,
  jurisdiction: 'GENERAL',
  note: 'Operational preparation guidance. Not legal, financial, accounting or investment advice.',
});

/**
 * Weights reflect how much damage a weak score does to a live process — not how
 * much work the domain takes. A disorganised room is quick to fix. A financial
 * record that cannot be defended ends processes.
 *
 * The weights sum to 10, so a perfect score is 20 × 10 = 200.
 */
export const DOMAINS = Object.freeze([
  {
    n: 1, weight: 1.5, name: 'Corporate and cap table',
    question: 'Does this company legally exist in the shape you say it does, and will the shares actually be mine?',
    criteria: [
      { ref: '1.1', text: 'A fully diluted cap table exists, is current, and reconciles exactly to the statutory register and every instrument issued' },
      { ref: '1.2', text: 'Every financing instrument — equity, notes, SAFEs, warrants — is located, complete, signed, and modelled through a conversion waterfall' },
      { ref: '1.3', text: 'Every option or equity promise made to any person is documented and properly approved, with no undocumented commitments outstanding' },
      { ref: '1.4', text: 'Corporate records — constitutional documents, board minutes, resolutions, shareholder agreements and side letters — are complete and retrievable' },
    ],
  },
  {
    n: 2, weight: 2.0, name: 'The financial record',
    question: 'Are these numbers real, are they repeatable, and did this business produce them?',
    criteria: [
      { ref: '2.1', text: 'Monthly management accounts exist for at least twelve months, are produced within two weeks of month end, and reconcile to the statutory accounts' },
      { ref: '2.2', text: 'Revenue recognition is written down, consistently applied, and defensible under examination' },
      { ref: '2.3', text: 'A normalisation bridge exists — reported profit to underlying earnings — with every adjustment identified, quantified and evidenced by you' },
      { ref: '2.4', text: 'Forecast credibility is demonstrable: the last three forecasts are set against actuals, with variances explained' },
    ],
  },
  {
    n: 3, weight: 1.5, name: 'Commercial and customers',
    question: 'Where does the revenue come from, will it still be here next year, and does it depend on something fragile?',
    criteria: [
      { ref: '3.1', text: 'Revenue by customer is available for 24 months, with concentration quantified for top 1, 3 and 5 by revenue and gross profit, and the trend visible' },
      { ref: '3.2', text: 'Retention, churn and expansion are defined in writing, calculated consistently, and reproducible from source data' },
      { ref: '3.3', text: 'Every material customer contract is located and read, with term, notice, renewal and change-of-control provisions summarised' },
      { ref: '3.4', text: 'Unit economics are calculated from actual cost data rather than estimates, and the method is written down' },
    ],
  },
  {
    n: 4, weight: 1.0, name: 'Contracts and legal',
    question: 'What has this company committed to, what could come back, and does anything break on a change of ownership?',
    criteria: [
      { ref: '4.1', text: 'A contract register exists, listing every material agreement with counterparty, value, term, notice and renewal dates, and where the executed copy is' },
      { ref: '4.2', text: 'Change-of-control, exclusivity, minimum-commitment and guarantee provisions have been identified across the contract base and summarised in one place' },
      { ref: '4.3', text: 'All disputes, claims and settlements from the last three years are documented, including resolved ones, with current status' },
      { ref: '4.4', text: 'Licences, permits, insurance and property obligations are current, evidenced, and diarised for renewal' },
    ],
  },
  {
    n: 5, weight: 1.0, name: 'IP, technology and data',
    question: 'Do you actually own what you are selling, and is there anything in here that becomes my problem?',
    criteria: [
      { ref: '5.1', text: 'Signed IP assignments exist from every founder, employee and contractor who contributed to the product, with no known gaps' },
      { ref: '5.2', text: 'Trade marks, domains and registrations are held by the company rather than by individuals, and are current in the territories that matter' },
      { ref: '5.3', text: 'A dependency and open-source inventory exists, with licences identified and compatibility with your distribution model assessed' },
      { ref: '5.4', text: 'Access control, security posture and data-protection position are documented, with a current record of who can reach what' },
    ],
  },
  {
    n: 6, weight: 1.0, name: 'People and key-person risk',
    question: 'Does this company work without the people in this room, and will the ones who matter stay?',
    criteria: [
      { ref: '6.1', text: 'Every person working in the business has a current written agreement appropriate to how they actually work, with contractor arrangements reviewed for classification risk' },
      { ref: '6.2', text: 'Key-person dependencies are identified in writing, naming the specific knowledge, relationship or access each person uniquely holds' },
      { ref: '6.3', text: 'A functioning second layer exists: each critical function has someone other than the founder who can run it' },
      { ref: '6.4', text: 'Compensation is fully documented with no informal or verbal arrangements outstanding, and retention for key people has been considered' },
    ],
  },
  {
    n: 7, weight: 1.5, name: 'The story and the model',
    question: 'Does the narrative match the numbers, and do the numbers hold together when pulled?',
    criteria: [
      { ref: '7.1', text: 'Every figure in the deck traces to a source document, and the deck and the model agree on every shared number' },
      { ref: '7.2', text: 'The model is driver-based: growth emerges from stated assumptions about customers, pricing and retention rather than a hard-coded rate' },
      { ref: '7.3', text: 'Market sizing is built bottom-up from addressable customers and realistic pricing, with the top-down figure used only as a cross-check' },
      { ref: '7.4', text: 'The three assumptions the plan most depends on are stated explicitly, with what would have to be observed for each to be wrong' },
    ],
  },
  {
    n: 8, weight: 0.5, name: 'The room itself',
    question: 'How is this company actually run?',
    criteria: [
      { ref: '8.1', text: 'A numbered folder structure exists and is populated, with a consistent file-naming convention applied throughout' },
      { ref: '8.2', text: 'Every document in the room is current, with superseded versions removed and version control maintained' },
      { ref: '8.3', text: 'Access is staged by process stage and sensitivity, with a record of who has access and what they received' },
      { ref: '8.4', text: 'A question-and-answer log is maintained, so every answer given to any party is recorded and consistent' },
    ],
  },
]);

/** The 0–5 scale. Deliberately harsh at the bottom. */
export const SCALE = Object.freeze([
  { score: 0, means: 'Does not exist, or exists and is wrong' },
  { score: 1, means: 'Exists somewhere, in someone’s head or inbox. Could not be produced this week' },
  { score: 2, means: 'Exists and could be produced, but is incomplete, stale, or would need explaining' },
  { score: 3, means: 'Exists, current, complete. Would survive a first look without comment' },
  { score: 4, means: 'Exists, current, complete, and organised. Would survive a second look' },
  { score: 5, means: 'A counterparty would remark on it. Rare, and you should not expect many' },
]);

export const MAX_RAW_PER_DOMAIN = 20;   // 4 criteria × 5
export const MAX_WEIGHTED = 200;        // 20 × sum(weights) = 20 × 10

const byRef = new Map();
for (const d of DOMAINS) for (const c of d.criteria) byRef.set(c.ref, { ...c, domain: d.n });

export const criterionByRef = (ref) => byRef.get(ref) ?? null;
export const ALL_REFS = Object.freeze([...byRef.keys()]);
