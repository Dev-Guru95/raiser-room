# RaiseRoom — dev team checklist

Tick-boxes for the work in `README.md`. Times are one developer, focused.

**Totals:** 7–9 developer-days · ~2 weeks calendar for one person · 4–5 days for
three people splitting tracks after Part 3.

> **Start 4.3 (email) first, whenever you plan to finish it.** Domain
> verification, DKIM and sender warm-up have a calendar lag that developer time
> does not shorten.

---

## Part 1 — Get it running · 2.5 h

- [x] Node 22.5+ installed, `node --version` confirms it *(10 min)* — 24.14.0
- [x] `npm test` → **950 tests, 950 pass** *(5 min)* — 858 at handover
- [x] Product runs locally with `DEMO_SEED=1` *(15 min)* — `/health` ok,
      `tools/verify-demo.mjs` green over HTTP
- [ ] Clicked the index rail 00 → 12 in order *(1 h)*
- [ ] Opened a generated document and saw that figures are references *(in above)*
- [ ] Opened a counterparty share link in a private window *(in above)*
- [ ] `node tools/mutate.mjs --file src/api/billing.js` → all caught *(30 min)*

## Part 2 — What you must not break · 1.5 h

- [ ] Read the invariants table in `README.md` *(15 min)*
- [ ] Read the full invariants table in `docs/PRODUCT.md` *(45 min)*
- [ ] Whole team understands: **a failing invariant test is never fixed by
      changing the test** *(30 min, discuss it)*

## Part 3 — Deploy · 1 day

`deploy/README.md` is this part in order, with the commands, and marks the four
steps that cannot be done from a developer machine. The files it installs —
compose override, Caddyfile, systemd timers, Litestream — are in `deploy/`.

- [ ] Host provisioned, `/data` volume ≥ 50 GB *(1 h)*
- [ ] DNS: `raiseroom.app` → host *(30 min)*
- [ ] TLS terminating in front; app still bound to `127.0.0.1:8080` *(1 h)*
- [ ] `.env` filled from `.env.example` *(30 min)*
  - [ ] `STORAGE_SECRET` generated **once** and stored in a secret manager
  - [ ] `BASE_URL=https://raiseroom.app`
  - [ ] `TRUST_PROXY=1` **only because TLS terminates in front**
  - [ ] `NODE_ENV=production`
- [ ] `docker compose up -d` *(15 min)*
- [ ] `/health` returns `{"ok":true,"state":"ok"}` *(15 min)*
- [ ] Manual smoke test end to end *(45 min)*
  - [ ] Sign up · create an organisation
  - [ ] Score an assessment
  - [ ] Upload a file and download it back
  - [ ] Generate a document
  - [ ] Create a share link and open it in a private window
  - [ ] Export everything
- [ ] Nightly backup of **database and `/data/objects` together** *(1 h)* —
      `tools/backup.mjs` and `deploy/raiseroom-backup.timer` are written and
      tested; installing the timer needs the host
- [x] Backup uses `VACUUM INTO`, not `cp` *(in above)* — and takes the database
      *before* the objects, which is the ordering argument in its header
- [ ] **Restored a backup onto a second host and signed in** *(1 h)* — the round
      trip is tested and was run end to end on one machine, including serving
      every page and document from the restored state. The second host is yours
- [x] Backup retention set to overwrite within 35 days *(15 min)* —
      `--retain-days 35`, the default, matching the addendum
- [ ] Litestream running *(1 h, recommended)* — `deploy/litestream.yml` written;
      needs a bucket and credentials

## Part 4 — Vendors · 3–4 days

### 4.1 Whop · 6–10 h

- [ ] Whop products created to match `FREE`, `RAISEROOM`, `FIRM`
- [ ] `checkoutUrl()` implemented
- [ ] `portalUrl()` implemented
- [ ] `verify()` checks the signature **before the body is parsed**
- [ ] Implementation passes the tests `src/billing/fake.js` passes
- [ ] Wired in `server.mjs` — and nowhere else
- [ ] End-to-end: subscribe, see the plan change, cancel, see it change back

### 4.2 Model provider · 6–10 h

