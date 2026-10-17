# The legal documents

Four documents are written and ready. They are **not in this repository**,
deliberately: they are living documents that get edited in review, and a copy in
a zip file is the copy that goes stale first. Each lives as a document you can
read, edit, comment on, and download as Markdown, Word or PDF.

| Document | Where | Status |
|---|---|---|
| Terms of service | <https://claude.ai/artifact/LTwKwDwgLYcjV4cG1r8z69> | Complete |
| Privacy policy | <https://claude.ai/artifact/CwbFKHoL44H5WqR6sUNWQw> | Complete |
| Data processing addendum | <https://claude.ai/artifact/1akZsW9Epe8c6KdQhq2XZo> | Complete |
| Pricing and tiers | <https://claude.ai/artifact/2uFHZqkMwbaQbHS2jdQfhE> | Complete |

Ask whoever handed you this project for access if a link does not open.

---

## Before any of them is published

### 1. Strip the working notes

Each document contains sections written **to the client, not to the customer** —
blockquotes beginning "A note for you, not for the terms", a section headed
"What still needs a person", and in the addendum a section headed "Decisions a
person still needs to make".

Those are deliberate: they say what was decided, what was left open, and why. **They
must not appear on the public page.** Keep them in the source document, delete
them from what you publish.

### 2. Fill four placeholders

The privacy policy and the addendum both name sub-processors, and four are
written as `[hosting provider]`, `[email provider]`, `[model provider]`, and a
note asking whether Whop is the only payment party. The hosting region is also a
placeholder — see the blockquote under *Where your data lives*, which argues for
EU hosting if that is still an open decision.

Send those four names back and they get filled in. Do not guess them.

### 3. Build `/subprocessors`

The privacy policy names `raiseroom.app/subprocessors` as **the authoritative
list**. That page does not exist yet. It has to exist before the policy is
published, or the policy points at a 404 on the one subject a reviewer checks.

---

## Where each one belongs

| | |
|---|---|
| `raiseroom.app/terms` | Linked from the footer of every page, from sign-up, and from checkout |
| `raiseroom.app/privacy` | Footer, sign-up |
| `raiseroom.app/dpa` | Footer, and offered by name in any enterprise sales conversation |
| `raiseroom.app/subprocessors` | Linked from the privacy policy and the addendum |

Effective date on the terms and the privacy policy: **31 October 2026**. If
launch moves, move both.

---

## Two standing rules

**No email address on the TekAIDA marketing site.** `support@raiseroom.app`
belongs in the RaiseRoom terms, in the product, and on the RaiseRoom site. It
does not go on `tekaida.consulting`, which has a standing rule against published
addresses because of competitor misuse.

**The Post Oak disclosure is one sentence, used verbatim, in three places** — the
terms, any page that names Post Oak, and the screen or email that actually makes
an introduction. The wording is in the terms document. It does not go in the site
footer: a connection disclosed everywhere is a connection nobody reads about
anywhere.

---

## What these documents commit you to operationally

Not legal reading — these are the sentences that create work for whoever runs
the service. Each is in `CHECKLIST.md` as a task.

| Commitment | Document | What it means |
|---|---|---|
| Answer rights requests within 30 days | Privacy policy | Somebody reads `support@raiseroom.app` |
| Notify a breach within 48 hours of becoming aware | Addendum | You need to know within 48 hours |
| Backups overwritten within 35 days | Both | Configure retention to match |
| Backups are tested | Privacy policy | Do a restore drill, for real |
| 30 days' notice before a new sub-processor | Both | A list, and a way to notify customers |
| 90 days' notice if the service shuts down | Addendum | A contractual term, not an intention |
| Usage data deleted after 24 months | Privacy policy | Already enforced in code |
| Dormant accounts deleted after 12 months + 60 days' notice | Addendum | Needs somebody to send those emails |
| Export works on every plan, including after cancellation | Terms | Already enforced in code and by tests |
