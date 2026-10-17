# RaiseRoom — the phases, and what is left

*Revised 14 October 2026. All twelve phases are built, the valuation-readiness pack
is built, and there is a web application over them. What remains is below, under
**What is actually left**, and it is deliberately specific.*

---

## What changed, and why it changes the plan

The original plan treated the raise as the destination: prepare, generate, hand
over, done. The subscription then had to justify itself on a process that
happens once every two or three years, which is a hard subscription to defend
and an easy one to cancel.

The better framing is that both products run on the same spine — a fact store
with provenance — and the second one makes the first one work.

**The argument, in one move.** Criterion 2.4 asks whether forecast credibility
is demonstrable: the last three forecasts set against actuals, with variances
explained. The knowledge corpus already says the uncomfortable part out loud —
this is *impossible to produce retrospectively*. A company that did not keep its
forecasts cannot manufacture that history when a process starts. No consultant
can supply it, no competitor can generate it, and no amount of preparation in
the last eight weeks recovers it.

A company that has been running the cadence in RaiseRoom for eighteen months
arrives at a raise holding it.

That is the whole retention argument and the whole differentiation argument in
one feature, and it is why the forecast ledger displaces process management as
Phase 6.

### What this does not change

The architecture holds. Everything below is additive:

- facts stay immutable, with supersession and a frozen source enum;
- artifacts stay renderings of referenced facts, with no figure ever typed;
- the advisor stays bounded by what it may cite and what it may assert;
- no cross-organisation data, in any form, at any tier.

Where a new feature pulls against one of those, the feature changes shape. There
is one such case below, and it is dealt with explicitly rather than quietly.

---

## Phase 6 — The operating cadence *(built)*

**The retention engine. Build first.**

A monthly rhythm: enter actuals, see the trajectory move, explain the variance
while the reason is still fresh.

**What it adds**

- A **forecast ledger**. A forecast is *locked* when it is made — immutable,
  dated, versioned. Revising it writes a new version; the old one stays visible.
- **Actuals** entered monthly, as facts with periods. The fact store already
  supports this; no new storage shape is needed.
- **Variance**, computed, with the explanation captured *at the time* rather
  than reconstructed later.
- **Trajectory** — run rate, growth, runway — as `CALCULATED` facts with stored
  formulas and referenced inputs, so every derived figure stays auditable.
- A **forecast credibility report**, which is the artifact that satisfies 2.4.
- **Board pack** and **investor update** generation from the same facts.

**The rule that makes it work**

A forecast does not silently re-baseline when actuals arrive. If it did, there
would never be a fixed forecast to compare against, and the criterion this phase
exists to satisfy would be permanently unsatisfiable. Actuals update the
picture; the locked forecast stays locked.

**Why it comes first:** it is the only feature here that produces an asset that
cannot be bought later, and it starts accruing value the day it ships.

---

## Phase 7 — The living room *(built)*

**Cheap, because the references already exist.**

Every artifact already stores `fact_refs`. That is a dependency graph nobody has
walked yet.

**What it adds**

- **Staleness propagation**: superseding a fact marks exactly which artifacts
  are now out of date, and which pages within them.
- **Room freshness**: documents age against their own review intervals, building
  on the staleness machinery from Phase 2.
- **Change tracking**: what moved since a given date, in facts and in documents.
- **Recompute and regenerate**, in bulk, with a preview of what will change.

**Why it comes second:** it is nearly free given what is already stored, and
everything after it assumes a document knows whether it is current.

---

## Phase 8 — Live sharing *(built)*

**The clearest commercial differentiator, and the one incumbents do badly.**
Absorbs what was previously planned as process management.

**What it adds**

- **Per-recipient links** — never one shared URL — with expiry, revocation, and
  watermarking carrying the recipient's name.
- **A pinned version per view, with a visible "as at" date.**
- **Access logging**: who opened what, when, and for how long. This is
  criterion 8.3, satisfied as a by-product of use.
- **A question log** populated automatically by questions asked through the
  link. That is criterion 8.4, likewise.
