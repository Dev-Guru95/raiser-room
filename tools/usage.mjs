/**
 * The operational analytics report.
 *
 *   node --experimental-sqlite tools/usage.mjs [--days 30] [--from YYYY-MM-DD]
 *                                              [--to YYYY-MM-DD] [--json] [--prune]
 *
 * WHY THIS IS A COMMAND AND NOT A PAGE
 *
 * The product has no staff role. Adding a page for this would mean inventing
 * one, and an operator report sitting behind a brand-new authorisation rule is
 * one mistaken role check away from being a cross-organisation page a customer
 * can open — in a product whose central promise is that no such page exists.
 *
 * Out of band there is nothing to get wrong: whoever can reach the database can
 * run this, and whoever cannot, cannot. If a dashboard is wanted later it should
 * read this command's `--json`, on a host of its own, rather than be grafted
 * into the application.
 *
 * WHAT YOU CAN AND CANNOT ASK IT
 *
 * You can ask which capabilities are used, which are never touched, where the
 * product refuses people, where it fails them, and what is slow.
 *
 * You cannot ask which company did any of it. Not because the command declines
 * — because the stored rows carry no organisation. See src/domain/usage.js.
 */

import { openDatabase } from '../src/db/sqlite.js';
import * as usage from '../src/api/usage.js';
import { COHORTS } from '../src/domain/usage.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : argv[at + 1] ?? '';
};
const has = (name) => argv.includes(`--${name}`);

const file = flag('db') ?? process.env.DATABASE_FILE ?? 'var/raiseroom.db';
const db = openDatabase({ file });

if (has('prune')) {
  const { cutoff, deleted } = usage.prune(db, new Date().toISOString());
  process.stdout.write(`pruned ${deleted} bucket${deleted === 1 ? '' : 's'} dated before ${cutoff}\n`);
}

const report = usage.report(db, {
  from: flag('from') ?? undefined,
  to: flag('to') ?? undefined,
  days: Number(flag('days')) || 30,
});

if (has('json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  db.close();
  process.exit(0);
}

// ── plain text, because this gets read in a terminal and pasted into a note ──

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
const rule = (n = 92) => '─'.repeat(n);

const out = [];
out.push('');
out.push(`RaiseRoom — how it is being used, ${report.from} to ${report.to}`);
out.push(`${report.days_covered} day${report.days_covered === 1 ? '' : 's'} with any activity`);
out.push('');
out.push(report.scope);
out.push('');

// Used, most first. The order is the point: what people actually do, in order.
const used = report.capabilities.filter((c) => c.events > 0).sort((a, b) => b.events - a.events);

out.push(rule());
out.push(`${pad('Capability', 42)}${num('tried', 7)}${num('new orgs', 10)}${num('refused', 9)}${num('failed', 8)}${num('mean ms', 9)}${num('worst', 8)}`);
out.push(rule());
for (const c of used) {
  out.push(
    pad(c.label.slice(0, 41), 42)
    + num(c.events, 7)
    + num(c.first_time, 10)
    + num(c.outcomes.REFUSED || '·', 9)
    + num(c.outcomes.FAILED || '·', 8)
    + num(c.ms_mean ?? '·', 9)
    + num(c.ms_max || '·', 8),
  );
}
out.push(rule());
out.push('');

// By cohort. Narrow, because the only question it answers is which kind of
// account does which thing — and TRIAL is the column worth staring at.
out.push(`${pad('Capability', 42)}${COHORTS.map((c) => num(c.toLowerCase(), 11)).join('')}`);
out.push(rule(42 + COHORTS.length * 11));
for (const c of used) {
  out.push(pad(c.label.slice(0, 41), 42) + COHORTS.map((k) => num(c.cohorts[k] || '·', 11)).join(''));
}
out.push('');

// The list that decides what to build next, and the reason the report prints
// capabilities with nothing in them at all.
if (report.untouched.length) {
  out.push(`Never used in this window (${report.untouched.length}):`);
  for (const key of report.untouched) {
    const c = report.capabilities.find((x) => x.key === key);
    out.push(`  · ${c.label}`);
  }
  out.push('');
  out.push('A capability nobody uses is either not wanted, not findable, or not working.');
  out.push('Those are three different problems and this report cannot tell them apart —');
  out.push('it can only tell you which capabilities to go and ask somebody about.');
  out.push('');
}

if (report.failures.length) {
  out.push('Failing for somebody who has not written in:');
  for (const f of report.failures) out.push(`  · ${f.label} — ${f.failed}`);
  out.push('');
}

if (report.refusals.length) {
  out.push('Where the product said no:');
  for (const r of report.refusals) out.push(`  · ${r.label} — ${r.refused}`);
  out.push('');
  out.push('A refusal is a product decision, not a bug. Worth reading as a list of the');
  out.push('places people wanted something and were told they could not have it.');
  out.push('');
}

process.stdout.write(`${out.join('\n')}\n`);
db.close();