- [ ] `answer({ question, passages })` implemented
- [ ] Confirmed it receives **only** the question and corpus passages
- [ ] Passes the tests `src/advisor/fake.js` passes
- [ ] Translation adapter implemented
- [ ] Confirmed figures are stripped before sending and restored after
- [ ] Wired in `server.mjs`
- [ ] Asked the advisor a question that should be refused, and it was

### 4.3 Email · 10–16 h · START EARLY

- [ ] Vendor account; domain verified; SPF, DKIM, DMARC published
- [ ] Sender warm-up started
- [ ] `src/email/interface.js` + fake + real implementation
- [ ] **Password reset flow built** — single-use, short-lived, hashed token
- [ ] Reset form reveals nothing about whether an address has an account
- [ ] Reset request route rate-limited via `src/web/throttle.js`
- [ ] Invite emails delivered rather than links copied by hand
- [ ] Wired in `server.mjs`
- [ ] Email provider name sent back for the privacy policy

## Part 5 — Before launch · 2.5–3 days

### 5.1 PDF export · 6–10 h · optional for launch

- [ ] Renderer in its own container with its own memory limit
- [ ] `pdf_key` written and a download route added
- [ ] `node tools/inkcheck.mjs` passes after any renderer change

### 5.2 Legal pages · 3–4 h

- [ ] Landing page built from `docs/landing/index.html`
- [ ] Terms of service published at a stable URL
- [ ] Privacy policy published
- [ ] Data processing addendum published
- [ ] **`/subprocessors` page created** — the policy names it as authoritative
- [ ] Linked from the footer, sign-up and plan pages
- [ ] Four names sent back: hosting, email, model provider, payment party
- [ ] **No email address published on the TekAIDA marketing site**

### 5.3 Monitoring · 3 h

The first three are implemented in `tools/watch.mjs` — one command, exit 0 or 1,
one JSON line per run for a log shipper. Point your monitoring at it:

```bash
node tools/watch.mjs --url https://raiseroom.app --data-dir /data
```

- [x] Alert: `/health` non-200 twice in a row *(`--state` file counts the run)*
- [x] Alert: `"state":"degraded"` (storage unusable — uploads failing silently)
- [x] Alert: `/data` above 80% *(`--disk-threshold` to change it)*
- [ ] **Wire it to something that wakes somebody** — cron, or an uptime check.
      `deploy/raiseroom-watch.timer` runs it every minute and
      `deploy/raiseroom-alert@.service` posts a webhook when it fails; it needs
      one Slack or PagerDuty URL in `/etc/raiseroom/alert.env`
- [ ] Logs shipped somewhere searchable and matchable by error reference
      *(the one condition `watch.mjs` cannot check; it reports it `unchecked`
      rather than passed, so a green run never implies it is done)*

### 5.4 QA pass · 6–8 h

- [ ] `npm test` green
- [ ] `node tools/mutate.mjs` — **all 279**, nothing else running *(2–3 h)*
- [ ] `node tools/proof-web.mjs` — no overflow reported
- [ ] `node tools/verify-demo.mjs` against the deployed instance
- [ ] Full path by hand on the deployment
- [ ] Checked on a phone
- [ ] Keyboard-only pass
- [ ] Screen reader on sign-in and assessment

### 5.5 Analytics · 30 min

- [ ] `node tools/usage.mjs --days 30` runs and reads sensibly
- [ ] Team knows the opt-out is on *Who can see this company*

## Part 6 — Launch · 0.5 day

- [ ] `raiseroom.app` pointed at production
- [ ] First real organisation created and walked end to end
- [ ] `support@raiseroom.app` exists **and somebody is reading it**
- [ ] Backup taken and restored **after real data exists**
- [ ] Monitoring alerts switched on

---

## Never do these

- [ ] Change a failing invariant test to make it pass
- [ ] Put a vendor name anywhere in `src/`
- [ ] Add an `org_id` to `usage_counter`
- [ ] Add an `AI_GENERATED` value to `Fact.source`
- [ ] Return 403 where the product returns 404 for a non-member
- [ ] Lock an expired account out of its own data
- [ ] Set `DEMO_SEED=1` in production *(it is refused, but do not try)*
- [ ] Run `tools/mutate.mjs` while anything else uses the working tree
- [ ] Start a Postgres migration without reading the section in `docs/DEPLOY.md`
