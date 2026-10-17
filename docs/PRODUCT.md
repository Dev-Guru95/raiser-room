# RaiseRoom

**A canonical fact store with provenance, for companies preparing to raise $1m–$25m or to sell.**

Not a data room. A data room holds what you already have and has no opinion about whether it is sufficient. This holds *facts*, with a source on every one, and renders every document from them — so your deck and your model cannot disagree.

---

## Why this repository exists

Phase 0 was first built on a hosted AI app platform. It produced a good product surface, but the handlers lived as **database rows rather than files**: no version control, no code review, and no test runner. Four handlers shipped with the same bug; it was reported as one, because nothing could be verified.

This port exists so that claims about the code can be checked by running something.

```bash
npm test
```

No install step. No database server. No network. Node 22.5+ only.

```
811 tests, 811 passing
```

Every rule in here has also been broken on purpose to check the tests notice:

```bash
node tools/mutate.mjs                             # 258 mutations, all caught; two to three hours
node tools/mutate.mjs --file src/api/billing.js   # or a subset, in a minute
```

Run the full pass with nothing else going on. Two suites competing for the same
cores roughly triples the wall clock, and an interactive `npm test` during a run
reports failures from whichever mutation is applied at that moment — which looks
exactly like a broken tree.

**Phases complete: 0 (foundation), 1 (readiness assessment), 2 (data room and diligence tracker), 3 (extraction, conflicts and the Transfer Sheet), 4 (the advisor), 5 (artifact generation), 6 (the operating cadence), 7 (staleness propagation), 8 (live sharing), 9 (brand), 10 (the advisor acts), 11 (localisation), 12 (tiers, billing and portfolio) — plus the workbook onramp, the valuation-readiness pack, and a web application over all of it.**

To see it rather than read about it:

```bash
DEMO_SEED=1 STORAGE_SECRET=$(openssl rand -hex 32) \
  DATABASE_FILE=var/demo.db STORAGE_DIR=var/objects \
  node --experimental-sqlite src/web/boot.js
```

It prints an account to sign in as, a counterparty link that needs no account, and
the nine documents it generated. Every page of that organisation — and every page
of every document it produces — carries the illustrative-example notice.

The remaining plan is in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## What is here

```
db/schema.sql           Canonical schema. Portable SQL — SQLite and Postgres.
src/domain/access.js    Org isolation and role gates. Pure functions.
src/domain/facts.js     §3.1 — the AI never originates a number. Pure functions.
src/db/sqlite.js        Storage adapter for tests and local development.
src/api/service.js      The Phase 0 surface, framework-agnostic.
src/domain/criteria.js  The 8 domains and 32 criteria, with knowledge provenance.
src/domain/assessment.js Scoring, bands, and the three hard rules.
src/domain/gaps.js      Gap derivation, fix-order sequencing, owner capacity.
src/api/assessments.js  The Phase 1 surface.
src/domain/dataroom.js  Folder structure, checklists by path, naming, staleness.
src/api/dataroom.js     The Phase 2 surface.
src/api/onramp.js       Workbook redemption — the $147 credit and the seed data.
src/domain/extraction.js    Classification, extractability, the review state machine.
src/domain/conflicts.js     Contradiction detection. Citable rules, never opinions.
src/domain/transfer-sheet.js Field definitions and the deterministic reader.
src/domain/timing.js    Milestones, two clocks, and a claim that refuses to exist.
src/extract/interface.js    The extractor contract — and where the tested part stops.
src/extract/fake.js     A deterministic extractor, including its misbehaviours.
src/api/extraction.js   The Phase 3 surface.
src/api/timing.js       Milestone recording and the measured-claim gate.
tools/transfer_sheet.py Generates the free fillable PDF.
tools/read_transfer_sheet.py  Reads one back. No OCR, no model.
src/knowledge/corpus.js     The guidance itself. Versioned, attributed, in git.
src/knowledge/retrieve.js   Deterministic retrieval that reports why it returned each record.
src/domain/advisor.js   The answer contract, the validator, and the refusal boundary.
src/advisor/interface.js    The advisor contract — and where the tested part stops.
src/advisor/fake.js     A deterministic advisor, including every way a model gets this wrong.
src/api/advisor.js      The Phase 4 surface. `buildContext` is the part worth reading.
src/domain/artifacts.js The catalogue — 31 document kinds, declared as data.
src/domain/evidence.js  Citation rules for claims about the world outside the company.
src/domain/assets.js    Image resolution, judged at placement size.
src/render/theme.js     Tokens, palettes, and every number-formatting decision.
src/render/charts.js    Thirteen chart types. Pure functions returning SVG.
src/render/tables.js    Tables, to the rules a financial printer would apply.
src/render/blocks.js    Blocks, and the FactBinder that makes provenance automatic.
src/render/document.js  Print CSS, embedded fonts, page setup.
src/api/artifacts.js    The Phase 5 surface and the generation gate.
src/domain/cadence.js   Forecasts, variance, credibility. The locked-forecast rule.
src/api/cadence.js      The Phase 6 surface — lock, close, explain, repeat.
src/domain/freshness.js Graded staleness, supersession chains, freshness by kind.
src/api/freshness.js    The Phase 7 surface — what is still true, and what moved.
src/domain/sharing.js   Tokens, access decisions, watermarks, question consistency.
src/api/sharing.js      The Phase 8 surface. Owner and recipient paths, kept apart.
src/domain/brand.js     Colour maths, contrast floors, palette derivation.
src/api/brand.js        The Phase 9 surface — set, preview, reset, report.
src/domain/actions.js   The action catalogue. What the advisor may propose, and nothing else.
src/api/actions.js      The Phase 10 surface — propose, confirm, reject, undo.
src/api/prose.js        Prose into documents, under the same number rule as everything else.
src/domain/factkeys.js  Naming facts, grouping them, and reading a figure off a sentence.
src/api/factlib.js      The fact library and the repair path out of a refused sentence.
src/domain/locale.js    Supported locales, Intl formatting, what is never translated.
src/domain/translation.js  Masking references so a model never holds a figure.
src/api/localisation.js The Phase 11 surface — translate, approve, render.
src/i18n/strings.js     Every label a document prints, in five locales, written by hand.
src/domain/billing.js   Plans, entitlements, and what expiry does and does not take away.
src/api/billing.js      The Phase 12 surface — status, checkout, webhooks, the credit.
src/api/export.js       Everything the organisation holds. Never gated, by anything.
src/api/portfolio.js    Consent-based, revocable, and with no aggregate of any kind.
src/domain/valuation.js The five evidence areas, and the arithmetic it will not call a valuation.
src/api/valuation.js    The valuation-readiness surface. Asserts nothing about what a company is worth.
src/domain/illustrative.js  One copy of the illustrative-example notice, and the marker fact.
src/web/security.js     scrypt, session cookies, CSRF, lockout, the response headers.
src/web/auth.js         Register, sign in, sessions, password change. No account enumeration.
src/web/html.js         The design system. `figure()` is the component everything is built around.
src/web/server.js       Zero-dependency node:http. Routing, bodies, assets, signed objects.
src/web/boot.js         The deployment entry point, and the checks that refuse to start.
src/web/demo.js         The demonstration deployment, and what it refuses to run against.
src/web/advisor.js      Which advisor is wired, and what the page says when none is.
src/web/translator.js   The same, for translation.
src/web/payments.js     The same, for billing — where a plausible stub does real damage.
src/web/wording.js      What a refusal says to a person, and which sentence wins.
src/web/routes/         Thirteen route files. No authorisation decision in any of them.
tools/render.mjs        HTML to PDF, via headless Chromium.
tools/proof-charts.mjs  Every chart on one sheet, to be looked at.
tools/inkcheck.mjs      Rasterises output and checks the ink actually landed.
tools/worked-example.mjs  A full set of artifacts, generated end to end.
tools/proof-brand.mjs   One deck under four brands, plus the palettes in greyscale.
tools/mutate.mjs        Breaks each rule on purpose and reports what caught it.
test/                   The suite. Run it before believing anything below.
```

**Every rule that matters is a pure function with a test.** That is deliberate: all four bugs in the previous implementation were authorisation or provenance rules buried inside HTTP handlers, where they could not be reached by a test.

The service layer takes `(ctx, input)` and returns `{ status, body }` — no `Request`, no `Response`, no framework import. Mounting it on Next.js, Hono or anything else is a thin adapter, and the rules do not move when the framework does.

---

## The invariants, and where they are proved