- **Staged visibility** applied to links, reusing `visibleAtStage` from Phase 2.
- **Change notification** rather than silent replacement.

**The rule that makes it trustworthy**

A live document that changes under a reader is *worse* than a stale PDF. An
investor who read $3.6m on Tuesday and sees $3.4m on Thursday with no notice
reads that as concealment. So every view is pinned to a version, dated on its
face, and changes are announced rather than swapped in.

---

## Phase 9 — Brand *(built)*

Brought forward from Phase 10, where it sat beside localisation. It is cheap,
it gates the Enterprise tier, and it needed none of the advisor work.

**What it adds**

- **Brand tokens** derived from one accent colour: the accent as supplied for
  fills, a darkened variant for small text, a rule colour, a page wash, and an
  eight-colour chart palette.
- **The existing asset-quality gate applied to the logo**, checked at the widest
  placement a cover uses rather than the narrowest.
- **A RaiseRoom standard**, which is what an organisation that sets nothing
  renders in — unchanged from before the feature existed.

**The rule that makes it work: brand is an input, not an instruction**

A founder choosing brand colours is not a designer. Applied literally, the pale
mint from their website produces an eyebrow label nobody can read and a chart
palette of four indistinguishable pastels. So what renders is *derived* from
what they supply, every floor is checked rather than trusted, and **every
adjustment is reported** — an unexplained difference between the colour someone
gave and the one on the page is indistinguishable from the product being wrong.

**What the derivation guarantees**

- small text clears 4.5:1 against the page, rules and borders 3.0:1;
- body text on the derived wash clears 4.5:1;
- **adjacent chart colours differ in greyscale**, because data rooms get printed
  and printed in black and white more often than anyone designing them expects.

That last one is checked as a property across thousands of accents spanning the
whole colour space, not against a handful of examples. The first implementation
walked an HSL lightness ladder, which does not control greyscale at all: a mint
accent came out with 0.014 separation against a 0.08 floor — four identical
greys on paper — while passing every structural check.

**Stored twice, deliberately.** What the user supplied is the record of intent;
what was derived from it is the record of output. A document regenerated next
year comes out in the colours that were approved, not in whatever the contrast
logic does by then.

**Not retrospective.** Setting a brand does not restyle documents already
generated. Reissuing a document an investor has seen, in different colours,
under the same name, is worse than an inconsistent set of old PDFs.

---

## Phase 10 — The advisor acts *(built)*

Natural language in, a **proposed diff** out, a human confirms.

**What the advisor may do**

Create a folder, mark an item not applicable *with a reason*, assign a gap
owner, set a due date, request a document, reorder a register, draft prose into
a block.

**What the advisor may never do**

Write or change a fact value. The moment a model can set a number, the
`USER_ENTERED` source stops meaning what it says and the product's central claim
collapses. Numeric change always routes through the confirmation screen built in
Phase 3, which already exists and is already tested.

Every action writes an audit row, which is also what makes undo possible.

**How it was actually built**

- **A catalogue, not a permission list.** Ten action kinds, each declaring the
  exact columns it may write. An action outside it cannot be proposed because
  there is no code path that would accept one. No entry targets `fact`, and a
  test asserts that rather than a comment promising it.
- **Applying calls the ordinary service functions.** Not the database. This is
  the decision everything else rests on: the ten-character floor on a
  not-applicable reason, the membership check on a gap owner, the duplicate
  folder check — all of them live in the service layer, and an advisor path that
  writes rows is an advisor path where none of them run. So the advisor is a
  caller with no privileges, and a proposal refused at confirm time by a rule
  that did not apply at propose time is the design working.
- **A proposal is a statement about a moment.** It records the slice of the row
  it read, and refuses to apply if that moved — because the person pressing
  confirm is agreeing to a summary that was true when it was written. Narrowly
  scoped, though: only the fields the action reads or writes, because a product
  that cries stale at every unrelated edit teaches people to confirm without
  reading, which is the failure the check exists to prevent.
- **Undo compares against what the row became**, captured at apply time, not
  against what the proposal asked for. Those differ whenever a service function
  adjusted the write on the way in.
