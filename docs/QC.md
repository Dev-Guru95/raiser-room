# Quality control — what I still owe, and how each item is proved

This is my checklist, not the dev team's. Theirs is `CHECKLIST.md`.

Each row says what has to be true, **how it is verified**, and whether it is
done. "Verified" means a command that fails loudly or a thing somebody looked
at — not an assurance.

---

## A. The handover package itself

| | What | How it is verified | Done |
|---|---|---|---|
| A1 | The zip extracts and `npm test` passes from a clean extraction | Extract to an empty directory, run it there | ✅ |
| A2 | Test count in `README.md` matches reality | `npm test` tail, compared to the number in the file | ✅ |
| A3 | Mutation count in `README.md` matches the catalogue | `test/mutations.test.js` asserts declared = parsed | ✅ |
| A4 | Every command quoted in `README.md` actually runs | Each one executed from the extracted zip | ✅ |
| A5 | Every file path in `README.md` exists | Checked against the tree | ✅ |
| A6 | No secret, token or key is in the zip | Grep the tree; `.env` excluded, `.env.example` empty of values | ✅ |
| A7 | No customer or demonstration database in the zip | `var/` and `out/` excluded | ✅ |
| A8 | Time estimates are ranges with their assumptions stated | Stated in `README.md` under the summary table | ✅ |

## B. The product, before handover

| | What | How it is verified | Done |
|---|---|---|---|
| B1 | Every test passes | `npm test` → 858/858 | ✅ |
| B2 | Every mutation is caught across **every file changed in this phase** — 47 of 47, plus 1 declared equivalent by design | `node tools/mutate.mjs --file <each>` | ✅ |
| B2b | **All 264 in one run** | `node tools/mutate.mjs`, nothing else running | ⬜ **dev team, item 5.4** |
| B3 | Every page renders at both widths with no overflow | `node tools/proof-web.mjs` → "No problems found" | ✅ |
| B4 | Every page has been looked at, not just asserted on | Screenshots reviewed by eye | ✅ |
| B5 | A deployed instance answers from outside | `node tools/verify-demo.mjs` against a running server | ⬜ needs a deployment |
| B6 | The product boots from the production entry point | `node server.mjs` with production-shaped env; `/health` green | ✅ |
| B7 | Upload → store → confirm works end to end over HTTP | `test/web.test.js`, with real signing storage | ✅ |
| B8 | No raw SQL above the storage adapter | Grep for `db.raw` outside `src/db/` | ✅ |

### What B2 covered, and what B2b is for

Every file whose logic changed in this phase was mutation-tested file by file:
`domain/usage.js`, `api/usage.js`, `api/export.js`, `api/portfolio.js`,
`api/billing.js`, `domain/billing.js`, and the whole of `src/web/` — server,
security, auth, html, boot, wording, and the route files. **47 reachable
mutations, 47 caught, none survived.** One more — a font-path traversal in
`server.js` — is declared equivalent by design and excluded from the
denominator, with its reasoning written into the mutation itself.

**B2b, the full 264-mutation run, is genuinely outstanding.** Three attempts to
run it unattended were killed by the environment, each leaving a mutation applied
in the working tree; the harness's journal recovered it every time, and the tree
was verified at 858/858 after each. It needs 2–3 hours of exclusive access to the
repository, which is why it belongs where it now sits — the dev team's QA gate at
`CHECKLIST.md` 5.4, before launch.

**The residual risk, stated plainly.** The harness had a reporting fault that was
found and fixed during this work: the catalogue-anchor test failed under *every*
mutation, so the harness counted it as one of the tests that caught each one.
Every mutation's score in any earlier full run was therefore inflated by one, and
a mutation reported as "caught by 1 test" may in fact have been caught by none.
That fault is fixed, and the 47 above were measured after the fix. But it means
the last clean full-run result cannot be relied on for the other 217, and B2b is
the only thing that settles them.

## C. Claims made in writing

Every one of these is a sentence published to a customer. Each needs the code to
match it.

| | Claim | Where it is proved | Done |
|---|---|---|---|
| C1 | "No aggregate is ever computed across customers" | `test/portfolio.test.js`, `test/billing.test.js` | ✅ |
| C2 | "The software has no path that reads across organisations" | Same, plus `test/usage.test.js` on the counter shape | ✅ |
| C3 | "Usage data carries no figure from your accounts" | `test/usage.test.js` — asserts the stored columns | ✅ |
| C4 | "You may object and we will stop collecting for your account" | Built, owner-only, audited; `test/usage.test.js` | ✅ |
| C5 | "Usage data: 24 months, then deleted" | `test/usage.test.js`, boundary day asserted | ✅ |
| C6 | "The export is one click, on every plan" | `test/export.test.js` via `exportableTables` | ✅ |
| C7 | "An ended subscription is read-only, never locked" | `test/billing.test.js` | ✅ |
| C8 | "We do not record IP addresses against share-link views" | Schema has no such column | ✅ |
| C9 | "Nothing on a RaiseRoom page is fetched from a third party" | Fonts and CSS served by the app; CSP is `'self'` | ✅ |
| C10 | Privacy policy described page-view collection the product does not take | **Corrected** — the policy now says capabilities, not pages | ✅ |

C10 was a real conflict between a published document and the code. The rule on
this project is to stop and report rather than silently resolve, so: it was
reported, and the policy was narrowed to match what is built rather than the
build widened to match the policy.

## D. Still to deliver

| | What | Depends on | Estimate |
|---|---|---|---|
| D1 | **Full mutation run** (B2) | Nothing | 2–3 h |
| D2 | Whop product page: description, details, image briefs, FAQ | Nothing | 3–4 h |
| D3 | Landing page and funnel for `raiseroom.app` | Nothing | 6–8 h |
| D4 | `/subprocessors` page copy | The four vendor names | 1 h |
| D5 | Fill four placeholders in the privacy policy and addendum | The four vendor names | 30 min |
| D6 | Cancellation-screen sentence about read-only access | Nothing | 30 min |

D6 is the one product change the terms review recommended: the software keeps an
ended subscription readable and exportable, and nothing tells the customer that
at the moment they cancel — which is exactly when they are worried about it.

---

## How to hold me to this

Ask for the output, not the status:

* **B2** — the mutation run prints `N/N reachable mutations caught`. Ask for that
  line. Anything less than all of them, with the names of any that survived.
* **B3** — `proof-web.mjs` prints `No problems found` or lists the overflows.
* **A1** — extract the zip somewhere clean and run `npm test` yourself. It takes
  25 seconds and needs no install.

If any of those three does not produce what this file says it produces, the
handover is not finished, whatever else has been delivered.