| Invariant | Enforced in | Proved by |
|---|---|---|
| The AI never originates a number | `domain/facts.js` — closed, frozen enum with no `AI_GENERATED` | `facts.test.js` |
| Facts are immutable; corrections supersede | `service.js: supersedeFact` | `facts.test.js` |
| `CALCULATED` carries its formula and inputs | `domain/facts.js` | `facts.test.js` |
| Confirmation is stamped server-side | `domain/facts.js: confirmationStamp` | `facts.test.js` |
| A non-member gets 404, never 403 | `domain/access.js: authorise` | `access.test.js` |
| Rows fetched by id are re-checked against the org | `domain/access.js: assertBelongsToOrg` | `access.test.js` |
| VIEWER cannot mutate | `domain/access.js` | `access.test.js` |
| The last OWNER cannot be removed or demoted | `domain/access.js: assertNotLastOwner` | `access.test.js` |
| Bytes never pass through the server | `service.js` — presigned URLs only | `documents.test.js` |
| Every mutation writes an audit row | `service.js: audit` | `documents.test.js` |
| No column name is a SQL reserved word | `db/schema.sql` | `reserved-words.test.js` |
| One domain below 8/20 caps the band | `domain/assessment.js` | `assessment.test.js` |
| Criterion 1.1 at ≤2 issues no band at all | `domain/assessment.js` | `assessment.test.js` |
| Domain 2 below 10/20 caps the band | `domain/assessment.js` | `assessment.test.js` |
| Gaps are returned in fix order, not score order | `domain/gaps.js` | `assessment.test.js` |
| No owner holds more than three open gaps | `domain/gaps.js` | `assessment.test.js` |
| Guidance is served with a source and a date | `domain/criteria.js` | `assessment.test.js` |
| The checklist differs by raise vs sale | `domain/dataroom.js` | `dataroom.test.js` |
| "Not applicable" requires a written reason | `api/dataroom.js` | `dataroom.test.js` |
| Staging controls what a counterparty sees | `domain/dataroom.js` | `dataroom.test.js` |
| Imported workbook facts are USER_ENTERED only | `api/onramp.js` | `dataroom.test.js` |
| One credit per receipt, one per organisation | `api/onramp.js` | `dataroom.test.js` |
| No fact is written with source DOCUMENT_EXTRACTED | `api/extraction.js` | `extraction.test.js` |
| Confidence gates nothing — there is no auto-confirm | `domain/extraction.js` | `extraction.test.js` |
| Bulk confirm refuses figures nobody has been shown | `domain/extraction.js: assertBulkConfirmable` | `extraction.test.js` |
| A candidate must carry the text it was read from | `domain/extraction.js` | `extraction.test.js` |
| A scan is declared unreadable, not guessed at | `domain/extraction.js: extractabilityOf` | `extraction.test.js` |
| Confirming keeps the document and page | `domain/facts.js` | `facts.test.js` |
| An unconfirmed extraction may not be relied on | `domain/facts.js: isUsable` | `facts.test.js` |
| Rounding is not reported as a contradiction | `domain/conflicts.js: withinTolerance` | `conflicts.test.js` |
| A resolution needs a choice and a written reason | `domain/conflicts.js` | `conflicts.test.js` |
| An unresolved HIGH conflict blocks generation | `domain/conflicts.js` | `conflicts.test.js` |
| An ambiguous form answer is refused, never interpreted | `domain/transfer-sheet.js` | `transfer-sheet.test.js` |
| A blank box means unanswered, never zero | `domain/transfer-sheet.js` | `transfer-sheet.test.js` |
| No timing figure below a measured sample of 20 | `domain/timing.js: cohortClaim` | `timing.test.js` |
| The two clocks are never averaged together | `domain/timing.js` | `timing.test.js` |
| Every advisor claim cites something | `domain/advisor.js: validateDraft` | `advisor.test.js` |
| Every citation resolves to the supplied context | `domain/advisor.js` | `advisor.test.js` |
| Every numeral traces to a fact, figure or cited record | `domain/advisor.js: unaccountedNumerals` | `advisor.test.js` |
| An unverifiable answer is withheld, not captioned | `api/advisor.js` | `advisor.test.js` |
| Valuations and readiness verdicts are refused | `domain/advisor.js: REFUSALS` | `advisor.test.js` |
| Introductions are permanently out of scope | `domain/advisor.js` | `advisor.test.js` |
| No cross-organisation data, aggregated or otherwise | `api/advisor.js: buildContext` | `advisor.test.js` |
| Retrieval returns nothing it cannot explain | `knowledge/retrieve.js` | `knowledge.test.js` |
| An uncovered question gets no answer, not an unsourced one | `api/advisor.js` | `advisor.test.js` |
| A stale record is disclosed, never quietly cited | `domain/advisor.js` | `advisor.test.js` |
| No record speaks for investors or cites a statistic | `knowledge/corpus.js` | `knowledge.test.js` |
| No figure is typed into an artifact; all are references | `render/blocks.js: FactBinder` | `artifacts.test.js` |
| A missing required fact blocks, never placeholders | `domain/artifacts.js` | `artifacts.test.js` |
| An unresolved contradiction blocks every artifact | `domain/artifacts.js` | `artifacts.test.js` |
| An external claim needs a complete, in-date citation | `domain/evidence.js` | `artifacts.test.js` |
| An image below the print floor blocks generation | `domain/assets.js` | `artifacts.test.js` |
| An absent value is a dash, never a zero | `render/tables.js`, `render/charts.js` | `artifacts.test.js` |
| One figure precision per chart and per column | `render/theme.js` | `artifacts.test.js` |
| The palette survives a black-and-white printer | `render/theme.js` | `artifacts.test.js` |
| The same facts render byte-identical output | `api/artifacts.js` | `artifacts.test.js` |
| A locked forecast can never be edited | `domain/cadence.js: assertMutable` | `cadence.test.js` |
| Actuals never re-baseline a forecast | `api/cadence.js` | `cadence.test.js` |
| A superseded forecast stays on the record | `api/cadence.js: closePeriod` | `cadence.test.js` |
| A revision states why | `api/cadence.js: reviseForecast` | `cadence.test.js` |
| Variance is measured against the plan, not the outcome | `domain/cadence.js: materialityOf` | `cadence.test.js` |
| An open period is awaiting, never a total miss | `domain/cadence.js` | `cadence.test.js` |
| Credibility needs three measured cycles, all explained | `domain/cadence.js: credibility` | `cadence.test.js` |
| Runway is never extrapolated | `domain/cadence.js: runwayInput` | `cadence.test.js` |
| Staleness is graded, not binary | `domain/freshness.js: severityOf` | `freshness.test.js` |
| Only a released document with a wrong figure is urgent | `domain/freshness.js` | `freshness.test.js` |
| New material is judged against the artifact's own keys | `api/freshness.js` | `freshness.test.js` |
| A supersession cycle is reported, not followed | `domain/freshness.js: resolveChain` | `freshness.test.js` |
| A constitution does not age on a clock | `domain/freshness.js: FRESHNESS_POLICY` | `freshness.test.js` |
| Regeneration supersedes; it never overwrites what was sent | `api/freshness.js: regenerate` | `freshness.test.js` |
| `stale_since` records when it broke, not when you looked | `api/freshness.js` | `freshness.test.js` |
| The raw share token is never stored | `domain/sharing.js: mintToken` | `sharing.test.js` |
| An unknown token reveals nothing at all | `domain/sharing.js: accessDecision` | `sharing.test.js` |
| Revocation and expiry take effect immediately | `domain/sharing.js` | `sharing.test.js` |
| Every link has an expiry, capped at a year | `domain/sharing.js: resolveExpiry` | `sharing.test.js` |
| A pinned document never moves under its reader | `api/sharing.js: openShare` | `sharing.test.js` |
| A room link shows only the recipient's stage | `api/sharing.js` | `sharing.test.js` |
| A missing room item is never listed to a counterparty | `api/sharing.js` | `sharing.test.js` |
| The recipient path never consults membership | `api/sharing.js` | `sharing.test.js` |
| No IP address is recorded | `db/schema.sql`, `api/sharing.js` | `sharing.test.js` |
| A contradictory answer is flagged against what was said before | `domain/sharing.js` | `sharing.test.js` |

### The reserved-words test earns its place

A column named `index` shipped in the first build and broke organisation setup completely on Cloudflare D1:

```
D1_ERROR: near "index": syntax error at offset 52
```

It was invisible on Postgres, because Prisma quotes identifiers automatically. The test now **asks SQLite directly** which keywords break as bare column names, rather than checking against a hand-maintained list — a list produced a false positive on `action`, which is a keyword but a perfectly legal identifier, and a test that cries wolf gets ignored.

Reintroduce that column and 34 of the 37 tests fail. That has been verified by doing it.

---

## Three bugs from the first implementation, fixed and pinned

Each has a test named `REGRESSION:` so it cannot come back quietly.

**1 · Stale provenance on correction.** Superseding a `CALCULATED` fact with a hand-entered one carried the old `formula` and `input_fact_ids` forward, leaving a figure that claimed to be derived from a calculation it had nothing to do with. The same applied to `source_doc_id` on an extracted fact. Provenance that lies is worse than no provenance.

**2 · Abandoned uploads looked like documents.** The register row was created at ticket-issue time in state `PENDING`, so a client that never completed the PUT left a row that looked real and pointed at an object which never arrived. Rows now begin `AWAITING_UPLOAD` and only become documents when the upload is confirmed. A download cannot be issued before then.

**3 · The write that was treated as a read.** Listing a user's organisations also *claims any pending invite*, which is a write. In the previous implementation it was treated as read-only and missed the fix every other write received — so a second user clicking an invitation failed on their very first request. It is covered here, including the double-claim and deleted-organisation cases.

---

## Knowledge provenance — why there is no "expert AI"

The obvious way to build this is to put fundraising expertise into a prompt. That is the wrong design, for three reasons.

**It rots silently.** A model has a training cutoff. Prompt text encoding what investors expect in 2026 is wrong by 2027, and nothing tells you.

**It is not defensible.** Any competitor can prompt a model with fundraising advice. The moat here is the fact store, where contradiction is structurally impossible.

**It breaks the product's own rule.** The app refuses to let the AI originate a number. It must equally refuse to let it originate *guidance* with nothing behind it.

So guidance lives in `src/domain/criteria.js` as a versioned, citable record — `KNOWLEDGE_SOURCE` carries a publisher, a version, a review date and a review interval. The AI retrieves and cites; it never recalls. Change a record and every place it is used changes with it, and a user can always see where a judgement came from and when it was last checked.

**Advice with provenance is the USP.** No incumbent has it, and an accelerator can audit what its companies are being told.

---

## The workbook onramp

A reader of *Before They Ask* has already done four sessions of real work. None of it should be retyped.

`redeemWorkbook()` turns a completed workbook into a scored assessment, a populated gap register in fix order, and confirmed facts — the normalisation bridge, customer concentration with its two-year trend, key-person dependencies, the three load-bearing assumptions. It also records a **$147 credit, labelled as a credit and never expressed as a percentage**: the user should see what they already paid for, not a discount they were given.

Two rules worth knowing:

**Imported facts are `USER_ENTERED`, never `USER_CONFIRMED`.** The user wrote them in a workbook and transcribed them here. Nothing was parsed and nothing has been verified against a source document. Marking them confirmed would give them a confidence they have not earned — and a test fails if anyone changes it.

**One redemption per receipt, and one per organisation.** A credit that can be claimed twice will be.

---

## Phase 3 — and exactly how far its guarantees go

Phase 3 reads documents. That makes it the first phase where part of the system
is a language model, and the guarantees therefore stop somewhere specific. This
section says where, so nobody has to find out by assuming.

### The design, in one decision

Extraction output is **not written to the fact store**. It goes to
`extraction_candidate`, which is a different table, and nothing moves across
without a named human, at a recorded time, with the source in front of them. A
test asserts that no code path writes a `fact` row with source
`DOCUMENT_EXTRACTED` — so "the AI never originates a number" survives contact
with a feature whose whole job is reading numbers out of documents.

Three consequences worth knowing:

**Confidence gates nothing.** The extractor's confidence is stored and shown so
a reviewer can sort by it. There is no threshold above which review is skipped,
and a mutation that introduced one is caught.