- **Prose takes the number rule.** It is the hole in the fence — every other
  action writes a structural field with a closed set of values, but prose is free
  text and free text can carry a figure. "Revenue grew to $4.2m" written into a
  deck is a fact value whatever table it sits in. The way through is
  `{{fact:your.key}}`, which resolves at render time and stays correct when the
  fact is superseded, which a typed number does not.
- **There is no `ADVISOR_WRITTEN` prose source**, exactly as `fact.source` has no
  `AI_GENERATED`. Drafted prose becomes `ADVISOR_DRAFTED_USER_APPROVED` when a
  named person confirms it, and is attributed to them.

---

## Phase 11 — Localisation *(built)*

Brand moved out of this phase and was built in Phase 9. What remained was
language.

**What it adds**

- **Five locales**: English (UK and US), French, German, Spanish. Stated, not
  implied — the brand faces carry Latin script only, so a Japanese or Arabic
  document set in them renders as empty boxes, and Arabic additionally needs the
  whole layout mirrored. Asking for one of those gets the real reason.
- **Figures and dates formatted by `Intl`** from the stored value, in every
  locale, every time a document renders.
- **Machine translation of prose**, which is **not usable until a person
  approves it** — the same shape as an unconfirmed extraction, and for a sharper
  reason: the person who would catch the mistake cannot read it.
- **A string catalogue in git**, written by hand. A locale is not offered until
  every string exists.

**How the central rule is enforced**

**A figure never passes through a translation model** — not instructed not to,
never given one. Fact references are masked before text leaves, restored after it
returns, and the result is discarded unless every marker came back exactly once.
A dropped marker leaves a blank; a duplicated one prints a figure twice; an
*altered* one produces a fluent, complete, plausible document carrying the wrong
company figure. All three are refused, not warned about.

**What made this phase possible was Phase 10.** Prose here cannot contain a
numeral — every figure is already a reference, enforced when the prose is
written — so the text handed to a translator contains no figures to corrupt. The
strictness that looked like pedantry two phases ago is the precondition for this
one existing at all.

**What is never machine translated**

Disclaimers, legal notices, confidentiality wording, and names. A mistranslated
liability limitation is a legal document that says something nobody drafted, and
a company registered under one name does not have another one in French. Number formats differ by locale (1.234,56 against
  1,234.56) and a model re-typing numbers reintroduces exactly the failure the
  architecture prevents. Locale formatting is a formatting function.

**Scoped honestly rather than promised universally**

The brand faces do not cover CJK, Arabic or Cyrillic, and Arabic needs
right-to-left layout. Legal and disclaimer text needs review per jurisdiction,
not machine translation. Start with three or four languages and say which.

---

## Phase 12 — Tiers, billing and portfolio *(built)*

- **Four plans on one spine**: Free, Prepare, Evidence, Enterprise. Evidence is a
  superset of Prepare, so moving from "we are raising" to "we are keeping
  records" never costs a feature.
- **No price is stored anywhere in this repository.** The billing provider holds
  the plan and what it costs. A price kept in two places disagrees eventually,
  and the copy that is wrong is always the one shown to the customer.
- **The $147 workbook credit**, applied exactly once, guarded twice: a unique
  index on the redemption, so a retry loses to the database rather than to a
  race, and an idempotent provider call keyed on the same redemption.
- **Nobody is ever locked out.** Expiry gates writing and nothing else. Reading
  and exporting work in every plan and every state, and the full export is new in
  this phase — the promise previously had nothing behind it.
- **A 14-day trial of the preparation plan**, computed from the organisation's
  creation date rather than stored, so it cannot be left switched on by a job
  that stopped running. *The length and the plan are commercial decisions and are
  the owner's to change; they live in one constant.*
- **Portfolio view**, consent-based and revocable, with **no cross-company
  aggregate of any kind**.

**The portfolio is the only route between two organisations in the product**, so
it is built as the exception that proves the rule rather than the hole that ends
it:

- the **company** invites the holder; there is no call anywhere that lets a
  holder add a company to its own portfolio;
- what is shared is a **named, fixed field set** the company can read before
  agreeing, filtered by construction rather than trimmed afterwards;
