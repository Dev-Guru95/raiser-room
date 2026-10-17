/**
 * The mutation catalogue, checked against the source it anchors to.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST EXISTS
 *
 * `tools/mutate.mjs` breaks each load-bearing rule on purpose and checks the
 * suite notices. It finds a rule by an exact string — the `from` anchor — and
 * when the code around that string is refactored, the anchor stops matching.
 * The harness then reports the mutation as STALE and carries on.
 *
 * Which is correct, and was not enough. Three anchors had gone stale, and two
 * of them were hiding genuinely unprotected rules: when they were repaired, the
 * mutations survived. Both were crying-wolf guards in staleness propagation —
 * the kind of rule whose absence does not fail anything, it just quietly makes
 * every document look stale until people stop reading the signal.
 *
 * A stale anchor is therefore not a tidiness problem. It is a mutation that has
 * stopped running, in a file nobody opens except before a handover, and the
 * rule it was protecting can rot for months behind a green suite.
 *
 * So the anchors are checked by the suite, which runs on every change — rather
 * than by the harness, which runs before a handover.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'tools', 'mutate.mjs'), 'utf8');

/**
 * Pull `{ name, file, from }` out of the catalogue.
 *
 * Read from the text rather than imported, because importing `mutate.mjs` runs
 * it. The shape is uniform and enforced by the test below, so a regex is honest
 * here in a way it usually is not.
 */
/**
 * Each field matched on its own, then zipped by order.
 *
 * One regex spanning `name` through `from` has to allow comments between the
 * fields, because several entries explain themselves there — and a pattern
 * permissive enough to do that backtracks catastrophically over a 1,700-line
 * file. It did: the first attempt ran until it was killed.
 *
 * Three simple anchored patterns cannot. Zipping by order is sound because the
 * catalogue is uniform, and the count check below is what keeps it so: if the
 * three lists ever come out different lengths, that test fails rather than this
 * one quietly pairing the wrong name with the wrong anchor.
 */
const FIELD = {
  name: /^ {4}name: (['"`])((?:\\.|(?!\1)[^\n])*?)\1,$/gm,
  file: /^ {4}file: '([^']+)',$/gm,
  from: /^ {4}from: (['"`])((?:\\.|(?!\1)[\s\S])*?)\1,$/gm,
};

function catalogue() {
  const names = [...source.matchAll(FIELD.name)].map((m) => unescapeJs(m[2]));
  const files = [...source.matchAll(FIELD.file)].map((m) => m[1]);
  const froms = [...source.matchAll(FIELD.from)].map((m) => unescapeJs(m[2]));

  if (names.length !== files.length || names.length !== froms.length) {
    // Reported here rather than silently zipping short, because a short zip
    // would pair a name with another mutation's anchor and check the wrong
    // thing in both directions.
    return { mismatch: { names: names.length, files: files.length, froms: froms.length } };
  }
  return names.map((name, i) => ({ name, file: files[i], from: froms[i] }));
}

/**
 * The anchors are written as JS string literals; compare against real text.
 *
 * One pass, left to right. A chain of `.replace` calls gets this wrong on any
 * anchor containing a literal backslash: `\\n` in the file is a backslash
 * followed by `n`, and a rule replacing `\n` first consumes the second
 * backslash and turns it into a newline. The first version of this helper did
 * exactly that and reported a perfectly good anchor as stale — which, in a test
 * whose whole job is to find anchors that have stopped matching, is the one
 * mistake that makes it useless.
 */
const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0' };
function unescapeJs(literal) {
  let out = '';
  for (let i = 0; i < literal.length; i++) {
    if (literal[i] !== '\\') { out += literal[i]; continue; }
    const next = literal[++i];
    out += next in ESCAPES ? ESCAPES[next] : next;
  }
  return out;
}

/** The parsed catalogue, or a failure if the three field lists disagree. */
const entries = () => {
  const parsed = catalogue();
  assert.ok(Array.isArray(parsed),
    `the catalogue did not parse evenly: ${JSON.stringify(parsed.mismatch)} — one field is `
    + 'formatted differently from the others, and zipping them would check the wrong anchors');
  return parsed;
};

test('every mutation in the catalogue was parsed', () => {
  // The guard on the guard. If the catalogue's shape changes and these patterns
  // silently match fewer entries, every test below would pass by checking
  // nothing — which is the failure this whole file is about.
  const declared = (source.match(/^ {4}name: /gm) ?? []).length;
  const parsed = entries().length;
  assert.ok(parsed > 200, `only ${parsed} mutations parsed`);
  assert.equal(parsed, declared,
    `${declared} mutations are declared but ${parsed} parsed — the catalogue's shape has changed `
    + 'and this check has stopped seeing some of them');
});

test('every mutation names a file that exists', () => {
  for (const m of entries()) {
    assert.ok(existsSync(join(root, m.file)),
      `"${m.name}" points at ${m.file}, which is not there`);
  }
});

/**
 * Is a mutation in flight right now?
 *
 * The harness journals the file it is about to edit before editing it, and
 * removes the journal when it restores. So its presence means one source file is
 * deliberately not as the catalogue describes it.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * Without this check, the anchor test below fails under EVERY mutation — the
 * mutated line no longer matches its own anchor — and the harness therefore
 * counts it as one of the tests that caught the mutation. Every mutation's score
 * was inflated by one, and a mutation whose rule nothing actually protects
 * reported as "caught by 1 test". That is the crying-wolf pattern this codebase
 * keeps finding: a signal that fires every single time carries no information,
 * and here it was actively hiding unprotected rules behind a green harness.
 *
 * It was found by a mutation reported as caught by exactly one test, which was
 * this one.
 */
const mutationInFlight = () => existsSync(join(root, 'tools', '.mutate-inflight.json'));

test('every mutation anchor still matches its source, exactly once', (t) => {
  if (mutationInFlight()) {
    t.skip('a mutation is in flight, so one anchor is deliberately not matching');
    return;
  }

  const cache = new Map();
  const stale = [];
  const ambiguous = [];

  for (const m of entries()) {
    if (!cache.has(m.file)) cache.set(m.file, readFileSync(join(root, m.file), 'utf8'));
    const text = cache.get(m.file);

    const occurrences = text.split(m.from).length - 1;
    if (occurrences === 0) stale.push(`${m.file}: ${m.name}`);
    // More than one match means the mutation changes whichever comes first,
    // which may not be the rule it was written for.
    if (occurrences > 1) ambiguous.push(`${m.file}: ${m.name} (${occurrences} matches)`);
  }

  assert.deepEqual(stale, [],
    'these mutations no longer match their source, so they are not running — repair the anchor '
    + 'and check the mutation still gets caught, because a stale anchor can be hiding a rule '
    + 'nothing protects');
  assert.deepEqual(ambiguous, [],
    'these anchors match more than once, so the mutation may be breaking a different line from '
    + 'the one it names — widen the anchor until it is unique');
});

test('a mutation actually changes something', () => {
  // `from` and `to` identical, or `to` already present everywhere `from` is,
  // produces a mutation that cannot fail and therefore always "survives" or
  // always "is caught" depending on the tree. Either way it is noise.
  const re = /from: (['"`])((?:\\.|(?!\1)[\s\S])*?)\1,\s*to: (['"`])((?:\\.|(?!\3)[\s\S])*?)\3,/g;
  const noops = [];
  for (const m of source.matchAll(re)) {
    if (unescapeJs(m[2]) === unescapeJs(m[4])) noops.push(m[2].slice(0, 60));
  }
  assert.deepEqual(noops, [], 'these mutations replace a string with itself');
});