**Bulk confirm exists, and is guarded.** Clicking through forty line items of a
management account one at a time is a worse outcome — people stop reading at
item six. So bulk confirm is allowed, but only over candidates the server has
actually served to a client; `viewed_at` is stamped server-side, so it is a
record rather than a promise made by the UI.

**A correction keeps both figures.** Confirming with an edit stores the
reviewer's value as the fact and leaves the extractor's value on the candidate
row, with both in the audit entry. What the machine said and what the human
corrected it to are permanently on the record.

### Conflict detection

The commercial argument for the subscription is that it finds the contradiction
before a counterparty does — the deck saying ARR $4.2m while the accounts say
$3.8m, or 140% retention claimed against 118% assumed in the model.

Both sides are always shown, with where each came from, down to the page or the
cell reference. **The product never picks a winner**: that would mean asserting
which of the company's own records is correct, which it has no basis to do.
Resolution is a human act, requires a written reason, and does not change either
figure — "we decided the accounts were right" and "we changed the deck" are
different things.

The rules are data, with a `basis` on each one, for the same reason the
readiness criteria are. They are confined to relations that are arithmetically
or definitionally necessary: the top 3 customers cannot be a smaller share than
the top 1; a stated gross margin should follow from the revenue and cost stated.
There is deliberately no rule encoding an opinion about what a good business
looks like.

The hard part is not finding contradictions — it is not crying wolf. $4,200,000
against $4,199,614 is one number presented two ways, and a product that flags it
trains people to ignore the list, which is how a real contradiction gets missed.
Tolerances are per unit, and percentages are tested both relatively and
absolutely, because neither works alone: 118% against 118.4% is rounding, while
churn of 1.0% against 1.4% is the same 0.4 of a point and a 40% difference in
the thing being measured.

### The Transfer Sheet

A free, fillable PDF that carries a completed *Before They Ask* workbook into
the app without retyping. `tools/transfer_sheet.py` generates it;
`tools/read_transfer_sheet.py` reads one back.

**Reading an AcroForm field is not extraction.** The value in the file is the
string the user typed, so the read is lossless and identical every time — no
model, no inference, no confidence score. That is why imported figures are
`USER_ENTERED`: the author of the value is the user.

**A printed, handwritten, scanned sheet is deliberately not read.** It is stored
as a reference document. Handwriting recognition is least reliable on digits and
decimal points, which is what this sheet is made of; a concentration figure
mangled from 68 to 6.8 would enter the fact store wearing a clean provenance
label, and the first anyone would know is in a meeting.

The field definitions live in `src/domain/transfer-sheet.js` and nowhere else.
`tools/dump-fields.mjs` exports them for the Python generator, and the onramp's
worksheet mapping is derived from the same table — it used to be a second copy,
and a divergence between the two would not have failed, it would have filed one
figure under another figure's key. `test/transfer-sheet-fixture.json` is
captured from a real generated-then-filled PDF rather than written by hand, so a
field renamed in one place and not the other fails a test instead of failing a
customer.

### Timing instrumentation, and the claim that does not exist yet

The honest answer to "how long does this take?" is that nobody has measured it.
The temptation is to answer anyway — *investor-ready in 7 days* — and that
number would be invented, and would be the first thing a customer tests.

So there is an instrument instead of a claim. Milestones are recorded as a side
effect of work that happens anyway. `cohortClaim()` **returns no figure at all**
until twenty organisations have completed the interval, and when it does, the
claim arrives with its sample size inside its own wording.

Two clocks, never mixed. **Clock A** is work: scoring, building the room,
reviewing extractions, closing gaps within the company's own control. **Clock B**
is calendar time — an IP assignment chased from a contractor who left two years
ago, a landlord's consent, an accountant's restatement. Averaging them produces
a figure true of nothing that overpromises on the half the customer controls,
so `assertSingleClock` refuses a mixed sample rather than quietly averaging it.

There is no benchmarking feature. A tenant asking for cohort figures gets a 404.

### What Phase 3 does NOT guarantee

Stated here rather than left to be inferred from the other phases' guarantees.

**Extraction accuracy is unmeasured.** The rules are tested exhaustively: that
malformed output cannot corrupt the fact store, that nothing is auto-confirmed,
that conflicts surface, that an unreadable file is declared unreadable. Whether
a real extractor finds the right number on page 14 of a real pitch deck is a
different question, and answering it needs a labelled corpus and a measured
accuracy figure. Neither exists. **Do not put an accuracy figure on a sales
page.** The claim this phase supports is that nothing a machine read reaches
your records without you — which is true, and testable, and better.

**The extractor itself is not written.** `src/extract/fake.js` is a
deterministic stand-in. The real one implements `src/extract/interface.js`,
which sets out what it may not do.

**Conflict detection finds what its rules describe.** Same-key disagreements,
unit mismatches, period clashes, and four cross-key rules. It is not a general
reasoner over a company's figures and should not be described as one.

---

## Phase 4 — the advisor, and why it refuses things

This is the phase where part of the product is a language model giving advice.
The temptation is obvious and the shortcut is well worn: put fundraising
expertise in a system prompt and let the model talk. This does not do that, and
the reasons are the whole design.

### The decision that makes it work

**The advisor does not write prose that is then checked.** It returns structured
claims, each carrying the references it rests on, and the prose is rendered from
that structure afterwards.

The difference is everything. Generate prose and check it afterwards and you are
running pattern matching over natural language, hoping to spot the one uncited
sentence — and if you miss it, it ships looking exactly like the others. Require
`{ text, cites }` and an uncited claim is not something to detect. It is
something that cannot be expressed.

Same move as the fact store, one layer up: make the bad state unrepresentable
rather than detectable.

### Four rules a draft must survive

1. **Every claim cites something.** No general-knowledge exemption, and no claim
   obvious enough to be exempt.
2. **Every citation resolves to the supplied context.** A reference to a
   plausible record id that was never retrieved is a *fabricated* citation,
   which is worse than an uncited claim: it carries the appearance of having
   been checked.
3. **Every numeral is accounted for** — a cited fact at the precision written, a
   figure the app calculated from the user's own scores, a criterion reference,
   or text appearing verbatim in a cited record. Nothing else.
4. **Nothing in the refusal boundary is asserted**, however it is worded.

A draft that fails is **rejected and the answer withheld** — not shown with a
caveat. A caveat on an answer containing an invented figure still contains the
figure, and the figure is what gets pasted into a board pack. One retry is made
with every problem fed back at once, so a second attempt can fix all of them
rather than discovering the next one each time.

### The number rule, which is the hard one

`$4.2m` and `$4,200,000` are one figure written two ways; `$4.5m` against a real
`$4.2m` is a different figure that reads identically in a sentence. The rule is
precision-aware: a written form is accepted if the actual value rounds to it at
the precision shown. So 4,199,614 may be written as `$4.2m` and may not be
written as `$4,200,000` — writing a figure out in full claims a precision it
then has to have.

Spelled-out numbers are free and always will be, because they cannot carry false
precision. The rule quietly pushes the prose towards words for counts and digits
only for measured quantities, which is how it should read anyway.

### Guidance lives in git, not in a prompt and not in a table

`src/knowledge/corpus.js` holds every record the advisor is allowed to know,
each attributed to a dated, versioned publication.

A prompt would rot silently, could not be cited, and would break the product's
own rule — the app refuses to let a model originate a number, so it must equally
refuse to let one originate guidance. A database table would fix the first two
and fail a fourth test: guidance could then change without a code review. In
git, a change to what the product tells people arrives as a diff, in a pull
request, with an author and a date, and an accelerator auditing what its
companies are being told can read it.

The content rules are themselves tests. A record that speaks for what investors
"require", cites a statistic, names a vendor or gives professional advice fails
the build — because prose drifts, and the sentence that makes the product sound
most authoritative is usually the invented one.

Records past their review interval are **flagged, not hidden**. An answer citing
one must disclose it, and a draft that cites one silently is rejected. Silent
expiry is the failure a prompt has; reproducing it here would be worse, because
it would look as though it had been handled.

### Retrieval has to be able to explain itself

Deterministic scoring over tags, titles and criterion references — not
embeddings. It is inspectable (every result carries `why`), it is stable (an
answer stored today is still explicable when retrieval is rerun in two years),
and the corpus is small and meant to be read.

**A record is returned only if retrieval can say why.** That started as a
presentation nicety and turned out to be a correctness rule: asked what the
weather was doing, retrieval returned a record on owner capacity, because the
word "look" appears in it — score 0.5, `why` empty. A non-empty context is what
tells the advisor it has material to work from, so an incidental word match
becomes licence to answer a question the corpus does not cover. If it cannot be
explained, it is not a match.

When nothing is retrieved, the honest answer is given: there is no record
covering this. **No fallback to what the model happens to remember** — an
unsourced answer would look exactly like a sourced one.

### What it refuses, and why that is the product working

Screened deterministically, before any model call — a refusal that costs a model
call is one somebody will later soften on cost grounds.

- **Valuation.** A valuation is a number, and the product does not originate
  numbers about a business.
- **Introductions, or who to approach.** Permanently out of scope and stated as
  such, not as not-yet-built.
- **Legal, tax and accounting advice.** Operational preparation only.
- **Readiness verdicts and outcome predictions.** It reports a measured band
  against criteria the user answered themselves. A measurement of preparation is
  a different thing from a prediction, and the only one of the two that is
  honest.
- **Anything about other organisations.** No benchmarking, no cohort, no
  anonymised aggregate. `buildContext` only ever reads rows scoped to one
  organisation, so the absence is structural rather than promised.

Each refusal explains itself at length, because a bare refusal reads as the
product being unhelpful rather than as a line drawn on purpose.

### Grounded in the company's own state

`buildContext` is the part worth reading. "What should I work on next?" is
answered from this company's open gap register, in the published fix order, with
the criterion behind each item — and `nextActions` answers it with **no model at
all**, because it is their own data sorted by a written rule. The advisor exists
for the questions that cannot answer.

Facts go through `usableFacts`, so an extraction still awaiting confirmation can
never be quoted back as established.

### What Phase 4 does NOT guarantee

**It does not guarantee good advice.** It guarantees that nothing reaches a user
that is not traceable to a dated record or to their own documents. Whether the
guidance in the corpus is the right guidance is a judgement about the content,
made by whoever maintains it, and the review dates exist so that judgement has
to be made again on a schedule.

**The advisor itself is not written.** `src/advisor/fake.js` is a deterministic
stand-in that includes every characteristic failure mode — uncited assertions,
fabricated citations, plausible round numbers. The real one implements
`src/advisor/interface.js`.

