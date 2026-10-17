/**
 * Sharing — links that outlive a version without changing under the reader.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT "LIVE" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The naive reading of a live data room is that the content silently updates
 * and the recipient always sees the latest. That is worse than emailing a PDF.
 *
 * An investor who read "$3.6m revenue" on Tuesday and sees "$3.4m" on Thursday,
 * with nothing to say it changed, does not conclude that the company is
 * diligent. They conclude the number moved while they were deciding, and they
 * start wondering what else did. A stale PDF is at least honestly stale.
 *
 * So live means: **the link survives updates, and the company decides when they
 * propagate.** The URL keeps working, access can be withdrawn, you can see who
 * looked — and a new version reaches the recipient when it is published to
 * them, announced, not swapped in underneath them.
 *
 * `FOLLOW_LATEST` exists for the cases where a moving document is the point —
 * a KPI view shared with an existing investor who expects it to move — and in
 * that mode **the recipient is told on the page** that what they are reading
 * updates. The thing that is never allowed is a reader who does not know which
 * of the two they are holding.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TOKEN RULE
 *
 * The raw token is never stored. Only a hash of it is. A leaked database must
 * not hand anyone a working link into a company's data room, and a product that
 * stores shareable secrets in plaintext has quietly made its customers' worst
 * day much worse.
 */

import { randomBytes, createHash } from 'node:crypto';

export class ShareError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export const SUBJECT_KINDS = Object.freeze(['ARTIFACT', 'ROOM']);

export const SHARE_MODES = Object.freeze([
  {
    id: 'PINNED',
    label: 'Fixed version',
    means: 'The recipient sees the version you shared. If you regenerate, they keep seeing what you '
         + 'sent until you publish the update to them — and then they are told it changed.',
    default: true,
  },
  {
    id: 'FOLLOW_LATEST',
    label: 'Always current',
    means: 'The recipient always sees the current version, and the page says so. Suitable where a '
         + 'moving document is the point and the reader expects it.',
    default: false,
  },
]);

const modeById = new Map(SHARE_MODES.map((m) => [m.id, m]));
export const shareMode = (id) => modeById.get(id) ?? null;

/**
 * Default life of a link.
 *
 * A share with no expiry outlives the process that justified it, and nobody
 * ever goes back to tidy up. Ninety days covers a normal raise and forces a
 * deliberate extension for anything longer.
 */
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

// ──────────────────────────────────────────────────────────── tokens ──

/** 256 bits. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
const PREFIX_LENGTH = 8;

/**
 * Mint a token.
 *
 * Returns the raw token ONCE — the caller shows it to the user and then it is
 * gone. What is stored is the hash and a short prefix, the prefix only so a
 * human can tell two links apart in a list.
 */
export function mintToken() {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token: raw,
    token_hash: hashToken(raw),
    token_prefix: raw.slice(0, PREFIX_LENGTH),
  };
}

/**
 * Hash a token for storage and lookup.
 *
 * Lookup is BY HASH, which also means there is never a secret comparison to get
 * wrong: no timing-unsafe equality check exists in this path because no
 * comparison happens at all.
 */
