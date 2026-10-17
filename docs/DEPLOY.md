# Deploying RaiseRoom

Written for the developer who will run this, not for the person who wrote it.
Everything here is either a command you can run or a decision with its
consequences stated.

---

## The short version

```bash
cp .env.example .env
# fill in STORAGE_SECRET: openssl rand -hex 32
docker compose up -d
curl -s localhost:8080/health
```

That is a working deployment with no advisor, no translation and no checkout.
Every other capability works. Those three say so on their own pages, in a
sentence, rather than as a broken button — so the product can be evaluated
before any vendor account exists.

---

## What has to be true before it serves real customers

| | Why it matters |
|---|---|
| `STORAGE_SECRET` set and kept | Signs every upload and download link. Changing it invalidates every link currently in flight, including ones counterparties are holding. Generate once, store in your secret manager, do not rotate casually. |
| `BASE_URL` set | Share links and account email need absolute URLs. Without it links are relative, which works in a browser and does not work in an email. |
| TLS in front, `TRUST_PROXY=1` | The session cookie is marked `Secure` in production, so without TLS nobody can sign in. See the proxy note below — the flag is not cosmetic. |
| `/data` on a real volume with backups | It holds the database and every uploaded file. |
| `NODE_ENV=production` | Turns on the `Secure` cookie flag and HSTS, and refuses to load the worked example. |

### The proxy flag, specifically

`TRUST_PROXY=1` tells the application to read the client address from
`X-Forwarded-For` for rate limiting.

Set it **if and only if** something is terminating TLS in front of the process.

* With a proxy and the flag off: every visitor shares one bucket — the proxy's
  address — and the first twenty sign-in attempts of the day lock everybody out.
* Without a proxy and the flag on: anybody can send that header, so an attacker
  picks their own bucket and the rate limit is decoration.

There is no way to detect this at runtime. A request carrying that header looks
identical whether your load balancer wrote it or the caller did.

---

## The three things that are not wired

All three are in `server.mjs`, at the top, each with its contract written beside
it. That is the only file to edit. Do not scatter vendor names through `src/`.

### 1. A model provider — for the advisor and machine-drafted translations

Contract: `src/advisor/interface.js`. An implementation is an object with
`answer({ question, passages }) → { text }`.

What the caller already guarantees, so you do not have to:

* The question has been screened. One asking for a benchmark, a valuation or an
  introduction never reaches your code.
* The passages are the only material it may use. They come from the corpus in
  `src/knowledge/`, which is in git and versioned — not a prompt, not a table.
* The answer is validated after it returns against those passages, and an
  unsupported claim is rejected and retried once. A confident model cannot talk
  its way past that.

**What it must never receive:** the organisation's facts, documents or data
room. The privacy policy says a model provider is sent only the question text
and the corpus passages. That is a published commitment, not a preference.

`src/advisor/fake.js` is a deterministic implementation including every way a
model gets this wrong. Run your implementation against the same tests.

### 2. A translation provider

Contract: `src/translate/interface.js`.

The rule that matters is already enforced in `src/api/localisation.js`: every
figure is stripped from a passage before it is sent and put back after it
returns, and a translation that comes back containing a number is rejected. You
do not implement that and you must not work around it. It is why the privacy
policy can say a translation provider never holds a figure from a customer's
accounts.

### 3. Whop — checkout and the webhook

Contract: `src/billing/interface.js`. Four things:

* `checkoutUrl({ planKey, term, orgId })`
* `portalUrl({ providerRef })` — without it the plan page says cancellation is
  not available here, rather than linking to nothing.
* `verify({ rawBody, signature, headers })` — checked **before the body is
  parsed**. An unverified webhook is a way for anybody to grant themselves a
  plan.
* The plan mapping. The product's keys are `FREE`, `RAISEROOM`, `FIRM`; Whop's
  product ids are its own, and the mapping belongs in your implementation.

The webhook endpoint exists and is tested against a fake provider, including
replay and out-of-order delivery. What is missing is the signature check against
a real one.

### 4. An email provider

Nothing in the product sends mail yet. Invites are links you copy. When you wire
one, the addresses it needs are already recorded and the privacy policy already
names an email provider as a sub-processor — fill in the name.

---

## Backups

The whole of a customer's state is `/data`. Two files matter and they must be
backed up **together and consistently**.

**Use the command.** `tools/backup.mjs` does both halves in the order that makes
the gap between them harmless, verifies the snapshot it just took, and enforces
the 35-day retention the addendum promises. `tools/restore.mjs` puts one back and
refuses to overwrite a database that is already there. `deploy/README.md`
installs the nightly timer; `test/backup.test.js` is why they can be trusted.

```bash
docker compose exec -T app node tools/backup.mjs \
  --data-dir /data --dest /backups --retain-days 35

node tools/restore.mjs --from <a set> --data-dir /srv/raiseroom/data --dry-run
```

By hand, if you ever need to do it without them:

```bash
# database — use the SQLite backup API, never cp a live database file
docker compose exec app node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DATABASE_FILE);
  db.exec(\"VACUUM INTO '/data/backup.db'\");
  db.close();
"
# then ship /data/backup.db and /data/objects off the box
```

Copying a live SQLite file with `cp` can capture a torn write. `VACUUM INTO`
cannot.

**Test the restore.** The privacy policy says backups are tested; that sentence
is only true if somebody does it.

Retention: the data processing addendum says encrypted backups are overwritten
within 35 days. Configure that, because it is a contractual commitment.

---

## Scheduled jobs

One, and it is optional:

```bash
docker compose exec app node tools/usage.mjs --prune
```

Usage counters older than 24 months are deleted. The application already does
this once per process as a safety net, so a process that restarts occasionally
needs no cron at all. Add it if you have long-lived processes.

To read the analytics:

```bash
docker compose exec app node tools/usage.mjs --days 30
docker compose exec app node tools/usage.mjs --days 90 --json
```

There is deliberately no page for this in the product. See
`src/api/usage.js` for why.

---

## Postgres — read this before planning it

**Short answer: do not, yet. Ship on SQLite.**

The repository says a Postgres adapter replaces `src/db/sqlite.js` and nothing
else. That is true of the *SQL*, and it is the reason every query in the product
goes through a small adapter interface — `insert`, `get`, `find`, `findOne`,
`update`, `remove`, `count`, `range`, `ping`, `tables`, `columns` — with no raw
SQL anywhere above it, and a test that fails if a column is named with a word
either dialect reserves.

It is not true of the *shape*. `node:sqlite` is synchronous. There is no
production-grade synchronous Postgres client for Node, and there will not be
one. So a Postgres adapter makes every database call return a promise, which
makes:

* 443 call sites await,
* 161 synchronous service functions async,
* every route that calls them async,
* every one of 950 tests that calls them async.

That is a week of mechanical work with a long tail of subtle bugs, and it also
adds the product's first runtime dependency. It should be planned as a project,
with that cost stated, and not started because somebody assumed "swap the
adapter" meant an afternoon.

### What actually forces the move

Not traffic. One Node process on a modest box serves this product's workload
comfortably; the expensive operation is generating a document, which is
CPU-bound and unaffected by the database.

Two things force it, and you will know when:

1. **More than one application instance.** SQLite is a file; two processes
   writing it over a network filesystem corrupt it. The rate limiter is also
   per process, so two instances give an attacker twice the budget.
2. **Point-in-time restore.** If "restore to last night" is not good enough.

### What to do instead, for now

* For (2), run [Litestream](https://litestream.io) against the database file.
  It streams the write-ahead log to object storage and gives point-in-time
  restore without changing a line of code. This removes the commoner of the two
  reasons to move.
* For (1), scale the box before scaling the count.

### When you do it

* The adapter interface is the whole contract. Implement those eleven methods
  and nothing else; if you find yourself wanting a twelfth, add it to the
  interface rather than reaching past it.
* `db/schema.sql` is already portable — deliberately TEXT/INTEGER/REAL
  throughout, no reserved words, every identifier quoted.
* Convert bottom-up: adapter, then `src/api/`, then `src/web/`, then tests. The
  suite is the thing that makes this survivable; run it after every file.
* `tools/mutate.mjs` is the final check, not a background process. It rewrites
  source files in place, so nothing else can be running against the tree.

---

## Things not to break

These are enforced by tests. If a test in this list fails, the fix is not to
change the test.

| Invariant | Where |
|---|---|
| A non-member gets 404, never 403. 403 would confirm a company exists, and some are in confidential processes. | `src/domain/access.js` |
| `Fact.source` has no `AI_GENERATED` value and never will. The advisor cannot originate a number. | `src/domain/facts.js` |
| No code path reads across organisations. No aggregate, no benchmark, no cohort. | `src/api/portfolio.js` |
| An expired account is read-only with a full export, never locked out. | `src/api/billing.js` |
| Usage counters carry no organisation, no person, and nothing finer than a day. | `src/domain/usage.js` |
| Every generated page of a seeded organisation carries the illustrative notice, verbatim. | `src/domain/illustrative.js` |
| Guidance lives in git, never in a prompt and never in a table. | `src/knowledge/` |
| A document is only recorded as uploaded once its bytes are stored. | `src/web/routes/work.js` |

---

## Operating notes

* **Shutdown.** The process handles `SIGTERM`, stops accepting connections and
  lets requests in flight finish. Do not wrap it in a process manager that kills
  on the first signal — a request in flight may be halfway through a write.
* **Logs.** Unhandled failures print a reference the error page also shows, so a
  customer quoting "Reference a1b2c3d4" can be matched to a stack trace.
* **The worked example.** `DEMO_SEED=1` is refused outright when
  `NODE_ENV=production`. To demonstrate, load it from inside the product into an
  empty organisation.
* **Fonts.** Served by the application, never from a CDN. A font request to a
  third party tells that third party who is reading a diligence file and when.
  That is why `tools/fonts` is copied into the image and why the build fails if
  it is empty.