**The corpus is a starting set.** Around half the 32 criteria have a record
behind them; the rest retrieve nothing and get an honest "not covered". That is
a content gap, visible in `knowledge.test.js`, and the right fix is writing
records rather than loosening retrieval.

---

## Phase 5 — artifact generation

Documents rendered from the fact store: decks, memoranda, registers, the
readiness report, the room index. Thirty-one kinds, declared as data.

### No figure is ever typed

Every number on every page is a reference resolved at render time, through
`FactBinder`. Nothing in the rendering layer is permitted to write a figure any
other way, which has two consequences worth stating:

- **The deck and the model cannot contradict each other**, because the deck has
  no numbers of its own to contradict anything with.
- **The provenance appendix is complete by construction.** It is built from what
  the binder was actually asked for, not from a list someone maintains, so it
  cannot drift from the document it describes.

Prose takes figures the same way: `{{fact:financials.arr}}` in a sentence
resolves to a referenced value, and a key with nothing behind it renders as an
em dash. It is never filled with a plausible number, because a placeholder in a
document that leaves the building becomes a real number to whoever reads it.

### Four things that block generation

A blocked artifact is a 200 with reasons, not an error. The user has not done
anything wrong; the document is not ready, and the reasons are the useful part.

1. **An unresolved contradiction.** Rendering from facts known to disagree puts
   the product's name on the contradiction.
2. **A missing required fact.** No placeholders, no plausible defaults.
3. **An external claim that cannot be cited properly.** See below.
4. **An image that would print badly.** See below.

### Market claims, and the feature deliberately not built

The obvious feature here is one that asks a model for a market size and prints
it with a citation. It would be the most damaging thing in this product. A model
will produce *"the global X market was $47.3bn in 2025, growing at 12.4% CAGR"*
with a publisher, a report title and a year, and every part of it can be
invented — including the report. It reads as **more** authoritative than a real
figure, because real figures are rarely that tidy. The founder puts it in front
of an investor, and the investor is the one who checks it.

So there is no model-sourced statistic and no separate path for market data. An
external claim takes the same route as any other figure: the user supplies the
source, extraction reads a candidate with a locator, a human confirms it. What
is added is the extra burden an external claim carries, because "page 3 of a
document in my own data room" is not a citation anybody else can follow:

- a named publisher and title, and a publication date;
- a locator — page, table or section;
- **a verbatim quote**, so the figure can be checked without re-reading the
  source, and so it cannot drift from what was actually said;
- a reachable reference — a URL with an access date, or the source in the room;
- an age, checked against what kind of claim it is. A market size is treated as
  current for two years; a historical fact never expires.

A claim missing any of those is not rendered with a caveat. It is not rendered.
Sources a reader cannot open without a subscription are flagged — not as a
criticism, but because an argument resting on one is worth knowing about before
the meeting rather than during it.

### Print quality, and why the renderer was chosen by experiment

Both candidate PDF renderers were given the same chart SVG **before** anything
was built on either. WeasyPrint produced a clean PDF, no error, exit zero — with
**two of the three bars missing**. It silently dropped every gradient-filled
shape. A unit test on the SVG would have passed, because the SVG was correct.

Chromium renders it correctly, so Chromium is the renderer — and
`tools/inkcheck.mjs` exists because of that spike. It rasterises the output and
asserts that ink actually landed where the chart said it would, so a renderer
swap or a version bump cannot quietly reintroduce the same class of failure.

Everything else follows from the same concern:

- **Vector throughout.** HTML and inline SVG to PDF. A chart stays sharp printed
  at A3; a rasterised one does not.
- **Fonts embedded as data URIs.** A linked font that fails to load does not
  raise an error — it silently falls back, and the first anyone knows is a deck
  set in Times New Roman arriving at an investor.
- **`print-color-adjust: exact`**, without which a browser strips background
  fills when printing and every filled chart element disappears.
- **Charts have a physical size in millimetres**, so a chart cannot grow past the
  bottom of a fixed-height slide.
- **The palette alternates luminance.** Data rooms get printed, and printed in
  black and white more often than anyone designing them expects. A palette that
  is beautiful on screen and renders as four identical greys has failed at the
  only moment that counts.
- **Label colour is chosen by relative luminance**, because white on this
  palette's amber is unreadable at 8.5pt.
- **One figure precision per chart and per column.** A single waterfall once read
  "$420k … +$68.0k … $610k" — three figures at zero decimals and two at one, in
  the same row of labels.
- **Negatives in brackets, tabular numerals, totals ruled above.** The rules a
  financial printer would apply.
- **Absence is an em dash, never a zero and never a blank.** A blank cell and a
  zero cell mean different things and a reader assumes whichever is worse.
- **A chart with nothing to show draws nothing** and says why. An empty chart in
  a deck looks like a mistake, and the reader cannot tell whether the data is
  missing or the number is zero.

### Images are judged at placement size

A 600-pixel logo is fine as a thumbnail and unusable across half a slide, and
only the placement knows which it is. So resolution is checked where the image
is placed, against a floor per role — 300 dpi for a logo, 220 for a photograph,
144 for a screenshot, where demanding more would produce an upscaled blur worse
than the original. An asset whose dimensions were never recorded is refused
rather than assumed adequate: that is exactly the one that turns out to be 180px.

### Three bugs this phase found

**`Number(null)` is 0, for the third time in this codebase.** The cohort heatmap
rendered every not-yet-reached period as 0% in a shaded box — a retention cliff
that never happened, in the chart built to answer "does revenue stay?". It got
all the way to a rendered PDF before anyone looked. The coercion now lives in
one place as `toNumber`, and `Number()` on possibly-absent data is a bug
wherever it appears.

**Slides overflowed.** Blocks were packed onto fixed-height pages until a chart
ran through the footer and off the page. Slides now take one idea each, which is
also how a deck should read.

**Two mutations survived**, both because the tests could not distinguish the
mutated behaviour — a per-column precision test whose values did not straddle a
scale boundary, and an absent-value test that only exercised the null path.
Both are now written so they would fail.

### What Phase 5 does NOT guarantee

**It does not guarantee the document is persuasive.** It guarantees every figure
is traceable, every external claim is checkable, and nothing prints badly.
Whether the argument is any good is the founder's job, and the advisor's.

**Thirteen registers have no data model yet** — the Q&A log, the disclosure
schedule, the contract register and others render from fact keys under a prefix
and say plainly when nothing has been recorded. The catalogue declares what a
data room is expected to hold; the product says which of it the company has
given it the material to produce.

**The PDF step needs a browser**, so it is a tool rather than part of
`npm test`. Everything that decides what a document *says* is tested without
one.

---

## Phase 6 — the operating cadence

Lock a forecast. Close a month. Explain what moved. Repeat.

This is the phase that makes the product worth keeping after a raise, and the
argument for it is narrow and strong.

### The one thing that cannot be bought later

Criterion 2.4 asks whether forecast credibility is demonstrable: the last three
forecasts set against actuals, with the variances explained. The knowledge
corpus says the uncomfortable part out loud — **this is impossible to produce
retrospectively.** A company that did not keep its forecasts cannot assemble
that history when a process starts. No adviser can supply it, no competitor can
generate it, and no amount of preparation in the final eight weeks recovers it.

A company that has run this cadence for eighteen months arrives holding it.

### The rule the whole phase rests on

**A locked forecast is immutable, and actuals never re-baseline it.**

The tempting behaviour is to slide the forecast to match the outcome, or to let
a founder tidy up last quarter. Either one destroys the only asset being
accumulated: there would be no fixed forecast left to compare against, and the
history would show a company that always hits plan — which is both false and
immediately recognisable as false.

So a revision is a new version, the old one stays visible, and the reason for
revising is required. A **superseded** forecast is still measured, because it
was what the company believed at the time and dropping it would let a company
revise its way to a clean record.

### Missing and explaining beats hitting and saying nothing

Materiality is banded — on plan, minor, material, severe — and only the top two
demand an explanation, because explaining noise wastes the reader's attention.

Variance is measured **against the forecast, not the outcome.** A forecast of
100 against an actual of 140 is a 40% miss of the plan; measured against the
outcome it is 29%, and every overshoot gets quietly downgraded.

The credibility score counts explanation before accuracy. A company that missed
and explained scores better than one that hit and said nothing, because the
criterion tests whether a business understands itself, not whether it is lucky.

**When an explanation was written is recorded and shown.** One written in the
week is evidence the business understands its drivers; the same words eight
months later are a reconstruction, and a reader comparing the dates will see it.

### Derived figures stay derived

Run rate and growth are written as `CALCULATED` facts with their formula and
their input fact ids, so a run rate on a slide is as traceable as a figure read
off an invoice.

**Runway is deliberately not extrapolated.** Projecting a burn forward and
announcing a date produces a figure that gets repeated in a board meeting as
though it were known. It is computed only when a cash balance and a monthly net
burn have both been confirmed, and refused otherwise — including when burn is
zero, which would otherwise print a runway of forever.

### Three new artifacts

`FORECAST_CREDIBILITY` (the record that satisfies 2.4), `BOARD_PACK` and
`INVESTOR_UPDATE` — all rendered from the same facts as everything else.

### Two bugs this phase found

**The cycle threshold was written twice** — once as reported data, once as a
literal in the comparison — so changing the stated requirement left the enforced
rule untouched. Mutation testing found it; it is one constant now.

**A generic fallback overwrote a purpose-built chart.** The prefix-driven
builders from Phase 5 ran after the specific ones and silently replaced the
forecast-variance chart with a lookup that had nothing to find, rendering a
"nothing recorded" note beside a table full of the data. Specific builders now
win.

---

## Phase 7 — staleness propagation

Every artifact already recorded the exact fact ids it was built from. Nobody had
walked that graph. This phase walks it.

### Staleness is graded, because binary staleness is useless

A corrected label and a revenue figure moving thirty per cent both "change the
artifact". If both raise the same flag, people stop reading flags — the same
failure the conflict detector was designed around, arriving from a different
direction.

So what changed is classified: a **figure corrected** or **disputed** makes a
document wrong; a figure **gaining better evidence** or **tracing to a new
source** makes it improvable; **new material** makes it incomplete. Only the
first two count as wrong.

### The urgent case is the one somebody else is holding