- it **never reaches a fact, a document or anything written** — an accelerator
  sees progress, not the accounts. A company wanting that adds those people as
  members in the ordinary way;
- there is **no median, cohort, benchmark or ranking**, and there will not be.
  Each company agreed to show a holder their own progress; none agreed to become
  a data point in somebody else's benchmark.

---

## Not a phase: valuation *(built, as described below)*

Requested, and reshaped rather than dropped, for three reasons that compound.

**It contradicts an invariant.** The advisor refuses valuation questions today
and tells the user why: *a valuation is a number, and the product does not
originate numbers about your business.* Adding an estimator makes that sentence
false, and every other provenance claim becomes marketing copy.

**Comparables need data the product should not hold.** "Compared to similar
businesses" requires cross-organisation reads, which are structurally impossible
here on purpose. A real comparables set also needs licensed transaction data
whose terms generally forbid redistribution in a tool.

**The regulatory exposure is specific to this company.** TekAIDA refers clients
to an investment bank for a fee. Software that tells a company what it is worth,
sold by a party connected to the firm that then advises on the transaction, is a
materially different proposition from a preparation tool. Valuation opinions
touch securities regulation in most jurisdictions and business appraisal is
licensed in some US states. **This needs a lawyer before it needs an engineer.**

### What gets built instead

**A valuation-readiness pack** — an addition to the Phase 5 catalogue, not a new
phase. Not *"you are worth $18m"* but *"here is the evidence a valuer will ask
for, and here are the five things in your records that will move whatever number
they land on"*: normalised earnings with the bridge evidenced, concentration and
its direction of travel, retention defined and reproducible, contract
transferability, key-person exposure.

All of it already exists in the product. It is defensible, it is more useful
than an estimate, and it sets up the referral honestly — the software prepares,
the humans value.

**Built as described.** `src/domain/valuation.js` holds the five evidence areas and
`src/api/valuation.js` the surface. What it took to keep the invariant intact is
worth recording: the feature asserts *nothing*. Every sentence it produces is a
property of the company's own records — this figure is present, this one is
missing, this area is evidenced or partly evidenced — and `test/valuation.test.js`
asserts structurally that no output of it contains a value judgement about worth.
The knowledge corpus already forbade valuation advice and vendor names, enforced by
`test/knowledge.test.js`, and that constraint turned out to be the design.

One research note, kept because it is the practical argument against naming
vendors: during this work the obvious third-party 409A provider to point founders
at announced it was shutting down. A product with that name hardcoded in its
guidance would now be giving dead advice. The pack describes what to look for in a
valuer instead of who to use.

**And an own-assumption calculator.** The founder enters the assumption — *"if
we were valued at 4× normalised earnings"* — and the app does the arithmetic
from their own confirmed figures. A `CALCULATED` fact, formula stored, inputs
referenced, assumption attributed to the user. That is a calculator, not an
opinion. Built, with the disclosure rendered next to the result rather than in a
footnote, and the multiple capped — an uncapped multiple is a way to make the
product print any number somebody wants to screenshot.

**Still needs a lawyer before launch.** Nothing above changed that. The reasoning
in the three paragraphs at the top of this section is unchanged; what changed is
that the engineering was done in a way that does not depend on the answer.

---

## The web application *(built)*

Last on purpose: a UI built over an incomplete service layer encodes the gaps as
screens. What the service layer had, the interface now reaches — all twelve phases,
82 routes, and a counterparty's page outside the sign-in entirely.

Two things about it belong in a roadmap rather than a README, because they change
what remains to be decided.

**The audit that mattered was not "does every phase have a page".** It was "which
exported service functions does no route ever call", and the answer the first time
was about a third of them — including the route that opens a share link, which did
not exist. A feature that is built, tested and unreachable is indistinguishable from
one that was never built, from the only position that counts: the user's. That check
is cheap and should be run again after anything is added below this layer.

