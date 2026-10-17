/**
 * The data room — structure, required contents, staging and hygiene.
 *
 * KNOWLEDGE PROVENANCE: same rule as criteria.js. What belongs in a room is
 * guidance, so it is a versioned record with a source and a date, never
 * something a model recalls.
 */

export const DATAROOM_SOURCE = Object.freeze({
  id: 'bta-dataroom-v1',
  title: 'Before They Ask — Domain 8, The room itself',
  publisher: 'TekAIDA Consulting LLC',
  version: '1.0',
  reviewed: '2026-10-12',
  reviewIntervalMonths: 6,
  note: 'What a counterparty commonly asks for. Not a legal or regulatory requirement.',
});

/**
 * Access is staged by how serious the counterparty is and how sensitive the
 * material is. Opening everything on first contact is the most common mistake
 * and the hardest to undo.
 */
export const STAGES = Object.freeze(['PRE_MEETING', 'QUALIFIED', 'TERM_SHEET', 'CONFIRMATORY']);
const STAGE_RANK = Object.freeze({ PRE_MEETING: 0, QUALIFIED: 1, TERM_SHEET: 2, CONFIRMATORY: 3 });

export const STAGE_MEANING = Object.freeze({
  PRE_MEETING: 'Before the first meeting. An overview only — no customer names, no contract detail, no cap table detail.',
  QUALIFIED: 'Once they have shown they are serious. Metrics, a model summary, use of funds, a high-level cap table.',
  TERM_SHEET: 'Term-sheet diligence. The full room, bar the most sensitive items.',
  CONFIRMATORY: 'Confirmatory diligence, on advice. Detailed legal documents and anything commercially sensitive.',
});

/** `path` is RAISE | SALE | UNDECIDED. BOTH means it applies either way. */
const BOTH = 'BOTH';

/**
 * The ten folders and what each is expected to contain.
 * `required: true` counts toward completeness. Everything else is a prompt.
 */
export const FOLDERS = Object.freeze([
  {
    key: '01', name: 'Executive overview', stage: 'PRE_MEETING',
    items: [
      { ref: '01.1', name: 'Company summary — one page', required: true, path: BOTH },
      { ref: '01.2', name: 'Current deck', required: true, path: BOTH },
      { ref: '01.3', name: 'Use of funds, at named-role granularity', required: true, path: 'RAISE' },
      { ref: '01.4', name: 'Anonymised teaser', required: true, path: 'SALE' },
      { ref: '01.5', name: 'Milestone plan', required: false, path: BOTH },
    ],
  },
  {
    key: '02', name: 'Corporate and governance', stage: 'QUALIFIED',
    items: [
      { ref: '02.1', name: 'Certificate of incorporation', required: true, path: BOTH },
      { ref: '02.2', name: 'Current constitutional documents', required: true, path: BOTH },
      { ref: '02.3', name: 'Board minutes and written resolutions', required: true, path: BOTH },
      { ref: '02.4', name: 'Shareholder agreements and side letters', required: true, path: BOTH },
      { ref: '02.5', name: 'Organisation chart', required: false, path: BOTH },
    ],
  },
  {
    key: '03', name: 'Cap table and financing', stage: 'QUALIFIED',
    items: [
      { ref: '03.1', name: 'Fully diluted cap table, reconciled to the register', required: true, path: BOTH },
      { ref: '03.2', name: 'Every financing instrument — equity, notes, SAFEs, warrants', required: true, path: BOTH },
      { ref: '03.3', name: 'Option scheme rules and every grant, with board approval', required: true, path: BOTH },
      { ref: '03.4', name: 'Conversion waterfall', required: true, path: 'RAISE' },
    ],
  },
  {
    key: '04', name: 'Financials and forecast', stage: 'QUALIFIED',
    items: [
      { ref: '04.1', name: 'Statutory accounts — three years or since incorporation', required: true, path: BOTH },
      { ref: '04.2', name: 'Monthly management accounts — 24 months', required: true, path: BOTH },
      { ref: '04.3', name: 'Reconciliation: management accounts to statutory accounts', required: true, path: BOTH },
      { ref: '04.4', name: 'Written revenue recognition policy', required: true, path: BOTH },
      { ref: '04.5', name: 'Normalisation bridge — reported profit to underlying earnings', required: true, path: 'SALE' },
      { ref: '04.6', name: 'Financial model, driver-based', required: true, path: BOTH },
      { ref: '04.7', name: 'Last three forecasts against actuals', required: true, path: BOTH },
      { ref: '04.8', name: 'Debt, facilities, guarantees and security', required: true, path: BOTH },
    ],
  },
  {
    key: '05', name: 'Metrics and traction', stage: 'QUALIFIED',
    items: [
      { ref: '05.1', name: 'Retention, churn and expansion — with written definitions', required: true, path: BOTH },
      { ref: '05.2', name: 'Unit economics from actual cost data', required: true, path: BOTH },
      { ref: '05.3', name: 'Cohort analysis', required: false, path: BOTH },
      { ref: '05.4', name: 'Pipeline with a stated conversion assumption', required: false, path: 'RAISE' },
    ],
  },
  {
    key: '06', name: 'Customers and market', stage: 'TERM_SHEET',
    items: [
      { ref: '06.1', name: 'Revenue by customer — 24 months', required: true, path: BOTH },
      { ref: '06.2', name: 'Concentration: top 1, 3 and 5 by revenue and gross profit', required: true, path: BOTH },
      { ref: '06.3', name: 'Material customer contracts', required: true, path: BOTH },
      { ref: '06.4', name: 'Change-of-control provisions across the contract base', required: true, path: 'SALE' },
      { ref: '06.5', name: 'Market sizing, built bottom-up', required: true, path: 'RAISE' },
    ],
  },
  {
    key: '07', name: 'Product, technology, IP and security', stage: 'TERM_SHEET',
    items: [
      { ref: '07.1', name: 'IP assignments from every founder, employee and contractor', required: true, path: BOTH },
      { ref: '07.2', name: 'Trade marks, domains and registrations held by the company', required: true, path: BOTH },
      { ref: '07.3', name: 'Dependency and open-source inventory with licences', required: true, path: BOTH },
      { ref: '07.4', name: 'Security posture and access control record', required: true, path: BOTH },
      { ref: '07.5', name: 'Data-protection position', required: true, path: BOTH },
      { ref: '07.6', name: 'Architecture overview and technical debt', required: false, path: BOTH },
    ],
  },
  {
    key: '08', name: 'Team and operations', stage: 'TERM_SHEET',
    items: [
      { ref: '08.1', name: 'Employment contracts and contractor agreements', required: true, path: BOTH },
      { ref: '08.2', name: 'Key-person dependency register', required: true, path: BOTH },
      { ref: '08.3', name: 'Compensation summary, including informal arrangements', required: true, path: BOTH },
      { ref: '08.4', name: 'Second-layer / succession note', required: true, path: 'SALE' },
      { ref: '08.5', name: 'Hiring plan', required: false, path: 'RAISE' },
    ],
  },
  {
    key: '09', name: 'Legal, contracts and compliance', stage: 'CONFIRMATORY',
    items: [
      { ref: '09.1', name: 'Contract register — every material agreement', required: true, path: BOTH },
      { ref: '09.2', name: 'Disputes, claims and settlements — last three years', required: true, path: BOTH },
      { ref: '09.3', name: 'Licences, permits and insurance', required: true, path: BOTH },
      { ref: '09.4', name: 'Property leases and obligations', required: false, path: BOTH },
    ],
  },
  {
    key: '10', name: 'Process and Q&A log', stage: 'CONFIRMATORY',
    items: [
      { ref: '10.1', name: 'Question and answer log', required: true, path: BOTH },
      { ref: '10.2', name: 'Access record — who has what, and when', required: true, path: BOTH },
    ],
  },
]);

