# RaiseRoom — developer handover

**Read this file top to bottom before touching anything. It is ordered so that
each step is runnable when you reach it.**

RaiseRoom is a capital-readiness application for companies preparing to raise
$1m–$25m or to sell. It is complete as software: 950 tests pass, every page
renders, and the whole product works today against a local database and local
file storage.

What it does not have is a deployment, three vendor integrations, and the
ability to send email. That is what this handover is about.

| | |
|---|---|
| **Total effort** | **7–9 developer-days** to a launchable deployment |
| **Calendar, one developer** | ~2 weeks including reviews |
| **Calendar, three developers** | ~4–5 days (tracks split after Step 5) |
| **Blocking you from day one** | Nothing. It runs locally in ten minutes. |

Estimates assume vendor accounts already exist and no new product scope. They
exclude waiting on vendors — email-domain verification and sender reputation in
particular have a calendar lag no amount of developer time shortens, so **start
Step 8 early even if you work on it late.**

---

## Contents

| | | Time |
|---|---|---|
| **Part 1** | [Get it running on your machine](#part-1--get-it-running) | 2.5 h |
| **Part 2** | [Understand what you must not break](#part-2--what-you-must-not-break) | 1.5 h |
| **Part 3** | [Deploy it](#part-3--deploy-it) | 1 day |
| **Part 4** | [Wire the three vendors](#part-4--wire-the-three-vendors) | 3–4 days |
| **Part 5** | [Fill the gaps before launch](#part-5--before-launch) | 2.5–3 days |
| **Part 6** | [Launch](#part-6--launch) | 0.5 day |
| | [What is deliberately absent](#what-is-deliberately-absent) | |
| | [Where everything lives](#where-everything-lives) | |

Two companion files:

* **`CHECKLIST.md`** — the same work as tick-boxes, for tracking.
* **`docs/DEPLOY.md`** — operational detail. Part 3 and Part 4 point into it.
* **`docs/PRODUCT.md`** — what the product is, every invariant, and where each
  one is proved. Reference, not reading.

---

## Part 1 — Get it running

**2.5 hours. Do this before reading anything else; the product explains itself
better than any document.**

### 1.1 — Prerequisites (10 min)

* **Node 22.5 or later.** `node --version`. Nothing else. No package manager
  install, no database server, no build step — the product has **zero runtime
  dependencies**.
* **Docker** with Compose, for Part 3 only.

### 1.2 — Run the test suite (5 min)

```bash
npm test
```

Expect `950 tests, 950 pass`. It takes about 45 seconds and touches no network.
(It was 858 at handover; the rest cover email, password reset, the legal pages,
the three vendor adapters, and the backup and restore commands added since.)

If this does not pass on a clean checkout, stop and say so — everything below
assumes a green tree.

### 1.3 — Run the product with the worked example (15 min)

```bash
DEMO_SEED=1 \
STORAGE_SECRET=$(openssl rand -hex 32) \
DATABASE_FILE=var/demo.db \
STORAGE_DIR=var/objects \
node --experimental-sqlite server.mjs
```

It prints an account to sign in as, a counterparty link that needs no account,
and the documents it generated. Open <http://localhost:8080>.

### 1.4 — Click through it (1 h)

Follow the index rail 00 → 12 in order. It is the product's argument in
sequence. Specifically, look at:

* **05 Figures** — every number has a source and a provenance. This is the
  product.
* **05a Contradictions** — two figures that disagree, shown level with no
  preferred side.
* **07 Documents out** — open a generated document. Every figure in it is a
  *reference* to a fact, not a copied value. That is why a deck and a model
  cannot disagree.
* **09 Sharing** — open the counterparty link in a private window. That is what
  an investor sees.
* **12c Who can see this company** — including what the product records about
  its own usage, and the switch that turns it off.

Every page of a seeded organisation carries the illustrative-example notice,
verbatim. That is enforced by a test; do not remove it.

### 1.5 — Break something on purpose (30 min)

```bash
node tools/mutate.mjs --file src/api/billing.js
```

This rewrites source files in place to break a rule, runs the suite, checks it
was noticed, and restores. 279 mutations exist; run a subset now and the whole
set before launch.

**Run it with nothing else going on.** It edits the working tree, so a
simultaneous `npm test` reports failures from whichever mutation is applied and
looks exactly like a broken repository.

---

## Part 2 — What you must not break

**1.5 hours of reading. Skipping this is the single most expensive thing you can
do on this project.**

Each row below is enforced by a test. **If one of these tests fails, the fix is
never to change the test.** They encode commitments made in the published terms,
privacy policy and data processing addendum — breaking one is a contractual
problem, not a code-style problem.

| Invariant | Where |
|---|---|
| A non-member gets **404, never 403**. A 403 confirms the company exists, and some customers are in confidential processes. | `src/domain/access.js` |
| `Fact.source` is a frozen enum with **no `AI_GENERATED`**. The AI never originates a number. | `src/domain/facts.js` |
| Facts are **immutable**; a correction supersedes and both are kept. | `src/api/service.js` |
| **No code path reads across organisations.** No aggregate, no benchmark, no cohort, no "companies like yours". | `src/api/portfolio.js` |
| An **expired account is read-only with a full export**, never locked out. | `src/api/billing.js` |
| **Usage counters carry no organisation, no person, nothing finer than a day.** | `src/domain/usage.js` |
| A document is **only recorded as uploaded once its bytes are stored**. | `src/web/routes/work.js` |
| Guidance lives **in git**, never in a prompt and never in a database table. | `src/knowledge/` |
| Every generated page of a seeded organisation carries the **illustrative notice**, verbatim. | `src/domain/illustrative.js` |
| **No figure is typed into a generated document** — all are fact references. | `src/render/blocks.js` |
| Bytes **never pass through the application**; uploads and downloads are presigned. | `src/api/service.js` |

The full table — about sixty rows, each with the file that enforces it and the
test that proves it — is in `docs/PRODUCT.md`. Read that table once.

### The architecture in four sentences

1. The service layer takes `(ctx, input)` and returns `{ status, body }`. No
   `Request`, no `Response`, no framework import.
2. Rules live in `src/domain/` as pure functions and are tested without a
   server, a session or a network.
3. The web layer is thin: it maps HTTP to service calls and renders. It makes no
   authorisation decisions of its own.
4. Every database call goes through a small adapter interface — eleven methods,
   no raw SQL above it — so the storage engine is one file.

---

## Part 3 — Deploy it

**1 day. After Step 3.3 the work can split across people; see the tracks at the
end of this part.**

### 3.1 — Provision (2–3 h)

One Linux host. This product is built for one process on one box, deliberately —
see *Postgres* in `docs/DEPLOY.md` before anyone proposes otherwise.

* DNS: `raiseroom.app` → the host.
* TLS in front of it. Caddy is two lines and renews itself; nginx is fine too.
* A volume mounted at `/data` with at least 50 GB.

The container binds to `127.0.0.1:8080` on purpose. Whatever terminates TLS
reaches it there; nothing else should.

### 3.2 — Configure (1 h)

```bash
cp .env.example .env
```

Fill in, and read the comment above each one — none of them is cosmetic:

| | |
|---|---|
| `STORAGE_SECRET` | `openssl rand -hex 32`. Signs every upload and download link. Changing it invalidates every link in flight, **including ones counterparties are holding**. Generate once; put it in your secret manager; do not rotate casually. |
| `BASE_URL` | `https://raiseroom.app`. Without it, links are relative — which works in a browser and does not work in an email. |
| `TRUST_PROXY=1` | **Only because you put TLS in front in 3.1.** With a proxy and this off, every visitor shares one rate-limit bucket and the first twenty sign-in attempts of the day lock everybody out. With no proxy and this on, an attacker picks their own bucket and the limit is decoration. This cannot be detected at runtime. |
| `NODE_ENV=production` | Turns on the `Secure` cookie flag and HSTS, and refuses to load the worked example. |

### 3.3 — Start it and prove it works (1 h)

```bash
docker compose up -d
curl -s https://raiseroom.app/health
```

Expect `{"ok":true,"state":"ok",...}`. `/health` runs a real query and checks the
schema — it does not simply report that the process started. `"degraded"` means
it serves but file storage is unusable.

Then, by hand: sign up, create an organisation, score an assessment, upload a
file, download it back, generate a document, create a share link, open it in a
private window, export everything.

### 3.4 — Backups, and a restore you have actually done (2 h)

```bash
docker compose exec app node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DATABASE_FILE);
  db.exec(\"VACUUM INTO '/data/backup.db'\");
  db.close();
"
```

`cp` on a live SQLite file can capture a torn write. `VACUUM INTO` cannot. Ship
`/data/backup.db` **and `/data/objects`** off the box together — a database
without its files is a list of documents nobody can open.

Then **restore it onto a second host and sign in.** The privacy policy says
backups are tested. That sentence is only true once somebody has done this.

Set the retention to overwrite within 35 days: the data processing addendum
commits to that figure.

### 3.5 — Add Litestream (1 h, recommended)

[Litestream](https://litestream.io) streams the write-ahead log to object
storage and gives point-in-time restore with no code change. It removes the
commoner of the two reasons anyone would reach for Postgres.

### Splitting the work from here

| Track | Who | Steps |
|---|---|---|
| **A — payments** | Backend | 4.1 |
| **B — model provider** | Backend | 4.2 |
| **C — email** | Backend + frontend | 4.3 — **start first**, it has vendor lag |
| **D — site and legal** | Frontend | 5.2 |
| **E — monitoring, QA** | QA | 5.3, 5.4 |

---

## Part 4 — Wire the three vendors

**3–4 days.** All three live in **`server.mjs`**, at the top, each with its
contract written beside it. **That is the only file to edit.** Do not scatter
vendor names through `src/` — a vendor compiled into the application is a vendor
nobody can change without a code review.

Leave any of them null and the product still runs; the pages concerned say so in
a sentence rather than offering a broken button. That is deliberate, so the
product can be evaluated before any vendor account exists.

### 4.1 — Whop: checkout and the webhook (6–10 h)

Contract: `src/billing/interface.js`. Four things:

* `checkoutUrl({ planKey, term, orgId })`
* `portalUrl({ providerRef })` — without it the plan page says cancellation is
  not available here rather than linking to nothing.
* `verify({ rawBody, signature, headers })` — **checked before the body is
  parsed.** An unverified webhook is a way for anybody to grant themselves a
  plan.
* The plan mapping. The product's keys are `FREE`, `RAISEROOM`, `FIRM`; Whop's
  product ids are its own, and the mapping belongs in your implementation.

The webhook endpoint already exists and is tested against a fake provider,
including replay and out-of-order delivery. What is missing is the signature
check against a real one. `src/billing/fake.js` is the reference; run your
implementation against the same tests.

**Plans and prices are already configured** in `src/domain/billing.js`: Free,
RaiseRoom and Firm, 10 seats, 7-day trial on the RaiseRoom plan. Create the Whop
products to match rather than changing the code.

### 4.2 — A model provider: the advisor and translations (6–10 h)

Contract: `src/advisor/interface.js`. An implementation is an object with
`answer({ question, passages }) → { text }`.

**What the caller already guarantees, so you do not have to:**

* The question has been screened. One asking for a benchmark, a valuation or an
  introduction never reaches your code.
* The passages are the only material it may use. They come from the corpus in
  `src/knowledge/`, which is versioned in git.
* The answer is validated after it returns against those passages, and an
  unsupported claim is rejected and retried once. A confident model cannot talk
  its way past that.

**What it must never receive:** the organisation's facts, documents or data
room. The privacy policy states that a model provider is sent only the question
text and the corpus passages. That is a published commitment.

`src/advisor/fake.js` is a deterministic implementation including every way a
model gets this wrong. Point your implementation at those tests.

**Translation** uses the same provider through
`src/translate/interface.js`. The rule that matters is already enforced in
`src/api/localisation.js`: every figure is stripped from a passage before it is
sent and restored after it returns, and a translation that comes back containing
a number is **rejected**. Do not implement that and do not work around it — it
is why the privacy policy can say a translation provider never holds a figure
from a customer's accounts.

### 4.3 — An email provider (10–16 h) — start this first

**Nothing in the product sends mail today.** This is the largest genuine gap and
the one with vendor lag, so begin it even if you finish it last.

Three things need building, in this order:

1. **The sending adapter.** A new `src/email/interface.js` + implementation,
   following the shape of `src/advisor/interface.js` — a contract, a fake for
   tests, and the real one wired in `server.mjs`.
2. **Password reset.** There is no reset flow at all: a signed-in person can
   change their password (`/account/password`), and somebody locked out cannot
   get back in. You need a single-use, short-lived, hashed token, the same
   "reveals nothing about whether the address exists" behaviour the sign-in form
   already has, and rate limiting on the request route — reuse
   `src/web/throttle.js`, which already has the shape.
3. **Invite delivery.** Invites exist and work; today the link is copied by hand.

Vendor-side, and the reason to start early: domain verification, SPF, DKIM and
DMARC records, plus sender warm-up. None of it is hard and none of it is fast.

Then fill in `[email provider]` in the privacy policy, which already names one
as a sub-processor.

---

## Part 5 — Before launch

**2.5–3 days, parallelisable.**

### 5.1 — PDF export of generated documents (6–10 h, optional for launch)

Documents generate as HTML and are readable, shareable and printable today.
PDF rendering exists as a tool — `tools/render.mjs`, headless Chromium — and is
**not wired into the application**: the artifact row reserves a `pdf_key` and
nothing writes to it.

If you wire it: put the renderer in its own container with its own memory limit.
A renderer that runs out of memory should not take the web process down with it,
which is why the application image deliberately contains no browser.

`tools/inkcheck.mjs` exists because a candidate renderer once silently dropped
every gradient-filled shape and produced a chart with two of three bars missing.
It rasterises output and asserts ink landed where the chart said. Run it after
any renderer change.

### 5.2 — Legal pages on the site (3–4 h)

Four documents are written and ready. They need publishing at stable URLs and
linking from the footer, sign-up and plan pages:

* Terms of service
* Privacy policy
* Data processing addendum
* `/subprocessors` — **this page does not exist yet.** The privacy policy names
  it as the authoritative list, so it has to exist before launch.

Four placeholders in those documents need real names before publishing: the
hosting provider, the email provider, the model provider, and confirmation that
Whop is the only payment party. Send those four names back and they get filled
in.

**Do not publish an email address anywhere on the TekAIDA marketing site.**
`support@raiseroom.app` is for the RaiseRoom product, its terms and the
RaiseRoom site only.

### 5.3 — Monitoring (3 h)

* Alert on `/health` returning non-200 for 2 consecutive checks.
* Alert on `"state":"degraded"` — it means file storage is unusable, so uploads
  and generation are failing while everything else looks fine.
* Alert on disk above 80% of the `/data` volume.
* Ship application logs somewhere searchable. An unhandled failure prints a
  reference that the error page also shows, so a customer quoting
  "Reference a1b2c3d4" can be matched to a stack trace.

### 5.4 — A full QA pass (6–8 h)

```bash
npm test                    # 950 tests, ~45 s
node tools/mutate.mjs       # all 279 mutations, 2–3 h, nothing else running
node tools/proof-web.mjs    # screenshots every page at two widths
node tools/verify-demo.mjs  # drives a running deployment over HTTP from outside
```

`proof-web.mjs` reports horizontal overflow. Three real bugs in this build were
found only by looking at the screenshots and were invisible to every assertion.

By hand, on the deployed instance: the full upload → extract → confirm → generate
→ share → export path, on a phone as well as a desktop, with keyboard only, and
with a screen reader on the sign-in and assessment pages.

### 5.5 — Operational analytics (30 min)

```bash
docker compose exec app node tools/usage.mjs --days 30
```

Which capabilities are used, which nobody touches, where the product refuses
people and what is slow. There is deliberately no page for this inside the
product; `src/api/usage.js` explains why. Counters hold no organisation and no
person, and an owner can switch recording off on *Who can see this company*.

---

## Part 6 — Launch

**0.5 day.**

1. Point `raiseroom.app` at production.
2. Create the first real organisation and walk the whole path once as a customer.
3. Confirm `support@raiseroom.app` exists and somebody is reading it. The privacy
   policy promises a 30-day answer on rights requests and a 72-hour breach
   notification; both are normal and both are only true if the mailbox is read.
4. Take a backup, and restore it, after real data exists.
5. Turn monitoring alerts on.

---

## What is deliberately absent

Not oversights. Each is a decision with a reason, and reversing one needs a
conversation, not a commit.

| Absent | Why |
|---|---|
| Benchmarks, medians, "companies like yours" | No code path reads across organisations. This is the product's central promise, it is in the privacy policy, and tests fail if anybody adds one. |
| An admin console over customer data | There is no staff role. The operational report is a command, not a page, so there is no authorisation rule to get wrong. |
| Auto-confirmation of extracted figures | Confidence gates nothing. A figure becomes usable only when a person confirms it, which is the whole provenance claim. |
| AI-written numbers | `Fact.source` has no `AI_GENERATED` value. The advisor proposes structure, never figures. |
| Locking out an expired account | Read-only with a full export, forever. Holding a company's diligence file to collect an invoice is not a thing this product does. |
| A dependency tree | Zero runtime dependencies. Every one added is a supply-chain surface in a product holding companies' financial records. |

---

## Where everything lives

```
server.mjs              The production entry point. The ONLY file you edit to
                        wire a vendor.
Dockerfile              One stage. No build step — there is nothing to build.
compose.yaml            One process, SQLite on a volume, files on a volume.
.env.example            Every setting, with the consequence of getting it wrong.

db/schema.sql           Canonical schema. Portable SQL — SQLite and Postgres.
src/domain/             The rules. Pure functions, no I/O, exhaustively tested.
src/api/                The service layer. (ctx, input) → { status, body }.
src/web/                HTTP, sessions, CSRF, headers, rendering. Thin.
src/db/sqlite.js        The storage adapter. Eleven methods. Swap this file.
src/knowledge/          The guidance corpus, versioned, with attribution.
src/advisor/            Advisor contract + a deterministic fake.
src/billing/            Billing contract + a deterministic fake.
src/translate/          Translation contract + a deterministic fake.
src/render/             Document rendering: blocks, charts, theme.

test/                   950 tests. Run with `npm test`.
tools/mutate.mjs        279 mutations. The final check before handover.
tools/proof-web.mjs     Screenshots every page. Finds what assertions cannot.
tools/usage.mjs         The operational analytics report.
tools/watch.mjs         The monitoring probe: /health, degraded storage, disk.
tools/backup.mjs        Nightly backup: VACUUM INTO, then the objects. Verified.
tools/restore.mjs       Puts one back, and refuses to overwrite without --force.
tools/render.mjs        HTML → PDF. Not wired into the app yet.

deploy/                 What goes on the host: compose override, Caddyfile,
                        systemd timers, Litestream. Start at deploy/README.md.

src/email/              Email contract, catalogue of messages, and a fake.
src/billing/whop.js     The payment adapter. Needs keys; see server.mjs.
src/advisor/anthropic.js  The advisor and translator adapter. Needs a key.

docs/landing/           The raiseroom.app landing page, served at `/`.
docs/legal/             Where the four legal documents live, and what they oblige.
docs/QC.md              What was verified before handover, and how.
docs/DEPLOY.md          Operational detail, backups, and the Postgres question.
docs/PRODUCT.md         What the product is, and every invariant with its proof.
docs/ROADMAP.md         What was planned and what was built.
CHECKLIST.md            This work as tick-boxes.
```

---

## If you take one thing from this document

The tests are not a quality gate bolted on afterwards. They are where the
product's promises live. Sixty of them encode something the company has told a
customer in writing — that a competitor cannot learn they exist, that an AI
never invented a figure in their deck, that their data room is theirs after they
stop paying.

When one fails, something that was promised has stopped being true. Find out
which promise before you decide what to do about it.