export function hashToken(raw) {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/** Tokens are opaque; this only rejects obvious rubbish before a database hit. */
export function looksLikeToken(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(raw);
}

// ─────────────────────────────────────────────────── access decision ──

/**
 * May this share be opened right now?
 *
 * The order matters, and so does what each outcome reveals.
 *
 * A token that resolves to nothing is 404 and says nothing — the same rule as
 * organisation isolation, for the same reason. A token that resolves to a
 * revoked share says so, because the recipient already knows the link existed;
 * pretending otherwise would be theatre that only confuses an honest reader.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THE REVOKE REASON IS FOR, AND WHO IT IS FOR
 *
 * It is not for the recipient. An earlier version of this function appended it
 * — `Reason given: …` — on the reasoning that a withdrawal is more polite with
 * an explanation. But the reason is written by somebody inside the company, into
 * a field on their own record, at the moment they withdraw access. In practice
 * that field says things like "going with the other bidder", "they forwarded it
 * to a competitor", or the name of whoever asked for it to be pulled. None of
 * that is the recipient's to read, and a company that discovered the product had
 * been showing it would be right to be angry.
 *
 * So the reason stays on the company's own access record, where it was written,
 * and the recipient is told the one thing that is true and theirs to know: that
 * access was withdrawn, and who to ask.
 */
export function accessDecision(share, { now } = {}) {
  if (!share) {
    return { allowed: false, code: 'not_found', status: 404, says: 'This link is not valid.' };
  }

  if (share.revoked_at) {
    return {
      allowed: false, code: 'revoked', status: 403,
      says: 'Access to this material has been withdrawn by the company. If you were expecting it, '
          + 'ask them for a new link.',
    };
  }

  if (!now || String(now).localeCompare(String(share.expires_at)) > 0) {
    return {
      allowed: false, code: 'expired', status: 403,
      says: `This link expired on ${String(share.expires_at).slice(0, 10)}. `
          + 'Ask the company for a new one.',
    };
  }

  return { allowed: true, code: 'ok', status: 200 };
}

/** Validate and normalise an expiry. */
export function resolveExpiry(requested, now, { days = DEFAULT_EXPIRY_DAYS } = {}) {
  if (requested) {
    const at = Date.parse(requested);
    if (!Number.isFinite(at)) throw new ShareError('invalid_expiry', 'the expiry date cannot be read');
    if (at <= Date.parse(now)) throw new ShareError('expiry_in_past', 'the expiry is already in the past');

    const maxAt = Date.parse(now) + MAX_EXPIRY_DAYS * 86_400_000;
    if (at > maxAt) {
      throw new ShareError('expiry_too_far',
        `Links are limited to ${MAX_EXPIRY_DAYS} days. A link that outlives the process it was created `
        + 'for is one nobody remembers to withdraw.');
    }
    return new Date(at).toISOString();
  }
  return new Date(Date.parse(now) + days * 86_400_000).toISOString();
}

// ────────────────────────────────────────────────── what is visible ──

/**
 * Which room folders a share can reach.
 *
 * Reuses the staging rules from Phase 2 rather than inventing a second access
 * model — two systems deciding what a counterparty may see is how a company
 * ends up disclosing something it did not mean to.
 */
export function visibleFolders(folders = [], share = {}, visibleAtStage) {
  if (!share.stage) return [];
  return folders.filter((f) => visibleAtStage(f.stage, share.stage));
}

// ──────────────────────────────────────────────────── watermarking ──

/**
 * The watermark a recipient's copy carries.
 *
 * Per-recipient, so a document that turns up somewhere it should not can be
 * traced to the link it came from. It is a deterrent and an attribution
 * mechanism, not a protection: anyone can photograph a screen.
 */
export function watermarkSpec(share, { now, company } = {}) {
  return {
    line1: share.recipient_name,
    line2: share.recipient_org ? `${share.recipient_org} · ${String(now).slice(0, 10)}`
      : String(now).slice(0, 10),
    footer: `Provided in confidence by ${company ?? 'the company'} to ${share.recipient_name}`
          + ` · link ${share.token_prefix}…`,
  };
}

/**
 * What a share can honestly claim about download control.
 *
 * Stated plainly because overclaiming here is worse than not having the
 * feature. Turning off download removes the button; it does not stop a
 * screenshot, a print-to-PDF or a photograph, and a company that believes
 * otherwise will share something it should not have.
 */
export function downloadPosture(allowDownload) {
  return allowDownload
    ? { download: true, note: 'The recipient can download a watermarked copy.' }
    : {
      download: false,
      note: 'The download button is removed and the copy is watermarked. This is a deterrent and a '
          + 'way to trace a leak — it is not protection. Anyone who can read a page can photograph '
          + 'it, and material you cannot afford to have copied should not be in the link.',
    };
}

// ──────────────────────────────────────────── question consistency ──

/**
 * Find earlier questions close enough to be worth reading before answering.
 *
 * The damaging thing is not an imperfect answer, it is two different answers to
 * the same question given to two parties. Surfacing what was already said makes
 * consistency the easy path rather than a matter of memory.
 *
 * Deliberately token overlap rather than a model: it must be explainable to
 * someone who asks why their draft answer was flagged, and it must not change
 * its mind between two runs.
 */
/**
 * Words carrying no signal about what a question is asking.
 *
 * Without these, "What basis is used to..." and "How is..." share filler that
 * inflates the denominator and pushes a real match below the threshold.
 */
const STOP = new Set([
  'what', 'when', 'where', 'which', 'this', 'that', 'these', 'those', 'your', 'their',
  'please', 'could', 'would', 'should', 'does', 'have', 'from', 'with', 'about', 'they',
  'there', 'been', 'being', 'into', 'than', 'then', 'also', 'such', 'used', 'using',
]);

/**
 * Tokenise with light stemming.
 *
 * "How is net revenue retention CALCULATED?" and "What basis is used to
 * CALCULATE revenue retention?" are the same question, and an exact-match
 * comparison scored them at 0.33 and let the second one through unflagged —
 * missing precisely the case this check exists for. People do not re-ask a
 * question in the words they used last time.
 *
 * Crude on purpose: suffix stripping is deterministic and explainable to
 * somebody asking why their draft was flagged, which a model would not be.
 */
export function normaliseTokens(text) {
  const words = String(text).toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const out = new Set();

  for (const word of words) {
    if (STOP.has(word)) continue;
    let stem = word;
    for (const suffix of ['ing', 'edly', 'ed', 'es', 's']) {
      if (stem.endsWith(suffix) && stem.length - suffix.length >= 4) {
        stem = stem.slice(0, -suffix.length);
        break;
      }
    }
    // "calculate" and "calculated" both reduce to "calculat" only if a
    // trailing e also goes.
    if (stem.endsWith('e') && stem.length >= 5) stem = stem.slice(0, -1);
    out.add(stem);
  }
  return out;
}

export function similarQuestions(question, previous = [], { threshold = 0.4, limit = 3 } = {}) {
  const want = normaliseTokens(question);
  if (!want.size) return [];

  const scored = [];
  for (const p of previous) {
    if (!p.answer) continue;                       // only answered ones are useful
    const have = normaliseTokens(p.question);
    let hits = 0;
    for (const t of want) if (have.has(t)) hits++;
    const score = hits / Math.max(want.size, 1);
    if (score >= threshold) scored.push({ ...p, score: Math.round(score * 100) / 100 });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Does a draft answer contradict what was already said?
 *
 * Reports rather than blocks, and reports crudely on purpose: it flags that two
 * answers to a similar question differ substantially, and leaves the judgement
 * to a human. A product that tried to decide whether two prose answers mean the
 * same thing would be wrong often and confidently.
 */
export function consistencyWarning(draftAnswer, similar = []) {
  if (!similar.length) return null;

  const draft = normaliseTokens(draftAnswer);

  const divergent = similar.filter((s) => {
    const prior = normaliseTokens(s.answer);
    let shared = 0;
    for (const w of draft) if (prior.has(w)) shared++;
    return shared / Math.max(draft.size, 1) < 0.5;
  });

  if (!divergent.length) return null;

  return {
    code: 'possible_inconsistency',
    says: `You have answered a similar question before, and this answer reads differently. `
        + 'Two different answers to the same question is more damaging than either answer being '
        + 'imperfect — it moves the conversation from the business to whether you can be relied on.',
    previous: divergent.map((d) => ({
      question: d.question, answer: d.answer, answered_at: d.answered_at, similarity: d.score,
    })),
  };
}

// ────────────────────────────────────────────────── notification ──

/**
 * Who needs telling that a document they hold has been superseded.
 *
 * The product cannot send the email, so it produces the list and the words. A
 * company that knows exactly who is holding an outdated figure, and has the
 * sentence ready, will make the call. One that has to reconstruct the list
 * first usually does not.
 */
export function notificationDraft(share, { changes = [], company, artifactTitle } = {}) {
  const moved = changes.filter((c) => c.value_moved);

  return {
    share_id: share.id,
    recipient: share.recipient_name,
    subject: `${artifactTitle ?? 'Document'} — updated figures`,
    body: `Hello,\n\n`
      + `We have updated the ${artifactTitle ?? 'document'} shared with you`
      + `${share.last_published_at ? ' again' : ''}. `
      + (moved.length
        ? `${moved.length} figure${moved.length === 1 ? ' has' : 's have'} changed since the version `
          + `you were sent:\n\n`
          + moved.map((c) => `  · ${c.label}: ${c.was} → ${c.now}`).join('\n')
          + '\n\nThe link you already have now shows the current version.'
        : 'The underlying figures are unchanged; the update improves the supporting detail.')
      + `\n\nWe would rather tell you than have you find it.\n\n${company ?? ''}`,
    // The reason this exists, said once, where whoever is about to skip it
    // will read it.
    why: 'A counterparty who finds a changed figure themselves does not weigh the figure. They weigh '
       + 'what else might have moved without being mentioned.',
  };
}
