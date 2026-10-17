-- RaiseRoom — canonical schema
--
-- PORTABILITY RULE (learned the hard way):
-- No column may be named with a word reserved in SQLite. A column named `index`
-- shipped in the first build and broke organisation setup entirely on Cloudflare
-- D1 with: D1_ERROR: near "index": syntax error.
-- test/reserved-words.test.js enforces this automatically. Do not disable it.
--
-- Types are deliberately portable: TEXT / INTEGER / REAL work on both SQLite
-- (tests) and Postgres (production).

CREATE TABLE IF NOT EXISTS organisation (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL DEFAULT 'UNDECIDED',   -- RAISE | SALE | UNDECIDED
  currency       TEXT NOT NULL DEFAULT 'USD',
  target_amount  INTEGER,                              -- minor units, nullable
  -- Usage analytics. `usage_analytics = 0` is the objection the privacy policy
  -- grants, honoured by the code rather than by somebody remembering. `tried`
  -- is the set of capability keys this organisation has ever used, kept here —
  -- with the organisation, deleted with it — so that first-time adoption can be
  -- counted without the counter table ever holding an organisation's identity.
  usage_analytics INTEGER NOT NULL DEFAULT 1,
  tried           TEXT,                                -- JSON array of capability keys
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS membership (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  email       TEXT,
  role        TEXT NOT NULL,                           -- OWNER | EDITOR | VIEWER
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_membership_org  ON membership (org_id);
CREATE INDEX IF NOT EXISTS ix_membership_user ON membership (user_id);

CREATE TABLE IF NOT EXISTS invite (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  invited_by  TEXT,
  claimed_at  TEXT,
  claimed_by  TEXT,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_invite_email ON invite (email);

-- The fact store. Rows are IMMUTABLE: a correction writes a new row and sets
-- superseded_by on the old one. Nothing is ever edited in place.
CREATE TABLE IF NOT EXISTS fact (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  fact_key        TEXT NOT NULL,          -- not `key`: safe in SQLite, reserved in some engines
  label           TEXT NOT NULL,
  value_numeric   REAL,
  value_text      TEXT,
  value_date      TEXT,
  unit            TEXT,
  period_start    TEXT,
  period_end      TEXT,
  source          TEXT NOT NULL,          -- see src/domain/facts.js — no AI_GENERATED
  source_doc_id   TEXT,
  source_page     INTEGER,
  formula         TEXT,                   -- CALCULATED only
  input_fact_ids  TEXT,                   -- CALCULATED only, JSON array
  confirmed_at    TEXT,
  confirmed_by    TEXT,
  superseded_by   TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fact_org ON fact (org_id);
CREATE INDEX IF NOT EXISTS ix_fact_key ON fact (org_id, fact_key);

CREATE TABLE IF NOT EXISTS document (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  filename           TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  storage_key        TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  -- INTERNAL | EXTERNAL. A figure read out of an EXTERNAL document is a claim
  -- about the world rather than about this company, and carries the heavier
  -- citation rules in src/domain/evidence.js.
  provenance_class   TEXT NOT NULL DEFAULT 'INTERNAL',
  extract_state      TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD',
  data_room_node_id  TEXT,
  uploaded_by        TEXT NOT NULL,
  uploaded_at        TEXT,               -- set when the client confirms the PUT
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_document_org ON document (org_id);

CREATE TABLE IF NOT EXISTS data_room_node (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  parent_id   TEXT,
  sort_key    TEXT NOT NULL,             -- WAS `index`. Never reintroduce that name.
  name        TEXT NOT NULL,
  required    INTEGER NOT NULL DEFAULT 0,
  stage       TEXT NOT NULL DEFAULT 'PRE_MEETING',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_node_org ON data_room_node (org_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  metadata     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_org ON audit_log (org_id);

-- ─────────────────────────────────────────────────── Phase 1: assessments ──

CREATE TABLE IF NOT EXISTS assessment (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  label           TEXT,                        -- "Baseline", "30-day re-score"
  scores          TEXT NOT NULL,               -- JSON: criterion ref -> 0..5
  total_weighted  REAL,
  band            TEXT,                        -- READY|NEARLY|NOT_YET|EARLY|BLOCKED
  capped          INTEGER NOT NULL DEFAULT 0,
  findings        TEXT,                        -- JSON: hard-rule findings
  is_complete     INTEGER NOT NULL DEFAULT 0,
  scored_by       TEXT NOT NULL,
  second_scorer   TEXT,                        -- blind second pass, for divergence
  completed_at    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assessment_org ON assessment (org_id);

CREATE TABLE IF NOT EXISTS gap (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  assessment_id  TEXT,
  criterion_ref  TEXT NOT NULL,
  domain         INTEGER NOT NULL,
  score          INTEGER,
  category       TEXT NOT NULL,                -- BLOCKER|LONG_LEAD|THIRD_PARTY|CHEAP|ROOM
  description    TEXT NOT NULL,
  done_when      TEXT NOT NULL,
  owner_user_id  TEXT,
  due_date       TEXT,
  closed_at      TEXT,
  closed_by      TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_gap_org ON gap (org_id);
CREATE INDEX IF NOT EXISTS ix_gap_open ON gap (org_id, closed_at);

-- ──────────────────────────────────────────────── Phase 2: room checklist ──

CREATE TABLE IF NOT EXISTS data_room_item (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  node_id       TEXT NOT NULL,            -- the folder it belongs to
  item_ref      TEXT NOT NULL,            -- "04.2"
  name          TEXT NOT NULL,
  required      INTEGER NOT NULL DEFAULT 0,
  document_id   TEXT,                     -- satisfied by this document
  not_applicable INTEGER NOT NULL DEFAULT 0,
  na_reason     TEXT,                     -- three-state: present | N/A with reason | missing
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_item_org ON data_room_item (org_id);
CREATE INDEX IF NOT EXISTS ix_item_node ON data_room_item (node_id);

-- Records a workbook purchase redeemed into an organisation: the seed data and
-- the credit against an annual subscription. See docs/ONRAMP.md.
CREATE TABLE IF NOT EXISTS workbook_redemption (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  receipt_ref     TEXT NOT NULL,          -- the purchase reference, verified upstream
  credit_minor    INTEGER NOT NULL,       -- 14700 = $147.00
  credit_currency TEXT NOT NULL DEFAULT 'USD',
  facts_seeded    INTEGER NOT NULL DEFAULT 0,
  redeemed_by     TEXT NOT NULL,
  redeemed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_redemption_receipt ON workbook_redemption (receipt_ref);

-- ──────────────────────────────────────── Phase 3: extraction and conflicts ──

-- One row per extraction run over one document, by one named extractor version.
-- The extractor identity is stored because "which model read this" is part of
-- the provenance of anything the run produced.
CREATE TABLE IF NOT EXISTS extraction (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  document_id         TEXT NOT NULL,
  extractor_id        TEXT NOT NULL,
  extractor_version   TEXT NOT NULL,
  doc_kind            TEXT NOT NULL,     -- the kind it was read AS
  state               TEXT NOT NULL,     -- RUNNING|NEEDS_REVIEW|REVIEWED|UNSUPPORTED|FAILED
  unsupported_reason  TEXT,
  pages               INTEGER,
  text_characters     INTEGER,
  candidate_count     INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  reviewed_at         TEXT,
  reviewed_by         TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_extraction_org ON extraction (org_id);
CREATE INDEX IF NOT EXISTS ix_extraction_doc ON extraction (document_id);

-- Candidate facts. DELIBERATELY NOT IN THE `fact` TABLE.
--
-- Extraction output is a proposal, not a fact. Nothing a machine read reaches
-- the fact store until a human confirms it, and `test/extraction.test.js`
-- asserts that no Phase 3 code path writes a fact row with source
-- DOCUMENT_EXTRACTED. `locator` is the verbatim text or cell reference the
-- candidate was read from — the thing the reviewer checks the figure against.
CREATE TABLE IF NOT EXISTS extraction_candidate (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  extraction_id  TEXT NOT NULL,
  document_id    TEXT NOT NULL,
  fact_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  value_numeric  REAL,
  value_text     TEXT,
  value_date     TEXT,
  unit           TEXT,
  period_start   TEXT,
  period_end     TEXT,
  source_page    INTEGER,
  locator        TEXT NOT NULL,          -- verbatim snippet or cell reference
  confidence     REAL,                   -- the extractor's own number. ADVISORY ONLY.
  state          TEXT NOT NULL DEFAULT 'AWAITING_REVIEW',
  viewed_at      TEXT,
  decided_at     TEXT,
  decided_by     TEXT,
  reject_reason  TEXT,
  fact_id        TEXT,                   -- the fact it became, once confirmed
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_candidate_org ON extraction_candidate (org_id);
CREATE INDEX IF NOT EXISTS ix_candidate_run ON extraction_candidate (extraction_id);

-- A detected contradiction between two sources. Both sides are kept; the
-- product never picks a winner on the user's behalf.
CREATE TABLE IF NOT EXISTS conflict (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  rule_ref         TEXT NOT NULL,        -- which detection rule fired
  kind             TEXT NOT NULL,        -- VALUE_MISMATCH|UNIT_MISMATCH|CROSS_KEY|PERIOD_CLASH
  severity         TEXT NOT NULL,        -- HIGH|MEDIUM|LOW
  left_ref         TEXT NOT NULL,        -- "fact:<id>" or "candidate:<id>"
  left_summary     TEXT NOT NULL,
  right_ref        TEXT NOT NULL,
  right_summary    TEXT NOT NULL,
  detail           TEXT NOT NULL,        -- the sentence shown to the user
  resolved_at      TEXT,
  resolved_by      TEXT,
  resolution       TEXT,                 -- LEFT|RIGHT|NEITHER
  resolution_note  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conflict_org  ON conflict (org_id);
CREATE INDEX IF NOT EXISTS ix_conflict_open ON conflict (org_id, resolved_at);

-- ───────────────────────────────────── Phase 3: timing instrumentation ──────
--
-- This exists so that any future claim about how long preparation takes can be
-- a measurement rather than a guess. First occurrence wins: a milestone reached
-- twice was reached once. See src/domain/timing.js.
CREATE TABLE IF NOT EXISTS timing_event (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  milestone    TEXT NOT NULL,
  clock        TEXT NOT NULL,            -- A = work inside the app, B = calendar time
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_timing_org_milestone ON timing_event (org_id, milestone);

-- ────────────────────────────────────────────────── Phase 4: the advisor ──
--
-- Guidance itself is NOT in this schema. It lives in src/knowledge/corpus.js,
-- in git, where a change to what the product tells people arrives as a diff in
-- a pull request with an author and a date. A guidance table would let the
-- advice change without a code review, which is the opposite of what
-- "citable" means.
--
-- What is stored here is the conversation: every question, the answer, and the
-- exact citations behind it — so "why did the app tell me that" is answerable
-- six months later, by someone who was not there.

CREATE TABLE IF NOT EXISTS advisor_thread (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  closed_at   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_thread_org ON advisor_thread (org_id);

CREATE TABLE IF NOT EXISTS advisor_message (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  question          TEXT NOT NULL,
  answer_text       TEXT,                  -- rendered from the draft, never free prose
  draft             TEXT,                  -- JSON: the structured claims as returned
  citations         TEXT,                  -- JSON: every ref the answer leans on
  refused           INTEGER NOT NULL DEFAULT 0,
  refusal_code      TEXT,
  rejected_reason   TEXT,                  -- set when a draft failed validation
  advisor_id        TEXT NOT NULL,         -- which model answered
  advisor_version   TEXT NOT NULL,
  knowledge_version TEXT NOT NULL,         -- which corpus edition it was answered from
  asked_by          TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_message_org    ON advisor_message (org_id);
CREATE INDEX IF NOT EXISTS ix_message_thread ON advisor_message (thread_id, seq);

-- ───────────────────────────────────────── Phase 5: artifact generation ──

-- The citation behind an external document. One row per source, not per claim,
-- so ten figures from one report share one citation and cannot drift apart.
CREATE TABLE IF NOT EXISTS external_source (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  document_id  TEXT,                    -- a copy in their own room, if uploaded
  source_kind  TEXT NOT NULL,           -- see SOURCE_KINDS in domain/evidence.js
  publisher    TEXT NOT NULL,
  title        TEXT NOT NULL,
  published_at TEXT NOT NULL,
  url          TEXT,
  accessed_at  TEXT,
  claim_class  TEXT NOT NULL,           -- decides how quickly it goes stale
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_extsource_org ON external_source (org_id);

-- A generated artifact. `fact_refs` and `citations` are the whole point: an
-- artifact is a rendering of referenced facts, never a document with numbers
-- typed into it, and the references are kept so any page can be traced back.
CREATE TABLE IF NOT EXISTS artifact (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  artifact_kind  TEXT NOT NULL,
  title          TEXT NOT NULL,
  -- DRAFT | BLOCKED | GENERATED | STALE | SUPERSEDED
  --
  -- STALE is set by the freshness sweep (api/freshness.js) on an artifact whose
  -- figures have moved since it was generated. It is still a generated document
  -- and is still readable — that is the point: the version somebody was sent has
  -- to remain exactly what they were sent. The states that are NOT readable are
  -- the two with no document behind them, DRAFT and BLOCKED, and those are the
  -- two where `generated_at` is null. Code asks about `generated_at` rather than
  -- enumerating this list, because this list grew by one without the readers
  -- noticing once already.
  state          TEXT NOT NULL,
  blocked_reason TEXT,
  spec           TEXT,                  -- JSON: the resolved content plan
  fact_refs      TEXT,                  -- JSON: every fact id the artifact rests on
  citations      TEXT,                  -- JSON: every external source cited
  html_key       TEXT,
  pdf_key        TEXT,
  page_count     INTEGER,
  generated_by   TEXT,
  generated_at   TEXT,
  superseded_by  TEXT,
  -- Phase 7. `released_at` is the line between housekeeping and a problem: a
  -- stale draft is a tidy-up, a stale document somebody outside the company is
  -- holding is a trust issue with a clock on it.
  released_at    TEXT,
  released_note  TEXT,
  stale_since    TEXT,
  staleness      TEXT,                  -- JSON: graded reasons, see domain/freshness.js
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_artifact_org ON artifact (org_id);

-- Images placed into artifacts. Pixel dimensions are recorded on upload so a
-- logo can be refused for being too small BEFORE it is printed blurry.
CREATE TABLE IF NOT EXISTS brand_asset (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  asset_role   TEXT NOT NULL,           -- LOGO | PRODUCT_SHOT | PORTRAIT | DIAGRAM | OTHER
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  storage_key  TEXT NOT NULL,
  pixel_width  INTEGER,
  pixel_height INTEGER,
  is_vector    INTEGER NOT NULL DEFAULT 0,
  uploaded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_asset_org ON brand_asset (org_id);

-- ────────────────────────────────────── Phase 6: the operating cadence ──
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE:
-- A forecast is LOCKED when it is made. It is never edited and never
-- re-baselined when actuals arrive. Revising it writes a new version and the
-- old one stays visible.
--
-- Without that, criterion 2.4 — "the last three forecasts set against actuals,
-- with variances explained" — is permanently unsatisfiable, because there would
-- never be a fixed forecast to compare against. A product that quietly moved
-- the forecast to match the outcome would be destroying the exact asset it
-- exists to accumulate.

CREATE TABLE IF NOT EXISTS forecast (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  label        TEXT NOT NULL,            -- "FY2026 budget", "Q3 reforecast"
  version      INTEGER NOT NULL,         -- 1, 2, 3 — a revision is a new row
  basis        TEXT NOT NULL,            -- what it was built from, in the author's words
  -- Nullable until the forecast is locked: the horizon is derived from the
  -- lines, and the lines do not exist when the forecast is created.
  horizon_from TEXT,                     -- first period forecast
  horizon_to   TEXT,                     -- last period forecast
  state        TEXT NOT NULL,            -- DRAFT | LOCKED | SUPERSEDED
  locked_at    TEXT,                     -- after this, the rows below are immutable
  locked_by    TEXT,
  superseded_by TEXT,
  supersede_reason TEXT,                 -- why a new version was needed
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_forecast_org ON forecast (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_forecast_version ON forecast (org_id, label, version);

-- One forecast line: a metric, a period, a number. Immutable once the parent
-- forecast is locked.
CREATE TABLE IF NOT EXISTS forecast_line (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  forecast_id  TEXT NOT NULL,
  fact_key     TEXT NOT NULL,            -- the metric, same vocabulary as facts
  label        TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  value_numeric REAL NOT NULL,
  unit         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fline_forecast ON forecast_line (forecast_id);
CREATE INDEX IF NOT EXISTS ix_fline_key ON forecast_line (org_id, fact_key, period_end);

-- A closed accounting period. Closing is what turns entered figures into the
-- actuals a variance is measured against.
CREATE TABLE IF NOT EXISTS period_close (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  state        TEXT NOT NULL,            -- OPEN | CLOSED
  closed_at    TEXT,
  closed_by    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_close_period ON period_close (org_id, period_end);

-- A variance, and the explanation given AT THE TIME.
--
-- `explained_at` is recorded separately from the close date so the gap between
-- them is visible. An explanation written four months later is worth less than
-- one written in the week, and a reader is entitled to tell the difference.
CREATE TABLE IF NOT EXISTS variance (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  forecast_id   TEXT NOT NULL,
  forecast_line_id TEXT NOT NULL,
  fact_id       TEXT,                    -- the actual it was measured against
  fact_key      TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  forecast_value REAL NOT NULL,
  actual_value  REAL,
  delta         REAL,
  delta_percent REAL,
  materiality   TEXT NOT NULL,           -- ON_PLAN | MINOR | MATERIAL | SEVERE
  explanation   TEXT,
  explained_at  TEXT,
  explained_by  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_variance_org ON variance (org_id);
CREATE INDEX IF NOT EXISTS ix_variance_forecast ON variance (forecast_id);

-- ──────────────────────────────────────────── Phase 8: live sharing ──
--
-- THE RULE THIS SCHEMA ENFORCES:
-- The raw token is NEVER stored. Only its hash is, so a database leak does not
-- hand anyone a working link into a company's data room. `token_prefix` exists
-- purely so a human can tell two links apart in a list; it is short enough to
-- be useless on its own.

CREATE TABLE IF NOT EXISTS share (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,        -- ARTIFACT | ROOM
  artifact_id     TEXT,                 -- the version pinned, when ARTIFACT
  share_mode      TEXT NOT NULL,        -- PINNED | FOLLOW_LATEST
  recipient_name  TEXT NOT NULL,
  recipient_org   TEXT,
  stage           TEXT,                 -- room stage; decides which folders are reachable
  token_hash      TEXT NOT NULL,
  token_prefix    TEXT NOT NULL,
  allow_download  INTEGER NOT NULL DEFAULT 1,
  expires_at      TEXT NOT NULL,        -- a link with no expiry outlives the process
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT,
  last_published_at TEXT,               -- when an update was last pushed to this recipient
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_share_org ON share (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_share_token ON share (token_hash);

-- One row per opening. Criterion 8.3 — "a record of who has access and what
-- they received" — satisfied as a by-product of the link being used.
--
-- NOTE: no IP address. The recipient is already identified by the share, so an
-- IP adds nothing to the audit purpose while creating a personal-data holding
-- the company then has to account for.
CREATE TABLE IF NOT EXISTS share_view (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  share_id         TEXT NOT NULL,
  artifact_id      TEXT,                -- the version actually served
  opened_at        TEXT NOT NULL,
  closed_at        TEXT,
  duration_seconds INTEGER,
  client_family    TEXT,                -- "desktop browser", not a fingerprint
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_view_share ON share_view (share_id);

-- Criterion 8.4. Every answer given to any party, so they stay consistent.
CREATE TABLE IF NOT EXISTS share_question (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  share_id      TEXT NOT NULL,
  question      TEXT NOT NULL,
  asked_at      TEXT NOT NULL,
  answer        TEXT,
  answered_at   TEXT,
  answered_by   TEXT,
  similar_to    TEXT,                   -- an earlier question, for consistency
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_question_org ON share_question (org_id);
CREATE INDEX IF NOT EXISTS ix_question_share ON share_question (share_id);

-- ────────────────────────────────────────────── Phase 9: brand ──
--
-- What the user supplied AND what was derived from it are both stored. The
-- derived values are what documents render from; the supplied ones are kept so
-- the product can always show what was asked for next to what was used, and
-- say why they differ.

CREATE TABLE IF NOT EXISTS brand_profile (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  supplied        TEXT NOT NULL,        -- JSON: exactly what the user gave
  derived         TEXT NOT NULL,        -- JSON: the tokens actually rendered from
  adjustments     TEXT,                 -- JSON: what was changed, and why
  logo_asset_id   TEXT,
  typeface        TEXT,                 -- null means the RaiseRoom set
  typeface_licence_ack INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_brand_org ON brand_profile (org_id);

-- ──────────────────────────────────────── Phase 10: the advisor acts ──
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE:
-- The advisor proposes; a person disposes. Nothing here is a change — every
-- row is a PROPOSAL, and the change happens only when a named human confirms
-- it, through the same service functions any other caller uses.
--
-- `before_state` is not a convenience. It is what makes two things possible:
-- refusing a proposal whose world has moved since it was written, and undoing
-- an applied action to the values that were actually there rather than the
-- ones the advisor assumed.

CREATE TABLE IF NOT EXISTS action_proposal (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  thread_id     TEXT,                     -- the conversation it came from, if any
  message_id    TEXT,                     -- the specific turn
  batch_id      TEXT NOT NULL,            -- actions proposed together
  seq           INTEGER NOT NULL,         -- order within the batch
  action_kind   TEXT NOT NULL,            -- must be in the catalogue; nothing else is accepted
  target_type   TEXT NOT NULL,            -- the table. NEVER 'fact'.
  target_id     TEXT NOT NULL,
  payload       TEXT NOT NULL,            -- JSON: the proposed values, catalogue-validated
  before_state  TEXT NOT NULL,            -- JSON: the read+written fields, as they were
  after_state   TEXT,                     -- JSON: what the row ACTUALLY became, set on apply
  rationale     TEXT NOT NULL,            -- why. Non-empty, and the advisor's own words.
  cites         TEXT,                     -- JSON: what the rationale rests on
  state         TEXT NOT NULL,            -- PROPOSED | APPLIED | REJECTED | EXPIRED | UNDONE
  depends_on    TEXT,                     -- a proposal in the same batch that must land first
  applied_at    TEXT,
  applied_by    TEXT,
  undone_at     TEXT,
  undone_by     TEXT,
  rejected_at   TEXT,
  rejected_by   TEXT,
  reject_reason TEXT,
  expires_at    TEXT NOT NULL,
  advisor_id    TEXT NOT NULL,            -- which model proposed it
  advisor_version TEXT NOT NULL,
  proposed_by   TEXT NOT NULL,            -- the human whose turn produced it
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_proposal_org   ON action_proposal (org_id);
CREATE INDEX IF NOT EXISTS ix_proposal_batch ON action_proposal (batch_id);
CREATE INDEX IF NOT EXISTS ix_proposal_state ON action_proposal (org_id, state);

-- Prose written into a generated document.
--
-- Immutable with supersession, exactly as facts are, and for the same reason: a
-- paragraph in an investor document is something a reader may later ask about,
-- and "who wrote this, and when" has to survive the next edit.
--
-- `source` has two values and will never have a third. There is no
-- ADVISOR_WRITTEN, just as `fact.source` has no AI_GENERATED: prose the advisor
-- drafted becomes ADVISOR_DRAFTED_USER_APPROVED at the moment a named person
-- confirms it, and until then it is a proposal, not prose.
CREATE TABLE IF NOT EXISTS prose_block (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  slot          TEXT NOT NULL,            -- 'default', 'market', 'assumptions', …
  body          TEXT NOT NULL,
  source        TEXT NOT NULL,            -- USER_WRITTEN | ADVISOR_DRAFTED_USER_APPROVED
  cites         TEXT,                     -- JSON: what its numerals rest on
  author_id     TEXT NOT NULL,            -- the human. Always a human.
  proposal_id   TEXT,                     -- set when it came through the advisor
  superseded_by TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prose_org  ON prose_block (org_id);
CREATE INDEX IF NOT EXISTS ix_prose_slot ON prose_block (org_id, slot);

-- A document asked for from someone outside the app.
--
-- Recorded, not sent: there is no mail channel in this product yet, and a
-- request that silently goes nowhere is worse than one that is plainly marked
-- as waiting to be sent.
CREATE TABLE IF NOT EXISTS document_request (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  item_id      TEXT,                      -- the room item it would satisfy
  recipient    TEXT,                      -- free text; no address book yet
  note         TEXT NOT NULL,
  state        TEXT NOT NULL,             -- PENDING_SEND | SENT | FULFILLED | CANCELLED
  proposal_id  TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_request_org ON document_request (org_id);

-- ────────────────────────────────────── Phase 11: localisation ──
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE:
-- A machine translation is not usable in a document until a person has approved
-- it — the same shape as an unconfirmed extraction, for the same reason. A
-- document going to an investor should not contain a sentence no human has read,
-- least of all one in a language the issuer cannot check.
--
-- Note what is NOT here: there is no translated copy of a figure anywhere. The
-- numbers live once, in `fact`, and every locale renders them through Intl.
-- A translated figure would be a second copy that could disagree with the first.

CREATE TABLE IF NOT EXISTS prose_translation (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  prose_id       TEXT NOT NULL,          -- the English block this renders
  locale         TEXT NOT NULL,
  body           TEXT NOT NULL,          -- references restored and verified intact
  state          TEXT NOT NULL,          -- MACHINE_TRANSLATED | HUMAN_APPROVED | REJECTED
  translator_id  TEXT,                   -- null when a person wrote it directly
  translator_version TEXT,
  approved_by    TEXT,
  approved_at    TEXT,
  rejected_reason TEXT,
  source_hash    TEXT NOT NULL,          -- the English it was made from
  superseded_by  TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_translation_org   ON prose_translation (org_id);
CREATE INDEX IF NOT EXISTS ix_translation_prose ON prose_translation (prose_id, locale);

-- ────────────────────────────── Phase 12: tiers, billing and portfolio ──
--
-- TWO RULES THIS SCHEMA EXISTS TO ENFORCE:
--
-- 1. NO PRICE IS STORED HERE. The billing provider holds the plan and what it
--    costs. A price kept in two places disagrees eventually, and the copy that
--    is wrong is always the one shown to the customer. This schema stores which
--    plan an organisation is on and what the provider told us about it.
--
-- 2. AN EXPIRED SUBSCRIPTION NEVER TAKES ANYTHING AWAY. `state` gates writing.
--    Reading and exporting are not gated anywhere, by anything. A company that
--    stops paying keeps every document, every fact and every audit row, and can
--    take all of it with them.

CREATE TABLE IF NOT EXISTS subscription (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  plan_key          TEXT NOT NULL,          -- FREE | PREPARE | EVIDENCE | ENTERPRISE
  state             TEXT NOT NULL,          -- ACTIVE | PAST_DUE | EXPIRED | CANCELLED
  term              TEXT NOT NULL,          -- MONTHLY | ANNUAL | NONE (for FREE)
  provider          TEXT,                   -- which billing provider, null while FREE
  provider_ref      TEXT,                   -- the provider's subscription id
  seats             INTEGER,                -- null means the plan does not cap them
  current_period_end TEXT,                  -- as the provider reports it
  -- The provider's event clock, so an event that arrives late cannot undo a
  -- newer one. Providers retry and reorder; a "cancelled" webhook arriving
  -- after a "renewed" would otherwise lock an account that had just paid.
  last_event_at     TEXT,
  started_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscription_org ON subscription (org_id);
CREATE INDEX IF NOT EXISTS ix_subscription_ref ON subscription (provider_ref);

-- Every message the provider sent, stored before it is acted on.
--
-- Kept because a billing dispute is answered from the record of what the
-- provider said and when, not from the current state. `event_ref` is unique, so
-- a provider retrying a webhook ten times changes nothing ten times.
CREATE TABLE IF NOT EXISTS billing_event (
  id            TEXT PRIMARY KEY,
  org_id        TEXT,                       -- null when the event names no org we know
  provider      TEXT NOT NULL,
  event_ref     TEXT NOT NULL,              -- the provider's event id
  event_type    TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,              -- the provider's timestamp
  payload       TEXT NOT NULL,              -- verbatim, as received
  applied       INTEGER NOT NULL DEFAULT 0,
  ignored_reason TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_event_ref ON billing_event (provider, event_ref);
CREATE INDEX IF NOT EXISTS ix_billing_event_org ON billing_event (org_id);

-- The $147 workbook credit, applied.
--
-- One row per redemption, enforced by a unique index on redemption_id rather
-- than by a check in code. A credit that can be claimed twice will be, and the
-- claim will come from a retried request rather than from anyone dishonest.
CREATE TABLE IF NOT EXISTS credit_application (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  redemption_id  TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  provider       TEXT,
  provider_ref   TEXT,                      -- the credit as the provider recorded it
  applied_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_redemption ON credit_application (redemption_id);

-- A company letting somebody see it from outside — an accelerator, an investor.
--
-- This is the ONLY route to another organisation's data in this product, and it
-- is a membership granted by that organisation, not a view assembled by the
-- holder. There is no table here that aggregates across companies, and there is
-- no code that builds one: a portfolio holder sees the companies that invited
-- them, never a benchmark made from them.
CREATE TABLE IF NOT EXISTS portfolio_link (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,              -- the company being seen
  holder_org_id TEXT NOT NULL,              -- the accelerator or investor
  label         TEXT,                       -- what the company calls this relationship
  state         TEXT NOT NULL,              -- INVITED | ACTIVE | REVOKED
  scope         TEXT NOT NULL,              -- SUMMARY | FULL
  invited_by    TEXT NOT NULL,
  accepted_by   TEXT,
  accepted_at   TEXT,
  revoked_by    TEXT,
  revoked_at    TEXT,
  revoked_reason TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_portfolio_org    ON portfolio_link (org_id);
CREATE INDEX IF NOT EXISTS ix_portfolio_holder ON portfolio_link (holder_org_id, state);

-- ──────────────────────────────────────────── Phase 12: how it gets used ──
--
-- Operational analytics: which capabilities get used, which do not, and how the
-- product performs. The product needs this — a product nobody can see being
-- used is a product improved by guessing — and the privacy policy says so.
--
-- WHY THIS IS A COUNTER AND NOT AN EVENT LOG
--
-- The product's central promise is that no aggregate is ever computed across
-- companies and that no code path reads across organisations. An event log with
-- an `org_id` on it would make that promise a matter of discipline: the column
-- would be sitting there, and the first time somebody wanted a chart of "top
-- accounts by document volume" they would write the query.
--
-- So there is no `org_id` here, and no `actor_id`, and no timestamp finer than a
-- day. What is stored is a count in a bucket. The table cannot answer "what is
-- company X doing", not because answering is forbidden but because the answer is
-- not in it — the same reason there is no `AI_GENERATED` in the fact source enum.
--
--   day        — UTC date. Finer than this and a row could be lined up against
--                an audit_log entry to identify who did it.
--   capability — from the frozen catalogue in src/domain/usage.js. A key not in
--                the catalogue cannot be written, so this column cannot quietly
--                grow a dimension nobody declared.
--   cohort     — FREE | TRIAL | RAISEROOM | FIRM. Coarse on purpose.
--   outcome    — DONE | REFUSED | FAILED. The refusals and failures are the
--                useful half: they are where the product is in somebody's way.
--   events     — how many times.
--   first_time — how many organisations used this capability for the first time
--                ever on this day. The adoption number, which volume alone hides.
--   ms_total /
--   ms_max     — a sum and a worst case, from which a mean is derivable. Not a
--                distribution, because a distribution needs the individual
--                timings and those are what we have just decided not to keep.
--
-- Demonstration organisations are not recorded at all. The worked example would
-- otherwise be the most active account in the product.
CREATE TABLE IF NOT EXISTS usage_counter (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,                 -- YYYY-MM-DD, UTC
  capability  TEXT NOT NULL,
  cohort      TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  events      INTEGER NOT NULL DEFAULT 0,
  first_time  INTEGER NOT NULL DEFAULT 0,
  ms_total    INTEGER NOT NULL DEFAULT 0,
  ms_max      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_bucket
  ON usage_counter (day, capability, cohort, outcome);
CREATE INDEX IF NOT EXISTS ix_usage_day ON usage_counter (day);

-- ──────────────────────────────────── The web layer: users and sessions ──
--
-- Everything above this point is storage for an organisation's work. This is
-- the only part that knows a person has a password.
--
-- WHAT IS NOT HERE: a password. `password_hash` holds a scrypt derivation with a
-- per-user salt and the parameters it was derived under, so the cost can be
-- raised later without invalidating anybody's login. A reversible value here —
-- or a fast hash — would make this table the most valuable thing in the product
-- to steal.

CREATE TABLE IF NOT EXISTS user_account (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  email_lower    TEXT NOT NULL,          -- what uniqueness is enforced on
  name           TEXT,
  password_hash  TEXT NOT NULL,          -- scrypt: N$r$p$salt$derived, all hex
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_email ON user_account (email_lower);

-- A signed-in browser.
--
-- The token is stored HASHED, exactly as a share token is: the cookie is the
-- secret, and a database copy of a live session cookie is a copy of somebody's
-- logged-in browser.
CREATE TABLE IF NOT EXISTS web_session (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  csrf_token   TEXT NOT NULL,            -- per session, sent with every form
  user_agent   TEXT,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_token ON web_session (token_hash);
CREATE INDEX IF NOT EXISTS ix_session_user ON web_session (user_id);

-- A password reset in flight.
--
-- The raw token is NEVER stored, exactly as a share token and a session token
-- are not: the link in somebody's inbox is the secret, and a database copy of a
-- live reset link is a copy of the ability to take their account. Lookup is by
-- hash, so no secret comparison happens in this path at all and there is no
-- timing-unsafe equality check to get wrong.
--
-- `used_at` rather than a delete, for two reasons. A link that has been used
-- needs to be distinguishable from a link that never existed, so that somebody
-- who clicks the same link twice is told it has been used instead of being told
-- it is invalid. And a row that is deleted on use cannot answer the question an
-- operator eventually asks, which is whether a reset was completed or merely
-- requested.
--
-- There is deliberately no IP address and no user agent here. The product
-- records neither anywhere else, and a security-shaped table is exactly where
-- that rule gets quietly broken.
CREATE TABLE IF NOT EXISTS password_reset (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reset_token ON password_reset (token_hash);
CREATE INDEX IF NOT EXISTS ix_reset_user ON password_reset (user_id);