A stale draft is housekeeping. A deck in an investor's inbox quoting a number
the company has since corrected, with nobody told, is a trust problem with a
clock on it.

So `released_at` changes the grade rather than the wording, and **URGENT exists
only** for a released document resting on something now wrong. Marking an
artifact released requires saying who it went to — when a figure moves later,
the first question is who holds the old copy, and that is a bad moment to be
reconstructing it from memory.

### Regeneration never rewrites what was sent

A regenerated artifact is a **new version**; the old one is marked superseded
and kept. If it was released, that record is exactly what somebody outside the
company is holding, and destroying it would remove the only way to answer what
they actually saw.

Before regenerating, a **preview** names every figure that will move and both
its values. "I regenerated and now I do not know what is different" is a worse
position than the stale document was.

### Documents age by what they are

A flat interval is the lazy version and actively misleading: it flags the
articles of association every quarter while treating management accounts from
February as fine in October. Management accounts age in six weeks. A contract
does not age at all — it changes status when its term arrives, and claiming a
date for that would be inventing one. Constitutional documents never age.

Every policy carries a stated reason, because a nag without one gets dismissed.

### Three bugs this phase found

**New material was judged against every fact the company held**, so a financial
summary was permanently flagged incomplete because somebody had recorded the
registered name. That is precisely the crying-wolf failure the phase exists to
avoid, caught by a test asserting that an untouched artifact stays current. It
is now scoped to the keys the artifact's own catalogue entry declares.

**Two mutations survived on test-design flaws.** One test planted an unconfirmed
fact under a key the artifact never wanted, so the scoping rule excluded it and
the test passed for the wrong reason. The other read `stale_since` from the API
response — which reports the row as it was *before* the update — so the stored
date could have marched forward on every check while the test saw it stable.
Both now assert on what they meant to.

---

## Phase 8 — live sharing

The largest security surface in the product: a path into a company's data room
that does not go through membership at all.

### What "live" means here, and what it deliberately does not

The naive reading is that content silently updates so the recipient always sees
the latest. That is **worse than emailing a PDF**.

An investor who read "$3.6m revenue" on Tuesday and sees "$3.4m" on Thursday,
with nothing to say it changed, does not conclude the company is diligent. They
conclude the number moved while they were deciding, and start wondering what
else did. A stale PDF is at least honestly stale.

So live means **the link survives updates and the company decides when they
propagate**. The URL keeps working, access can be withdrawn, you can see who
looked — and a new version reaches the recipient when it is *published* to them,
announced, not swapped in underneath them.

`FOLLOW_LATEST` exists for cases where a moving document is the point, and in
that mode **the page tells the reader it updates**. What is never allowed is a
reader who cannot tell which of the two they are holding.

### The token rule

The raw token is **never stored** — only a SHA-256 hash, with a short prefix so
a human can tell two links apart in a list. A leaked database must not hand
anyone a working link into a data room.

Lookup is *by hash*, which also means no secret comparison exists in the path to
get wrong: there is no timing-unsafe equality check because there is no equality
check. The token is shown once and cannot be recovered; losing it means issuing
a new link, which is also what keeps the access record honest.

Every link carries an expiry — capped at a year, defaulting to ninety days —
because a link with no expiry outlives the process that justified it and nobody
ever goes back to tidy up.

### Two surfaces, kept visibly apart

The **owner** surface goes through `authorise` like everything else. The
**recipient** surface is reached by a token and has no membership at all. They
are separated in the file because the failure mode is one drifting into the
other. Every recipient function resolves the token and takes the access decision
before it reads anything.

An unknown token is a 404 that says nothing — the same rule as organisation
isolation. A *revoked* link says it was withdrawn, because the recipient already
knows the link existed and pretending otherwise is theatre that only confuses an
honest reader.

### Two audit criteria, satisfied by using the product

**8.3 — staged access with a record of who received what.** Room links carry a
stage decided when the link is made, not when a request arrives, and reuse the
Phase 2 staging rules rather than inventing a second access model. Every opening
is logged with which version was served.

**No IP addresses are recorded.** The recipient is already identified by the
link they were given, so an address adds nothing to the audit purpose while
creating personal data the company then has to account for.

**8.4 — a question log.** Questions asked through a link land in it
automatically. When answering, the product surfaces **what was already told to
somebody else** — because two different answers to the same question is more
damaging than either answer being imperfect, and it moves the conversation from
the business to whether the company can be relied on. A divergent answer is
flagged, never blocked: deciding whether two pieces of prose mean the same thing
is a judgement a product would get wrong often and confidently.

### What this phase does not claim

Turning off download removes the button and watermarks the copy. **It is a
deterrent and a way to trace a leak, not protection** — anyone who can read a
page can photograph it. Overclaiming here would be worse than not having the
feature, because a company that believes it has DRM will share something it
should not.

Revoking ends access; it does not recall a copy already downloaded.

### Three findings

**Two phrasings of the same question missed each other.** "How is net revenue
retention *calculated*?" and "What basis is used to *calculate* revenue
retention?" scored 0.33 against a 0.4 threshold — missing exactly the case the
consistency check exists for, since nobody re-asks a question in the words
somebody else used. Light stemming and a stopword list fixed it.

**One mutation was equivalent, not a missing test.** It injected the raw token
into a field that a later key in the same object literal overwrote, so it
changed nothing. Re-anchored where the hash is actually produced.

**Two real test gaps.** The stemming rule could have been deleted without
anything failing — stopword removal alone kept that pair above the threshold —
and nothing asserted that the access log records *which version* a recipient
saw, which is the part that matters six weeks later when a figure has moved.

---

## Phase 9 — brand

### Brand is an input, not an instruction

A founder choosing brand colours is not a designer. They will hand over the pale
mint from their website, and applied literally it produces an eyebrow label
nobody can read, a chart palette of four indistinguishable pastels, and a deck
that looks worse than the default would have.

The naive version of this feature applies what it is given and ships the result.
The founder then blames the product, and they are right to: it had every piece
of information needed to know the output was unreadable and used none of it.

So what renders is **derived** from what they supply — a text-safe variant of the
accent, a rule colour, a page wash, a chart palette with separated luminance —
and **every adjustment is reported**. An unexplained difference between the
colour someone supplied and the one on the page is indistinguishable from the
product being wrong.

### What the derivation guarantees

| | floor |
|---|---|
| accent as small text, on the page | 4.5:1 |
| rules and borders | 3.0:1 |
| body text on the derived wash | 4.5:1 |
| adjacent chart colours, in greyscale | 0.08 |

The last one is the one that matters and the one nothing else checks. **Data
rooms get printed, and printed in black and white more often than anyone
designing them expects.** A palette that is beautiful on screen and renders as
four identical greys has failed at the only moment that counts, and the failure
is invisible until someone is holding the paper.

### The ladder is in luminance, and the first one was not

The first implementation walked an HSL **lightness** ladder. It looked right and
it controls nothing: a yellow and a blue at the same HSL lightness differ by a
factor of five in relative luminance. A mint accent came out with **0.014**
separation against a 0.08 floor — four indistinguishable greys — while passing
every structural check in the suite.

Rewritten to target relative luminance directly, by binary search, with the
remaining targets ordered greedy-furthest from the brand's own luminance rather
than from an assumed starting point.

### A dead safety net, deleted rather than tested

`deriveBrand` carried a fixed-saturation fallback for a palette that came out too
flat. Mutation testing said breaking it changed nothing. A sweep of **45,283
accents across the whole colour space** found none that fail the floor: the
branch was written for the HSL ladder, the rewrite made it unreachable, and the
adjustment it promised the user could never be shown.

Deleting it was the honest move, and what replaced it is stronger — the sweep
runs as a property test over thousands of accents on every run, instead of the
guarantee resting on a branch nobody could reach.

### Stored twice, deliberately

What the user supplied is the record of *intent*. What was derived from it is the
record of *output*. Both are kept.

Keep only the derived tokens and a founder asking why their accent is darker here
than on their website can only be answered with a guess. Keep only the supplied
values and every render re-derives, so a change to the contrast floors silently
restyles documents that already went to investors.

**Setting a brand is not retrospective.** Documents already generated keep the
colours they were generated with. Reissuing a document an investor has seen, in
different colours, under the same name, is worse than an inconsistent set of old
PDFs.

### The scope, and why it is module state

Charts are pure functions across thirty-odd builders, each calling
`seriesColour` with nothing but an index. Threading a palette argument through
all of them would work until one was missed — and one missed builder means a
single chart in RaiseRoom purple inside an otherwise-branded deck, which nobody
notices until a client does.

So resolution happens in `withPalette`, the one place every chart already goes
through. That is only safe because generation is fully synchronous, and two
guards keep it that way rather than trusting a comment: the scope restores in a
`finally`, so a document that throws halfway cannot leave one organisation's
colours set for the next request; and nesting two *different* brands throws
rather than letting the inner one quietly win.

### An organisation that sets no brand overrides nothing

`brandTokens` returns `null`, not the standard token set.

The first version returned `standardBrand().tokens`, whose palette is *derived*
from the standard accent — which silently replaced the hand-ordered, visually
proofed Phase 5 series with eight computed colours in every document belonging to
every company that had never touched the feature. A brand feature should not do
that to the people who did not use it.

### Two defects found by looking at the output, not by the suite

Both reached rendered PDFs. Neither was caught by anything structural, because in
both cases the figure was *correct* — it was just written badly.

**A raw number in the investor deck.** The financial summary printed `3600000`
and `71` where it should have read `$3,600,000` and `71%`. The column declared no
unit, so the value fell through `String()`. The column is genuinely mixed —
currency beside a percentage — which is why it was left unformatted. It is now
formatted per row from each fact's own unit, and `dataTable` **throws** when a
raw number reaches a column that declares no formatting, so the silent version
cannot come back.

**An axis mixing precisions.** A percentage axis labelled
`100% / 75% / 50% / 25% / 0.0%`, because the percent rule gives values under ten
an extra decimal and zero is under ten. One precision is now decided for the
whole axis from its whole tick set — the same fix `compactDecimalsFor` already
applied to rows of labels, which had simply never been applied to axes.

Both are the same class as the `Number(null) === 0` family: correct data,
presented in a way that makes a reader doubt the rest of the numbers.

### The interrupted mutation run

Worth recording, because it nearly did real damage. A mutation run was killed by
a timeout partway through. `finally` does not run when a process is signalled, so
the mutation it was holding — `usableFacts` stripped out of the advisor, which is
what stops an unconfirmed extraction being quoted back as established — stayed
applied on disk. The next run then reported that broken rule as the *test that
caught* two unrelated mutations.