**Four external systems are contracted and none is wired.** Extractor, advisor,
translator, payment provider. Each has a file in `src/web/` saying why a stub would
be worse than nothing, and each page says in one sentence that the capability is not
configured. This is the honest state to hand over in: a reviewer can tell what is
absent from what is poor, which they could not if a stub answered.

What this does *not* include, and what therefore still gates a launch, is unchanged
and listed below.

---

## What is actually left

Everything below is a decision or a configuration value, not a design question.
Each one blocks a launch rather than a build.

**Yours to supply.**

| | What for |
|---|---|
| Wyoming filing ID, suite number, ZIP | the entity block on the site and in the legal pack |
| Publication date | the legal pack's effective date |
| Lawyer sign-off | the refund and liability wording, and the valuation pack |
| Whop plan ids and signing secret | billing; the contract and webhook handling are built and tested against a fake |
| Analytics decision | whether there is any, and if so what it may see |
| Capital & M&A wording | the final positioning of the referral pillar |

**Yours to decide, and all three are commercial rather than technical.**

| | Currently | Why it is a decision |
|---|---|---|
| Trial length and plan | 14 days of *Prepare*, computed rather than stored | A trial of the evidence tier would show the thing nobody else can copy, and cost more to give away |
| Which capabilities sit in which plan | four tiers, in `src/domain/billing.js` | One table, one place; changing it changes no code |
| Seat counts | 2 / 5 / 10 / unlimited | Two people scoring the assessment separately is the most useful thing in the product, so a 2-seat floor is deliberate |

**Engineering that remains.**

- **Postgres.** `src/db/sqlite.js` is the only adapter and is one file. Nothing above it changes.
- **Email verification and password reset.** Both need a mail channel, which this product does not have.
- **Browser-side upload.** The presigned-upload contract is built and tested; the form that posts to the presigned URL is not written.
- **A real extractor.** The contract, the review state machine and the refusal path are built and tested against a deterministic fake. No model is wired, and the rule that no machine-read figure becomes a fact without a human is what makes that safe to defer.
- **A real advisor, translator and payment provider.** Same shape. Each has a file in `src/web/` explaining why a stub is worse than nothing, and each page says in a sentence that the capability is not configured.

---

## Order, and why it was built in this order

Kept as written at the time, because the reasoning is the useful part and it held.
The numbering drifted during the work — brand was pulled forward ahead of
localisation and the table below still carries the old numbers — which is recorded
rather than tidied, since the table is a record of a decision rather than an index.

| | Phase | Reason it sits here |
|---|---|---|
| 1 | **6 · Operating cadence** | The only asset that cannot be bought later. Starts accruing the day it ships. |
| 2 | **7 · Living room** | Nearly free given stored references; everything after assumes it. |
| 3 | **8 · Live sharing** | Clearest differentiator; generates two audit criteria as a by-product. |
| 4 | **10 · Brand** (brand only) | Cheap, highly visible, gates the Enterprise tier. Pulled forward ahead of localisation. |
| 5 | **9 · Advisor acts** | Needs the propose-and-confirm pattern; no new invariants. |
| 6 | **10 · Localisation** | Real work per language. Scope deliberately. |
| 7 | **11 · Tiers and portfolio** | Needs the two modes to exist before they can be priced. |
| 8 | **Valuation-readiness pack** | No engineering dependency on any of the above. Built in a way that does not depend on the legal answer. |
| 9 | **The web application** | Last on purpose. A UI built over an incomplete service layer encodes the gaps as screens. |

---

## What this means commercially

The product stops being bought for an event and starts being kept for a
practice. Two consequences worth deciding deliberately rather than drifting into:

**Positioning.** "Get ready to raise" is a campaign. "The system of record for
everything a counterparty will ask you" is a category. The second is harder to
sell in one line and much harder to leave.

**Pricing.** A preparation subscription and a continuing evidence subscription
are used at different intensities and should not cost the same. The workbook
credit applies to the first annual term of either.

**The moat, stated plainly.** Any competitor can prompt a model with fundraising
advice. None of them can hand a founder eighteen months of locked forecasts set
against actuals, with the variances explained at the time. That is not a feature
anyone can copy; it is a history, and it only exists if the product was there
while it happened.