/** Items that apply to a given path. */
export function itemsForPath(path) {
  const want = (p) => p === BOTH || p === path || (path === 'UNDECIDED' && p !== BOTH);
  return FOLDERS.flatMap((f) =>
    f.items.filter((i) => want(i.path)).map((i) => ({ ...i, folder: f.key, folder_name: f.name, stage: f.stage })));
}

/** What a counterparty at `stage` is entitled to see. */
export const visibleAtStage = (nodeStage, stage) => STAGE_RANK[nodeStage] <= STAGE_RANK[stage];

// ───────────────────────────────────────────────── file-naming convention ──

/**
 * `deck_final_v4_updated_NEW.pdf` tells the reader something you do not want
 * them to know. The convention is: folder ref, what it is, the period, a version.
 *
 *   04-02_Management-Accounts_2025-01_to_2025-12_v3.xlsx
 */
const SLOPPY = [
  { re: /\b(final|latest|new|updated?|current|copy|draft)\b/i, why: 'contains a word that goes stale the moment it is written' },
  { re: /\bv\d+\s*[-_ ]\s*(final|new|latest)\b/i, why: 'two version signals disagreeing with each other' },
  { re: /\(\s*\d+\s*\)/, why: 'an operating-system duplicate marker' },
  { re: /\s{2,}/, why: 'repeated spaces' },
  { re: /^[^A-Za-z0-9]/, why: 'starts with punctuation' },
];

export function checkFilename(filename, { folderKey = null } = {}) {
  const name = String(filename ?? '');
  const problems = [];

  for (const s of SLOPPY) if (s.re.test(name)) problems.push(s.why);
  if (folderKey && !name.startsWith(folderKey)) {
    problems.push(`does not begin with its folder reference (${folderKey})`);
  }
  if (!/_v\d+\./i.test(name)) problems.push('carries no version');
  if (/\s/.test(name)) problems.push('contains spaces, which break in some tools');

  return {
    ok: problems.length === 0,
    problems,
    suggestion: problems.length ? suggestName(name, folderKey) : null,
  };
}

function suggestName(name, folderKey) {
  const ext = (name.match(/\.[A-Za-z0-9]+$/) ?? [''])[0];
  let stem = name.slice(0, name.length - ext.length)
    .replace(/\b(final|latest|new|updated?|current|copy|draft)\b/gi, '')
    .replace(/\(\s*\d+\s*\)/g, '')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .split(' ').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('-');
  if (!stem) stem = 'Document';
  return `${folderKey ? `${folderKey}_` : ''}${stem}_v1${ext || '.pdf'}`;
}

// ──────────────────────────────────────────────────────── document hygiene ──

export const DEFAULT_STALE_DAYS = 180;

/**
 * Stale documents are the second most damaging thing in a room after a missing
 * one: the counterparty cannot tell which version is current, so they ask — and
 * now you are explaining your filing rather than your business.
 */
export function staleDocuments(documents, { asOf, staleDays = DEFAULT_STALE_DAYS } = {}) {
  const cutoff = new Date(new Date(asOf).getTime() - staleDays * 86_400_000).toISOString();
  return documents
    .filter((d) => d.uploaded_at && d.uploaded_at < cutoff)
    .map((d) => ({
      document_id: d.id, filename: d.filename, uploaded_at: d.uploaded_at,
      age_days: Math.floor((new Date(asOf) - new Date(d.uploaded_at)) / 86_400_000),
    }))
    .sort((a, b) => b.age_days - a.age_days);
}