`tools/mutate.mjs` now restores on `SIGINT`, `SIGTERM`, `SIGHUP`, uncaught
exceptions and `exit`, and refuses to start unless the suite is already green —
because a pre-existing failure makes every mutation look caught and the run
reports a reassuring number that means nothing.

### Proving it by looking

`node tools/proof-brand.mjs` renders one deck under four brands — the standard, a
corporate blue, the pale mint, and a yellow where lightness and luminance diverge
most — then draws all eight series of each palette on one page and converts them
to greyscale.

The numbers can all be right while the page is still wrong. That is exactly how
the first palette shipped four identical greys.

---

## Phase 10 — the advisor acts

Natural language in, a proposed diff out, a human confirms.

### The one decision everything else follows from

**Applying a proposal calls the ordinary service functions.** Not the database.
`markNotApplicable`, `updateGap`, `createFolder` — the same functions a person's
click goes through, with the same authorisation, validation and audit rows.

Writing the rows directly would have been easier. The proposal has been validated
against the catalogue, the target checked, the shape known — and every rule in
those service functions would be bypassed: the ten-character floor on a
not-applicable reason, the membership check on a gap owner, the duplicate folder
check. An advisor path that writes rows is an advisor path where none of them run.

So the advisor is a caller with no privileges. A proposal refused at confirm time
by a rule that did not apply at propose time is the design working, and the
refusal is shown rather than swallowed.

### A catalogue, not a permission list

Ten action kinds. Each declares the exact columns it may write, and a payload
carrying anything else is rejected before it is stored — which is how an action
quietly grows otherwise: same kind, wider payload.

An action outside the catalogue cannot be proposed, because there is no code path
that would accept one. Not "is refused" — does not exist. No entry targets
`fact`, nor `audit_log`, `artifact`, `share` or the forecast tables, and a test
asserts it rather than a comment promising it. An audit trail the actor can edit
is not an audit trail.

### A proposal is a statement about a moment

A proposal written on Tuesday and confirmed on Friday is a statement about
Tuesday. If someone assigned that gap on Wednesday, confirming on Friday silently
overwrites them — and the person doing the overwriting is a human who pressed
confirm on a one-line summary that was true when it was written.

So each proposal records the slice of the row it read, and refuses if that moved.
**Narrowly**: only the fields the action reads or writes. Hashing the whole row
would invalidate an owner proposal because somebody edited the description, and a
product that cries stale at every unrelated edit teaches people to confirm
without reading — which is the exact failure the check exists to prevent. That
lesson is Phase 7's, and it is now the third place it has applied.

Proposals expire after fourteen days, evaluated on read rather than by a sweeper
that has to be running.

### Undo compares against what the row became

Not against what the proposal asked for. A payload field need not be a column:
`reason` becomes `na_reason`, and marking an item not applicable also clears its
`document_id` — an effect that appears in no payload at all.

The first version compared the payload against the row, which reported every
applied action of that shape as having been changed by somebody else, so none of
them could ever be undone. The after state is now captured from the real row at
apply time. Undo also refuses if someone has changed things since, because
undoing on top of another person's edit is the same silent overwrite in the other
direction.

### Prose is the hole in the fence

Every other action writes a structural field with a closed set of values. Prose is
free text, and free text can carry a number. "Revenue grew to $4.2m" written into
a deck **is a fact value**, whatever table it sits in — and it is false in the
least detectable way: a true sentence, in the right tone, in a document that
otherwise cannot lie.

So prose takes the number rule, and it takes it from **everyone**. The advisor,
because an advisor originating a figure is the failure this architecture exists
to prevent. The user, because the claim printed on every generated document does
not say "except where the founder typed it".

The way through is not an override. `{{fact:financials.revenue.ttm}}` resolves at
render time to the bound value at the right precision — so a writer who wants a
figure gets one, and it stays correct when the fact is superseded, which a typed
number does not. Being told "record it as a fact first" is the product working: a
figure worth putting in front of an investor is worth having provenance for.

The advisor is held to **what it cited**, not to everything the company holds.
Checking against the whole fact store would let it write any number the company
happens to have, whether or not it looked at it — originating a figure with extra
steps.

### There is no ADVISOR_WRITTEN

`prose_block.source` has two values and will never have a third, exactly as
`fact.source` has no `AI_GENERATED`. Prose the advisor drafted becomes
`ADVISOR_DRAFTED_USER_APPROVED` when a named person confirms it, attributed to
them — because they are the one who put it in the document. Before that it is a
proposal, not prose.

### Rejected suggestions are kept

"The advisor suggested this and we said no" is worth being able to show, and it is
the only signal that would tell anyone the suggestions are poor. An empty proposal
list is indistinguishable from an advisor that never suggests anything.

### The mutation harness, twice

A mutation run killed by a timeout left `usableFacts` stripped out of the advisor —
the rule that stops an unconfirmed extraction being quoted back as established.
Signal handlers were added. The next timeout killed it with **SIGKILL**, which no
handler can catch, and it left another mutation applied.

So the original is now written to a journal file *before* the file is touched, and
a later run finds it and puts it back. That is the only approach that survives a
kill the process never hears about. The run also refuses to start unless the suite
is already green, because a pre-existing failure makes every mutation look caught
and the run then reports a reassuring number that means nothing.

---

## Writing with facts — removing the friction without removing the rule

A figure may not be typed into a document. That rule is not negotiable; it is the
reason a reader can stop checking a deck against the accounts.

But the first version of it refused the sentence, explained the policy, and
stopped — leaving the writer to find a form somewhere else, invent a key, and
come back to a sentence they had lost the thread of. People do not do that. They
write the deck somewhere else and paste it in.

**So the rule stays and the work goes.** Every refused figure now comes back with
one of two things:

- **You already have this.** The commonest case by far. If a confirmed fact holds
  4,200,000 and the writer typed "$4.2m", the answer is not "record a fact" — it
  is "that's your TTM revenue; insert the reference?" One click, nothing created,
  and the sentence is now better than what they typed because it corrects itself
  when the fact does.
- **Here is the one you are about to make.** Named, with the value and unit read
  off how the figure was written and a label taken from the words around it, plus
  the exact replacement text. The writer confirms a draft rather than filling in a
  form, and `recordAndInsert` creates the fact and repairs the sentence in one
  call.

The fact library is searchable, grouped under headings a person recognises, shows
which facts documents actually lean on, and surfaces unconfirmed extractions as a
section rather than a filter — that being the commonest reason a writer is told a
figure they can see on screen cannot be used.

**What this did NOT do is soften anything.** In fact it got stricter: a literal
`$4.2m` that matches today's revenue is still a typed figure. Correct the fact to
4.3m and the charts move while the sentence does not — the contradiction the
architecture exists to prevent, in the one place a reader is most likely to
believe without checking. Matching a fact is no longer enough; the numeral has to
*be* the reference. `{{fact:your.key}}` is the way through, and it is not an
override.

[`docs/WRITING-WITH-FACTS.md`](docs/WRITING-WITH-FACTS.md) is the interface spec
for whoever builds the UI, including the four states of a sentence and the things
that must not be built.

---

## Phase 11 — localisation

### A figure never passes through a translation model

Not instructed not to. **Never given one.**

"1,234.56" and "1.234,56" are the same number written for different readers, and
a model asked to translate a document containing the first will sometimes produce
the second, sometimes "1.234.56", and occasionally a different number entirely —
confidently, in fluent German, in a document whose entire claim is that no figure
in it was typed. The failure is invisible to anyone who does not read both
languages and hold the accounts.

So figures are formatted by `Intl` from the stored value. The translation layer
never sees them.

### What made this phase possible was the previous one

Prose here cannot contain a numeral — every figure is already a `{{fact:}}`
reference, enforced when the prose is written. So **the text handed to a
translator contains no figures to corrupt.**

That is not a happy accident. It is why the number rule was worth being strict
about: a guarantee made in one phase turned out to be the precondition for the
next one existing.

### Mask, translate, restore, count

References are replaced with opaque markers before the text leaves and restored
after it returns. The result is **refused** — not warned about — unless every
marker came back exactly once:

| failure | what the document would have done |
|---|---|
| marker dropped | a blank where a figure goes |
| marker duplicated | one figure printed twice, another missing |
| marker invented | an index pointing at nothing |
| **marker's digits altered** | **the wrong company figure, silently** |

The last is the one worth refusing loudly for: it produces a document that is
fluent, complete, plausible and wrong. The fake translator in `src/translate/`
does all five, and each has a test.

There is also a check for numerals appearing during translation that were not in
the source. Prose cannot contain a numeral in the first place, so it should never
fire — which is exactly why it is there.

### A machine translation is not a translation yet

It is stored `MACHINE_TRANSLATED` and no document will render it. A person
approves it first — the same shape as `USABLE_SOURCES` excluding an unconfirmed
extraction, and for a sharper reason: **the person who would catch the mistake
cannot read it.**

Approval is refused if the English has been rewritten since, because that would
put a paragraph in the French deck that the English deck no longer contains, and
nobody comparing the two could say which was right. A translation whose source
has moved stops being used and says so.

Fallback is **per passage, not per document**: a deck with three paragraphs
approved and one not is three-quarters in French rather than entirely in English,
and every fallback is reported at the moment of generation rather than discovered
by a reader.

### What is never machine translated at all

Disclaimers, legal notices, confidentiality wording, forward-looking statements,
and names. A mistranslated liability limitation is a legal document that says
something nobody drafted. A company registered under one name does not have
another one in French.

### Four languages, and the real reason for the others

English (UK and US), French, German, Spanish. The brand faces carry Latin script
only, so a Japanese or Chinese document set in them renders as empty boxes, and
Arabic needs the entire layout mirrored — tables, charts, page furniture — which
is a different design system, not a font substitution. Asking for one of those
gets that explanation rather than "unsupported".

### The string catalogue is in git, and was written by hand

Same argument as the knowledge corpus. "Confirmed from accounts.pdf p.4" is a
claim about provenance made by the company issuing the document; a machine
translation of it that comes out meaning "Approved by" is a materially different
claim in a language the issuer cannot check. In git it is versioned, reviewed and
diffable. A locale is not offered until every string exists.

### Two things found by rendering it

