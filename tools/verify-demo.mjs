/**
 * Check a running demonstration deployment, from outside it.
 *
 *   node tools/verify-demo.mjs http://localhost:8080
 *
 * WHY THIS IS NOT A TEST
 *
 * The test suite builds its own server in-process and knows where everything
 * is. This drives a deployment over HTTP with nothing but the sign-in form and
 * what the pages link to, which is what a reviewer has. It catches the class of
 * problem a test cannot see: storage pointed somewhere unwritable, a reverse
 * proxy stripping a cookie, an environment variable missing so the documents
 * are rows with nothing behind them.
 *
 * It exits non-zero on the first category of failure, so it can be the last step
 * of a deploy.
 *
 * It signs in with the demonstration account, so it is only meaningful against a
 * deployment booted with DEMO_SEED=1 — and it refuses to run against anything
 * whose seeded organisation is not marked illustrative, because this script
 * posts nothing and reads everything, and doing that to a real company's data
 * room would be wrong even from a tool.
 */

import { DEMO_EMAIL, DEMO_PASSWORD } from '../src/web/demo.js';

const base = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');

const problems = [];
const check = (ok, label, detail = '') => {
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  // eslint-disable-next-line no-console
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? `  (${detail})` : ''}`);
  return ok;
};

const signIn = await fetch(`${base}/sign-in`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
});
const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? '';
if (!check(signIn.status === 303 && Boolean(cookie), 'the demonstration account signs in',
  `status ${signIn.status}`)) {
  // eslint-disable-next-line no-console
  console.error('\nNothing else can be checked without a session. Was this booted with DEMO_SEED=1?');
  process.exit(1);
}

const get = (path, c = cookie) =>
  fetch(`${base}${path}`, { headers: c ? { cookie: c } : {}, redirect: 'manual' });

// The organisation, found the way a person finds it: from the list.
const home = await (await get('/')).text();
const org = home.match(/\/org\/([0-9a-f-]{36})/)?.[1];
if (!check(Boolean(org), 'an organisation is listed on the home page')) process.exit(1);

const overview = await (await get(`/org/${org}`)).text();
if (!check(overview.includes('Illustrative example.'),
  'the organisation is marked as an illustrative example',
  'this tool will not read a real company')) {
  process.exit(1);
}

// ── every page of the rail, and every page hanging off it ────────────────
const pages = ['', '/readiness', '/gaps', '/room', '/documents', '/facts', '/writing',
  '/artifacts', '/cadence', '/sharing', '/advisor', '/valuation', '/settings',
  '/conflicts', '/upkeep', '/questions', '/access', '/languages', '/plan', '/people',
  '/visibility', '/audit', '/transfer-sheet', '/sharing/updates', '/example'];

for (const path of pages) {
  const res = await get(`/org/${org}${path}`);
  const html = res.headers.get('content-type')?.includes('html') ? await res.text() : '';
  const bad = [];
  if (res.status !== 200) bad.push(`status ${res.status}`);
  for (const leak of ['undefined', '[object Object]', 'NaN']) {
    if (html.includes(leak)) bad.push(`renders "${leak}"`);
  }
  if (res.status === 200 && !html.includes('Illustrative example.')) bad.push('no notice');
  check(bad.length === 0, `page /org/…${path || ' (overview)'}`, bad.join('; '));
}

// ── every generated document has bytes behind it ─────────────────────────
const list = await (await get(`/org/${org}/artifacts`)).text();
const ids = [...new Set([...list.matchAll(/\/artifacts\/([0-9a-f-]{36})\b/g)].map((m) => m[1]))];
check(ids.length > 0, `${ids.length} generated documents are listed`);

for (const id of ids) {
  const view = await get(`/org/${org}/artifacts/${id}/view`);
  const doc = await view.text();
  const bad = [];
  if (view.status !== 200) bad.push(`status ${view.status}`);
  // A row recording a generated document, with nothing behind the key it names,
  // is the failure this whole script exists to catch: it looks right in the
  // list and fails the moment somebody opens it.
  if (!doc.includes('<html')) bad.push('no file behind it — check STORAGE_DIR');
  if (!(view.headers.get('content-security-policy') ?? '').startsWith('sandbox;')) {
    bad.push('not sandboxed');
  }
  check(bad.length === 0, `document ${id.slice(0, 8)} opens`, bad.join('; '));
}

// ── the export ───────────────────────────────────────────────────────────
const exported = await get(`/org/${org}/export`);
const body = await exported.text();
let parsed = null;
try { parsed = JSON.parse(body); } catch { /* reported next */ }
check(exported.status === 200 && parsed !== null, 'the export is valid JSON',
  `status ${exported.status}, ${body.length} bytes`);

// ── and the door is shut ─────────────────────────────────────────────────
const naked = await get(`/org/${org}/facts`, '');
check(naked.status === 303, 'a signed-out visitor is redirected to sign in',
  `status ${naked.status}`);

const headers = (await get('/sign-in')).headers;
check((headers.get('content-security-policy') ?? '').includes("default-src 'self'"),
  'the content-security policy is served');
check(headers.get('x-frame-options') === 'DENY', 'framing is refused');

// eslint-disable-next-line no-console
console.log(problems.length
  ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`
  : '\nThe deployment is serving the demonstration correctly.');
process.exit(problems.length ? 1 : 0);
