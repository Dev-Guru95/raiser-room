/**
 * The full export — what makes "never locked out" a fact rather than a promise.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT GATED BY ANYTHING
 *
 * There is no plan check in this file. No subscription state, no entitlement, no
 * "contact us to arrange an export". An organisation can take everything it has,
 * at any moment, including years after it stopped paying.
 *
 * That is deliberate and it is commercial as much as ethical. The data in here is
 * a company's diligence file: the thing they assembled over months, in the worst
 * weeks of their year, and the thing an acquirer will one day ask for. A product
 * that holds it hostage at the moment a subscription lapses converts a dormant
 * customer into a chargeback, a review, and a founder who tells other founders.
 * One that hands it over without being asked twice gets recommended.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES AN EXPORT ACTUALLY USEFUL
 *
 * A dump of table rows satisfies the letter of this and is nearly worthless: a
 * fact row says `source_doc_id: "a1b2…"` and the person opening it has no idea
 * which document that was. So the export RESOLVES its references — every fact
 * names the document and page it was confirmed from, every artifact lists the
 * facts it rests on by key.
 *
 * It is also complete by construction rather than by a maintained list. The set
 * of tables is read from the schema, so a table added in a future phase appears
 * in the export without anybody remembering to add it — and the test asserts
 * that, because "we forgot to export the new table" is exactly the failure that
 * would otherwise be discovered by a customer who had already left.
 */

import { authorise } from '../domain/access.js';
import * as usage from './usage.js';

const ok = (body, status = 200) => ({ status, body });

function audit(ctx, orgId, action, targetType, targetId, metadata) {
  ctx.db.insert('audit_log', {
    org_id: orgId, actor_id: ctx.auth.userId, action,
    target_type: targetType, target_id: targetId,
    metadata: metadata ? JSON.stringify(metadata) : null, created_at: ctx.now(),
  });
}

const membershipOf = (ctx, orgId) => ctx.db.findOne('membership', { org_id: orgId, user_id: ctx.auth.userId });

/**
 * Tables that belong to an organisation, read from the schema rather than listed.
 *
 * Anything with an `org_id` column is the organisation's and goes in the export.
 * Discovering them beats maintaining a list: the list is what gets forgotten when
 * a phase adds a table, and nobody notices until somebody's export is missing
 * the part they needed.
 */
export function exportableTables(db) {
  return db.tables()
    .filter((table) => db.columns(table).includes('org_id'))
    .sort();
}

/**
 * Tables held back, and why.
 *
 * Only ever for a reason that protects somebody, and each one is named in the
 * export itself rather than silently omitted — an export with a gap nobody
 * mentions is worse than one that says what is missing.
 */
const WITHHELD = Object.freeze({
  // Hashes of live access tokens. Exporting them hands over working keys to
  // whoever opens the file, and the recipient list is exported separately.
  share: 'token_hash',
});

/**
 * Everything the organisation holds.
 *
 * Returns structured data. Turning that into a zip or a set of CSVs is a
 * presentation concern and belongs at the HTTP layer, where streaming a large
 * file is somebody's actual job.
 */
export function exportEverything(ctx, orgId, options = {}) {
  return usage.around(ctx, orgId, 'EXPORT_TAKEN', () => doExportEverything(ctx, orgId, options));
}

function doExportEverything(ctx, orgId, { resolve = true } = {}) {
  // `read` and nothing else. A viewer can take a copy of what they can see,
  // which is the same thing they could do by hand with more clicks.
  authorise(membershipOf(ctx, orgId), 'read');

  const org = ctx.db.get('organisation', orgId);
  const tables = exportableTables(ctx.db);

  const data = {};
  const counts = {};
  for (const table of tables) {
    const rows = ctx.db.find(table, { org_id: orgId }).map((row) => redact(table, row));
    data[table] = rows;
    counts[table] = rows.length;
  }
  // `organisation` has no org_id of its own.
  data.organisation = [org];
  counts.organisation = org ? 1 : 0;

  const resolved = resolve ? resolveReferences(ctx, orgId, data) : null;

  audit(ctx, orgId, 'export.taken', 'organisation', orgId, {
    tables: Object.keys(counts).length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
  });

  return ok({
    organisation: { id: orgId, name: org?.name ?? null, path: org?.path ?? null },
    exported_at: ctx.now(),
    format_version: '1',
    tables: Object.keys(data).sort(),
    counts,
    data,
    ...(resolved ? { readable: resolved } : {}),
    withheld: Object.entries(WITHHELD).map(([table, field]) => ({
      table, field,
      why: 'Live access tokens. Exporting them would hand working keys to whoever opens this file; '
         + 'the links themselves and who they were sent to are included.',
    })),
    note: 'Everything this organisation holds. This export is not gated by a subscription, a plan or a '
        + 'state — it works the same the day you sign up and years after you stop paying.',
  });
}