**"4,1 $m".** German puts the currency symbol last, so formatting the number as
currency and then appending the scale suffix produced something that reads as a
currency called "$m". The suffix belongs to the digits; the symbol goes where the
locale puts it, read from `Intl` rather than from a table of our own.

**A comma that went missing.** Routing the appendix through the catalogue changed
the English from "Confirmed from accounts.pdf, p.4" to "...pdf p.4", and a
page-less fact started rendering "p.—". Caught by a Phase 5 test. Now two
strings rather than one with an optional clause.

---

## Phase 12 — tiers, billing and portfolio

### Nobody is ever locked out

Expiry gates **writing**. Reading and exporting are not gated anywhere, by
anything, in any plan or any state — not because somebody remembered to allow
them, but because the function that would refuse does not exist.

This is commercial as much as ethical. A company that stops paying has usually
stopped because the raise is over; they will be back in two years, or an acquirer
will ask what this tool was. A product that holds their diligence file hostage
converts that into a chargeback and a review. One that hands it over gets
recommended.

Every billing refusal carries `still_yours`, because the question somebody
actually has when they see one is not "which plan has this" but **"have I lost my
file"**.

A **past-due card does not cut anybody off** either. A failed payment is usually
an expiry date, not a decision, and cutting a company off mid-raise over one is
how a product gets replaced in the worst week of somebody's year.

### The full export, which previously did not exist

The promise had nothing behind it until this phase. Now:

- it **discovers its tables from the schema** rather than from a maintained list,
  so a table added in a future phase is exported without anybody remembering —
  "we forgot to export the new table" is a failure found by a customer who has
  already left;
- it **resolves its references into words**. A row saying
  `source_doc_id: "a1b2…"` tells the person opening the file nothing;
  "accounts.pdf, page 4" tells them everything they needed it for;
- it **withholds live access tokens and says that it did**. Exporting them would
  hand working keys to whoever opens the file; an export with a gap nobody
  mentions is worse than one that names it.

### No price lives in this repository

The billing provider holds the plan and what it costs. A price kept in two places
disagrees eventually, and the wrong copy is always the one the customer sees.
There is no card number, token or payment detail in any table either — the
provider's hosted checkout takes payment and this product never sees it, so there
is no PCI scope because there is nothing in scope.

### The $147 credit, guarded twice

Once would not be enough, because "check whether it has been applied, then apply
it" is the shape of every double-spend there has ever been.

1. A **unique index on the redemption**, so a retried request loses to the
   database rather than to a race.
2. An **idempotent provider call** keyed on that same redemption, so even if this
   product somehow asked twice, the customer is credited once.

And if the provider call fails, **nothing is recorded locally** — a row written
for a call that did not happen would make the credit unusable for ever, because
the local guard would then refuse the retry that should have worked.

### Webhooks are unauthenticated public requests until verified

- **Verified before anything is believed**, with the signature compared in
  constant time. `===` behaves identically in every functional test and leaks the
  expected signature a byte at a time to anyone willing to send enough requests.
  That property has no observable behaviour, so it is asserted against the source
  in `test/reserved-words.test.js`, which is where this codebase keeps checks of
  that kind.
- **Idempotent on the provider's event id.** Every provider retries; the fifth
  delivery does nothing.
- **Ordered by the provider's clock, not by arrival.** A `cancelled` arriving
  after the `renewed` that superseded it would otherwise lock an account that had
  just paid.
- **An unmapped event type leaves the subscription alone.** Guessing — treating
  an unknown event as a cancellation — turns a provider shipping a feature into
  an outage for every customer.
- **Every event is stored verbatim before it is acted on.** A billing dispute is
  answered from what the provider actually sent, not from the state it left.

### A trial, computed rather than stored

A new organisation gets 14 days of the preparation plan. A free tier that stops
short of a single document asks somebody to buy on description, and this
product's whole argument is that a generated document is unlike what they would
otherwise produce.

It is computed from the organisation's creation date, so it cannot be left
switched on by a sweeper that stopped running. **Its length and plan are
commercial decisions and sit in one constant** — `TRIAL` in
`src/domain/billing.js`.

### The portfolio is the only route between two organisations

Everything else in this product is sealed, so this is built as the exception that
proves the rule rather than the hole that ends it.

**The company invites the holder.** There is no call anywhere that lets an
accelerator add a company to its own portfolio. A list somebody can assemble about
other people without their involvement is surveillance, whatever the menu calls it.

**What is shared is a named, fixed field set** — not "summary access" but a list
the company reads before agreeing, and the holder's response is built by
*selecting* those fields rather than by trimming afterwards, so a field nobody
consented to cannot survive a later change to how the response is serialised.

**It never reaches a fact, a document, or anything written.** An accelerator sees
how a company is progressing; it does not see their accounts, contracts or cap
table. A gap's *count* is shared; a gap's *wording* is not, because that says
what is wrong with a company in the company's own words.

**There is no benchmark, and there will not be.** No median, no cohort, no
"companies like yours". The moment one exists, every company in the portfolio is
being told about every other one, and the product's central claim about
cross-organisation data becomes marketing copy. The test asserts this
structurally rather than by searching for suspicious words — the first version
grepped for "median" and failed on the sentence promising there wasn't one.

### Three mutations that were wrong rather than three missing tests

Worth recording, because a mutation suite is only as honest as its mutations.

- One emptied a list with `[].length ? [] : [...]`, which evaluates to the
  original array. It changed nothing and correctly survived.
- One added a leaking field to the portfolio summary — and the consent filter
  stripped it, so it never reached the response. That is defence in depth
  working, and the mutation was genuinely equivalent; it was removed and the note
  explaining why was left in its place.
- One checked for `EXPIRED` while the test it was aimed at used `CANCELLED`. That
  one found a real gap: the export test covered a single state. It now covers
  every state in `STATES`.

---

## What is NOT here yet

Stated plainly so nobody assumes otherwise. The first four used to say "no HTTP
layer, no authentication, no UI" — those are built now, and what replaces them is
shorter but no vaguer.

- **No Postgres adapter.** `src/db/sqlite.js` is the only adapter. Postgres is a port of that one file; nothing above it changes.
- **No real extractor, advisor, translator or billing provider.** Four contracts, all defined, all with the rules around them tested against deterministic fakes. **None is wired into the running application, deliberately.** `src/web/advisor.js`, `translator.js` and `payments.js` each explain why a stub is worse than nothing: the fake advisor refuses every question, and `cannot_answer` is a carefully written legitimate outcome — so a deployment with no advisor would be indistinguishable from an advisor with nothing to say, and somebody evaluating the product would conclude the feature was poor rather than absent. Each page says in one sentence that the capability is not configured. Everything else on those pages works.
- **No mail channel.** Document requests are recorded, not sent. Update notifications are drafted for you to send, not sent. The product holds no email address for your counterparties and does not contact them, which is a decision rather than a gap.
- **No email verification or password reset.** Sign-up, sign-in, sessions, lockout and password change are built and tested; the two flows that need mail are not.
- **No file upload from the browser.** Uploads are presigned straight to storage by the service layer and the contract is tested, but the browser-side form that uses the presigned URL is not written. The document page records what a document is and where it belongs.
- **The example's source documents have no bytes behind them.** Register rows with filenames and page numbers, which is what a data room index genuinely is. There is no real set of accounts to put there and inventing one would be a forgery rather than an illustration. The nine documents the product *generates* are real files and they open.
- **Whop plan ids and signing secret** are configuration nobody has supplied yet.

---

## The web application

Zero dependencies — `node:http`, `node:sqlite`, `node:crypto` and nothing else — for
the same reason the rest of this repository has none: a diligence product that pulls
in four hundred transitive packages has a supply chain it cannot describe to the
company whose accounts it is holding.

**The whole of it is thin.** `test/web.test.js` asserts structurally that no route
file calls `authorise`, resolves a membership itself, decides a 403, or writes a row
directly. Every one of the four authorisation bugs in the first implementation of
this product lived in an HTTP handler, where no test could reach it; these ones
cannot, because the tests fail if a handler tries.

What the HTTP layer owns, because nothing below it can:

| | |
|---|---|
| Passwords | scrypt at N=32768, per-user salt, a rehash flag when the parameters move |
| Sessions | token stored hashed, so a database dump is not a set of logins |
| Sign-in | one sentence for every failure, and a hash computed even for an address with no account — otherwise the form enumerates who has one |
| Sign-up | a duplicate address is indistinguishable from success, for the same reason |
| CSRF | per-session token, constant-time compare, plus a same-origin check before the body is parsed |
| Headers | CSP with no `unsafe-inline` for script, `frame-ancestors 'none'`, `nosniff`, `no-store` |
| Generated documents | served under `sandbox; default-src 'none'`, in a frame — a document is a full HTML page of somebody else's making and it must reach nothing |
| Fonts | served from the application. A font request to a CDN tells that CDN who is reading a diligence file and when |
| Isolation | a non-member gets 404, never 403, on every page — asserted route by route |

### Every phase has a surface

The index rail is numbered 00 to 12 and each entry is a phase. Pages that belong to
a phase but are not daily work hang off the section they belong to rather than
widening the rail — the second column below.

| | In the rail | Also reachable from it |
|---|---|---|
| 00 | Overview — band, required items filled, gaps open, what needs attention | |
| 01 | Readiness — 32 criteria on one page, with the scale beside every answer | |
| 02 | Gaps — in fix order, with owners and evidence to close | |
| 03 | Data room — folders, what is filed, what is not applicable and why | Keeping it current: which documents have aged, judged by kind |
| 04 | Documents — what is uploaded, what is waiting to be confirmed | Reviewing one document: confirm, correct or reject each figure, with a reason. Transcribing the paper workbook, box for box |
| 05 | Figures — every figure with its provenance, grouped, searchable | Contradictions: two records disagreeing, shown level |
| 06 | Writing — type `{{` and pick a figure; a typed number is refused and repaired in one click | Languages: the translation review queue |
| 07 | Documents out — what can be produced, what was, what has gone stale | A generated document in a sandboxed frame; the regeneration preview; marking a version as sent |
| 08 | Forecasts — locked when made, never re-baselined, variances explained | |
| 09 | Sharing — one link per recipient, pinned or following | Questions, with the consistency check; who has looked; updates waiting on pinned links |
| 10 | Advisor — proposals showing what they would change, taken from the record now | |
| 11 | Valuation — what a valuer will ask you to evidence. No estimate, anywhere | |
| 12 | Settings — plan, brand, languages, people, visibility | Plan and checkout; people and invites; what a portfolio holder would see, field by field; the audit log |

