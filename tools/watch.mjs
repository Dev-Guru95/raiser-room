/**
 * The four alerts the handover asks for, in one command.
 *
 *   node tools/watch.mjs --url https://raiseroom.app --data-dir /data
 *
 * Run it from cron every minute, or as the command behind an uptime check. It
 * exits 0 when everything is fine and 1 when something needs a person, so any
 * monitoring system that understands an exit code can use it without a plugin.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A COMMAND AND NOT A PAGE
 *
 * The same reason `tools/usage.mjs` is: a page inside the product needs an
 * authorisation rule, and an authorisation rule over operational data is a rule
 * to get wrong. A command runs where the operator already is, and there is
 * nothing to get wrong because there is nothing to authorise.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FOUR CONDITIONS, AND WHY EACH ONE IS WORTH WAKING SOMEBODY FOR
 *
 * 1. `/health` NON-200 TWICE IN A ROW. Twice, not once: a single failed probe
 *    during a deploy or a one-second network blip is not an outage, and an
 *    alert that fires on those gets muted — after which it is not an alert.
 *    "Twice in a row" needs memory between runs, which is what the state file
 *    is for.
 *
 * 2. `"state":"degraded"`. This is the one nobody would think to watch, and the
 *    reason it matters is in `src/web/health.js`: degraded means file storage is
 *    unusable while the database is fine. So the site is up, pages render,
 *    sign-in works — and every upload and every document generation is failing.
 *    A check that only watches for non-200 reports this deployment as healthy.
 *
 * 3. DISK ABOVE 80% of the `/data` volume. Both the database and every uploaded
 *    document live there. A full volume does not degrade gracefully: SQLite
 *    starts refusing writes, and the first thing a customer notices is that
 *    their work is not being saved.
 *
 * 4. LOGS SHIPPED SOMEWHERE SEARCHABLE. The one condition this command cannot
 *    check, because it is a property of your logging setup rather than of the
 *    deployment. It is reported as `unchecked` rather than passed, so a green
 *    run never implies it is done. An unhandled failure prints a reference that
 *    the error page also shows, so a customer quoting "Reference a1b2c3d4" can
 *    be matched to a stack trace — which is only true if the logs are somewhere
 *    you can search.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT PRINTS
 *
 * One JSON object per run on stdout, for a log shipper to pick up, and a human
 * summary on stderr so a person running it by hand can read it. That way the
 * same command serves a cron job and a worried operator at 2am.
 */

import { argv, stderr, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync, statfsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argFor = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const url = argFor('--url', 'http://127.0.0.1:8080').replace(/\/+$/, '');
const dataDir = argFor('--data-dir', '/data');
const diskThreshold = Number(argFor('--disk-threshold', '80'));
const statePath = argFor('--state', 'var/watch-state.json');
const timeoutMs = Number(argFor('--timeout', '10000'));

/**
 * What the last run saw.
 *
 * A missing or corrupt file is treated as "no history", never as a failure: a
 * monitoring command that cannot run because its own state file is malformed is
 * worse than one that has forgotten what happened a minute ago.
 */
function readState() {
  try {
    if (!existsSync(statePath)) return { consecutive_failures: 0 };
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return { consecutive_failures: Number(parsed?.consecutive_failures) || 0 };
  } catch {
    return { consecutive_failures: 0 };
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
  } catch (err) {
    // Not fatal, and said out loud: without it, "twice in a row" degrades to
    // "once", which is noisier rather than quieter.
    stderr.write(`warning: could not write ${statePath} (${err.code}) — `
      + 'consecutive-failure counting will not work\n');
  }
}

async function probeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* a non-JSON body is itself the finding */ }
    return { reachable: true, status: res.status, state: body?.state ?? null, checks: body?.checks ?? null };
  } catch (err) {
    return { reachable: false, status: 0, state: null, checks: null, why: err.name === 'AbortError' ? `no answer in ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function probeDisk() {
  if (!existsSync(dataDir)) {
    return { checked: false, why: `${dataDir} does not exist on this host` };
  }
  try {
    const fs = statfsSync(dataDir);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    if (!total) return { checked: false, why: 'the filesystem reported no size' };
    const usedPercent = Math.round(((total - free) / total) * 1000) / 10;
    return { checked: true, used_percent: usedPercent, free_bytes: free, total_bytes: total };
  } catch (err) {
    return { checked: false, why: err.message };
  }
}

const health = await probeHealth();
const disk = probeDisk();
const previous = readState();

const alerts = [];

// 1 and 2 — the endpoint.
const healthy = health.reachable && health.status === 200;
const consecutive = healthy ? 0 : previous.consecutive_failures + 1;

if (!healthy && consecutive >= 2) {
  alerts.push({
    code: 'health_down',
    says: `/health has answered ${health.reachable ? health.status : 'nothing'} `
      + `${consecutive} times in a row${health.why ? ` (${health.why})` : ''}`,
  });
}
if (healthy && health.state === 'degraded') {
  alerts.push({
    code: 'storage_degraded',
    says: 'the deployment reports "degraded": file storage is unusable, so uploads and document '
      + 'generation are failing while every page still renders and sign-in still works',
  });
}
if (healthy && health.state && health.state !== 'ok' && health.state !== 'degraded') {
  alerts.push({ code: 'state_unknown', says: `/health reports a state this tool does not know: ${health.state}` });
}

// 3 — the volume.
if (disk.checked && disk.used_percent > diskThreshold) {
  alerts.push({
    code: 'disk_high',
    says: `${dataDir} is ${disk.used_percent}% used, over the ${diskThreshold}% threshold. Both the `
      + 'database and every uploaded document live there, and a full volume means writes start failing',
  });
}

writeState({ consecutive_failures: consecutive });

const report = {
  at: new Date().toISOString(),
  url,
  ok: alerts.length === 0,
  health: {
    reachable: health.reachable,
    status: health.status,
    state: health.state,
    consecutive_failures: consecutive,
    failing_checks: (health.checks ?? []).filter((c) => !c.ok).map((c) => c.name),
  },
  disk,
  // Never reported as passing, because this command cannot see it.
  log_shipping: 'unchecked — a property of your logging setup, not of the deployment',
  alerts,
};

stdout.write(`${JSON.stringify(report)}\n`);

// ───────────────────────────────────────────────────────────────────────────
// WHY THIS SETS `exitCode` RATHER THAN CALLING `exit()`
//
// Calling `process.exit()` in the same tick as a finished `fetch` aborts the
// process on Windows with a libuv assertion — `UV_HANDLE_CLOSING`, exit code
// 127 — because a handle the HTTP client still owns is torn down underneath it.
//
// For this tool that is not cosmetic: the exit code IS the interface. A
// monitoring system reading 127 instead of 1 learns "the check itself is
// broken" when the truth was "the disk is full", and the alert it raises is
// about the wrong thing. Setting `exitCode` and letting the process end on its
// own reports the same answer and cannot crash on the way out.
if (alerts.length) {
  stderr.write(`\nRaiseRoom — ${alerts.length} alert${alerts.length === 1 ? '' : 's'} for ${url}\n\n`);
  for (const a of alerts) stderr.write(`  ✗ ${a.code}\n    ${a.says}\n\n`);
  process.exitCode = 1;
} else {
  stderr.write(`RaiseRoom — ${url} is ok`
    + `${disk.checked ? `, ${dataDir} ${disk.used_percent}% used` : `, ${dataDir} not checked (${disk.why})`}`
    + `${!healthy ? ` — one failed probe, not yet an alert (${consecutive}/2)` : ''}\n`);
}