function redact(table, row) {
  const field = WITHHELD[table];
  if (!field || !(field in row)) return row;
  return { ...row, [field]: null };
}

/**
 * The same data with its references resolved into words.
 *
 * This is the half that makes an export worth having. `source_doc_id: "a1b2…"`
 * tells the person opening the file nothing; "accounts.pdf, page 4" tells them
 * everything they needed it for.
 */
function resolveReferences(ctx, orgId, data) {
  const documents = new Map((data.document ?? []).map((d) => [d.id, d]));
  const facts = new Map((data.fact ?? []).map((f) => [f.id, f]));
  const members = new Map((data.membership ?? []).map((m) => [m.user_id, m]));

  const who = (userId) => members.get(userId)?.email ?? userId ?? null;

  return {
    facts: (data.fact ?? []).map((f) => ({
      key: f.fact_key,
      label: f.label,
      value: f.value_numeric ?? f.value_text ?? f.value_date ?? null,
      unit: f.unit,
      period: [f.period_start, f.period_end].filter(Boolean).join(' – ') || null,
      source: f.source,
      // The whole point of resolving.
      confirmed_from: f.source_doc_id
        ? `${documents.get(f.source_doc_id)?.filename ?? 'a document no longer held'}`
          + `${f.source_page ? `, page ${f.source_page}` : ''}`
        : null,
      superseded: Boolean(f.superseded_by),
      recorded_at: f.created_at,
    })),

    documents: (data.document ?? []).map((d) => ({
      filename: d.filename,
      kind: d.kind,
      provenance: d.provenance_class,
      uploaded_at: d.uploaded_at,
      // Said rather than implied: an export of records is not an export of files.
      file: 'Stored separately. Download the files themselves from the data room.',
    })),

    artifacts: (data.artifact ?? []).map((a) => ({
      kind: a.artifact_kind,
      title: a.title,
      state: a.state,
      generated_at: a.generated_at,
      generated_by: who(a.generated_by),
      rests_on: safeParse(a.fact_refs, []).map((id) => facts.get(id)?.fact_key ?? id),
    })),

    prose: (data.prose_block ?? []).filter((p) => !p.superseded_by).map((p) => ({
      slot: p.slot, body: p.body, source: p.source, author: who(p.author_id),
    })),

    shares: (data.share ?? []).map((s) => ({
      recipient: s.recipient_name ?? s.recipient_email ?? null,
      mode: s.mode, state: s.state, expires_at: s.expires_at,
      note: 'The token itself is not exported — see "withheld".',
    })),

    audit: (data.audit_log ?? []).map((a) => ({
      at: a.created_at, who: who(a.actor_id), did: a.action,
      to: `${a.target_type}:${a.target_id}`,
    })),
  };
}

const safeParse = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

/**
 * What an export would contain, without building it.
 *
 * For a UI that wants to say "4,812 rows across 18 tables" before somebody waits
 * for a download — and for anyone who wants to check the promise is real before
 * they need it to be.
 */
export function exportManifest(ctx, orgId) {
  authorise(membershipOf(ctx, orgId), 'read');
  const tables = exportableTables(ctx.db);
  const counts = Object.fromEntries(tables.map((t) => [t, ctx.db.count(t, { org_id: orgId })]));

  return ok({
    tables: [...tables, 'organisation'].sort(),
    counts: { ...counts, organisation: 1 },
    total_rows: Object.values(counts).reduce((a, b) => a + b, 0) + 1,
    gated_by: null,
    note: 'Available in every plan and every subscription state, including expired and cancelled.',
  });
}