Outside the rail entirely: `/s/:token`, the counterparty's own page. No account, no
index rail, no sign-in offered, the company's name where the product's would be, and
the attribution in the markup top and bottom so that printing or saving takes it
along. It is the one page nobody using the product ever sees, which is exactly why
it is in the screenshot set.

### What building the UI found in the service layer

The first pass of the interface covered the twelve phases in the sense that every
phase had a page. Auditing it a different way — which exported service functions no
route ever calls — found that it reached about two thirds of what was built, and the
missing third was not the obscure third:

- **A share link could be issued and not opened.** There was no route under
  `/s/:token` at all. The feature tested green at the service layer and was
  unreachable by the person it exists for.
- **Regeneration had no preview.** The button went straight to `generate`, so the
  change digest — the whole of phase seven — was computed and thrown away.
- **Contradictions, the question log, the access record, pinned-link updates, the
  translation queue, the Transfer Sheet import and plan checkout had no screens.**
  Seven features, all built, all tested, none reachable.

Three bugs came out of the same audit, and the useful one is the smallest.
`onramp.creditStatus().credit` and `billing.status().credit` are two shapes for the
same thing, and only the second carries `applied`. Two pages read `applied` off the
first, where it is always `undefined` — so *"your $147 credit is waiting"* showed
for ever, including after it had been spent. Nothing failed. A banner that is always
on is a banner nobody reads, which is the same failure as a conflict list that fires
on rounding, and it is the third time in this build that a signal has had to be
taught to stay quiet.

The lesson worth keeping is the audit, not the fixes: *every page exists* and *every
capability is reachable* are different questions, and only the second one is
answered by walking the exports.

### Three mutations that had quietly stopped running

The full mutation pass over all of this reported 255 of 258 caught, and the other
three as STALE — their anchor string no longer matched the source, so they had not
been applied at all. The harness was right to say so and the message was easy to
skim past.

Repairing the three anchors turned two of them into **survivors**: rules with
nothing protecting them. Both were in staleness propagation, and both were
crying-wolf guards — that *new material* means material this document could have
used rather than every fact the company holds, and that an unconfirmed extraction
is not material at all. Neither absence fails anything. Each would just have made
every document look stale until people stopped reading the signal, which is the
failure mode the whole phase exists to prevent and the hardest kind to notice.

A stale anchor is therefore not a tidiness problem. It is a mutation that has
stopped running, in a file nobody opens except before a handover, and the rule
behind it can rot for months behind a green suite. So the anchors are now checked
by `test/mutations.test.js`, which runs on every change rather than before a
handover: every anchor must still match its file, exactly once.

The *exactly once* half caught a fourth problem immediately. Adding
`readThroughShare` had duplicated the version-resolution loop, so the mutation for
"a pinned share silently follows the latest version" broke the first copy, was
reported as caught, and left the second path unprotected. The loop is now one
function both callers go through.

And the harness itself had the same shape of bug: a mutation that made the suite
*hang* rather than fail was reported as **caught**, because `execSync` throwing on
a timeout is indistinguishable from it throwing on a failing test. One leaked
listening socket in a test stalled a two-hour run with no output. The suite now
runs under a timeout, a hang is its own outcome excluded from the denominator, and
the test servers are `unref`'d so a forgotten close cannot hold a process open.

### The one component the interface is built around

```js
figure({ value: '$3,600,000', source: 'USER_CONFIRMED' })
```

A number with its provenance attached by a drawn hairline: solid for confirmed from
a document, dashed for typed by hand, dotted for calculated. **A figure is never
shown naked**, anywhere, because the difference between "confirmed from the accounts"
and "somebody told us" is the difference this product sells.

The navigation is the data room's own numbered index, 00 to 12, in the order a
counterparty reads it. Four typefaces, each with exactly one job: Cinzel for the
wordmark only, Raleway for the interface, Source Code Pro for identifiers, and Lora
reserved for the documents so that an interface screenshot can never be mistaken for
an output.

### Two things the pages refuse to make easy

**Regeneration is two steps.** A button marked *Regenerate* that hands back a fresh
document is the obvious design and the wrong one. The useful question is never
"can I have a fresh copy" — it is what will be different, and whether anybody
outside the company is holding the old one. So the control opens a preview that
changes nothing, names which figures moved and which only changed source, and says
who has the previous version and when it went to them.

**A contradiction has no recommended side.** Two columns, identical width and
weight, no tick next to either, and the sentence *neither figure changes* on the
form. Settling a contradiction records which record you trust; correcting a number
is a separate deliberate act. A product that quietly "fixed" the loser would be
doing the one thing this one exists to prevent.

---

## Running it

```bash
npm test              # the full suite
npm run test:watch    # while editing
```

Requires Node 22.5 or later for `node:sqlite`. Nothing else.

### Serving it

```bash
STORAGE_SECRET=$(openssl rand -hex 32) \
  DATABASE_FILE=var/raiseroom.db STORAGE_DIR=var/objects \
  node --experimental-sqlite src/web/boot.js
```

Add `DEMO_SEED=1` against an empty database to load the worked example, an account
to sign in as, and two counterparty links. It refuses to seed a database that
already holds an account or an organisation, and it is refused outright when
`NODE_ENV=production` — invented figures and real ones in the same data room cannot
be told apart afterwards, including by the people reading the documents it produces.

**Three settings are fatal if missing in production**, and each is fatal because the
alternative is a deployment that looks like it is working:

| | |
|---|---|
| `STORAGE_SECRET` | download links are signed with it; a generated one invalidates every link in flight on every restart, and a default is the same as having none |
| `DATABASE_FILE` | the in-memory default is right for a test and catastrophic in production, where every organisation created since the last restart is gone and nobody is told |
| `STORAGE_DIR` | without it, documents are rows with nothing behind them |

In development all three default, loudly. A process that starts and then fails on
the first request is worse than one that refuses to start: the health check goes
green, the deploy is declared done, and the failure is found by a user.

### Checking a deployment from outside it

```bash
node tools/verify-demo.mjs https://your-deployment
```

Signs in with the demonstration account and drives the running application over
HTTP with nothing but the sign-in form and what the pages link to — which is what a
reviewer has. It opens every page, opens every generated document and checks there
are bytes behind it, parses the export, and confirms a signed-out visitor is turned
away. Exits non-zero, so it can be the last step of a deploy.

This is deliberately not a test. The suite builds its own server in-process and
knows where everything is; this catches the class of problem the suite cannot see —
storage pointed somewhere unwritable, a proxy stripping the session cookie, an
environment variable missing so that nine documents are rows that will not open. It
refuses to run against an organisation not marked as an illustrative example, on the
grounds that reading a real company's data room from a script would be wrong even
when the script means well.

For what the pages look like rather than what they return:

```bash
node --experimental-sqlite tools/proof-web.mjs out/web
```

Photographs every page at 1280px and at 420px, including the counterparty's view,
and fails on a horizontal scrollbar or a console error. HTML containing the right
strings can still look wrong: twice in this build a page passed every assertion and
was broken on screen, and both times the picture showed it in a second.

---

## Rules for anyone extending this

1. **A new rule goes in `src/domain/` as a pure function, with a test.** Not inside a handler.
2. **Resolve membership first, authorise, then touch rows** — and re-check `org_id` on every row fetched by id. Membership proves the caller belongs to org A, not that the row they asked for does.
3. **Every mutation writes an audit row.**
4. **Check new column names against `reserved-words.test.js`** — it will tell you, but check before writing the migration.
5. **Never add a fact source.** The enum is frozen. If something needs the AI to supply a figure, that requirement is wrong.
6. **Guidance goes in `criteria.js` with a source and a date** — never in a prompt. A prompt cannot be cited, dated or audited.
7. **Nothing a machine read becomes a fact without a human.** If a change would let extraction output reach the `fact` table on its own — a confidence threshold, a trusted document kind, a migration that backfills — that change is wrong, whatever it saves.
8. **Never type a figure into a document.** Everything numeric goes through `FactBinder`. A number written directly into a template is one the fact store cannot correct, cannot trace, and cannot keep consistent with the model.
9. **Look at the output before believing it.** `tools/proof-charts.mjs` for charts, `tools/worked-example.mjs` for whole documents, `tools/inkcheck.mjs` for the renderer. Three of this phase's bugs were invisible in the code and obvious on the page.
10. **Guidance goes in `corpus.js`, attributed and dated** — and never asserts what a counterparty requires, quotes a statistic, or names a vendor. `knowledge.test.js` enforces that, because prose drifts and the most authoritative-sounding sentence is usually the invented one.
11. **Nothing in `src/web/routes/` decides anything.** A handler resolves the organisation through `shell()`, calls a service function, and renders what comes back — including the refusal, in the words the rule's author wrote. `test/web.test.js` fails the suite if a route file calls `authorise`, resolves a membership, decides a 403, or writes a row. That test exists because the four bugs in the first implementation were all in handlers.
12. **A page that needs an external system says so when it is absent.** Never wire a stub in to make a page load. See `src/web/advisor.js` for the full argument; the short version is that a fake which refuses everything is indistinguishable from a real one with nothing to say, and the person evaluating your product will draw the worse conclusion.
13. **Run `node tools/mutate.mjs` after adding a rule.** A rule no mutation can break is a rule no test is protecting. Add the mutation alongside the rule; a surviving one is a missing test, except where it is genuinely unreachable, in which case say so in the mutation's own comment.

---

## Generating artifacts

```bash
node tools/worked-example.mjs       # a full set, HTML and PDF, in out/example/
node tools/proof-charts.mjs && node tools/render.mjs out/proof.html out/proof.pdf --size=a4
node tools/inkcheck.mjs             # did the ink actually land?
```

Needs Chromium, which the environment provides; `tools/render.mjs` finds it.

---

## Generating the Transfer Sheet

```bash
node tools/dump-fields.mjs > tools/fields.json      # field table, from the JS source
python3 tools/transfer_sheet.py out/RaiseRoom_Transfer-Sheet.pdf
python3 tools/make-fixture.py                        # refresh the test fixture
```

Needs `reportlab` and `pypdf`. Run all three whenever the field definitions
change — the last one is what makes a drift between the PDF and the parser fail
a test.

---

*TekAIDA Consulting. All twelve phases of the RaiseRoom specification, plus the workbook
onramp, the valuation-readiness pack, and the web application over them.*
