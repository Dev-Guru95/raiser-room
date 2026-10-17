/**
 * The security layer: passwords, sessions, CSRF, headers.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ZERO DEPENDENCIES, DELIBERATELY
 *
 * Everything here is built on `node:crypto`. That is not minimalism for its own
 * sake: this is the file that holds people's passwords and their sessions, and
 * the smaller its supply chain the fewer ways there are for somebody else's
 * compromised package to read them. Node ships scrypt, a CSPRNG and a
 * constant-time comparison, which is the whole list.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS STORED, AND WHAT IS NOT
 *
 * **No password.** `password_hash` is a scrypt derivation with a per-user salt
 * and the cost parameters recorded alongside it, so the cost can be raised later
 * without invalidating anybody's login.
 *
 * **No session token.** The cookie is the secret; the database holds its SHA-256
 * hash. A dump of `web_session` is not a set of working logins. This is the same
 * decision the share tokens made in Phase 8, for the same reason.
 */

import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(code, message, status = 401, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// ───────────────────────────────────────────────────────────────── passwords ──

/**
 * scrypt parameters.
 *
 * N=2^15 with r=8 is a common interactive-login setting: enough work that an
 * offline attack on a stolen table is expensive, little enough that a sign-in
 * does not feel slow. They are stored with each hash so this can be raised
 * without a migration — an old hash still verifies under its own parameters,
 * and is re-derived at the next successful login.
 */
export const SCRYPT = Object.freeze({ N: 32_768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });

export function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const derived = scryptSync(normalise(password), salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: params.maxmem,
  });
  return [params.N, params.r, params.p, salt.toString('hex'), derived.toString('hex')].join('$');
}

/**
 * Verify, in constant time, and say whether the stored hash is out of date.
 *
 * Returns `{ ok, needs_rehash }` rather than a boolean so a successful login can
 * quietly upgrade a hash derived under weaker parameters.
 */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 5) return { ok: false, needs_rehash: false };

  const [N, r, p, saltHex, derivedHex] = parts;
  let derived;
  try {
    derived = scryptSync(normalise(password), Buffer.from(saltHex, 'hex'), derivedHex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return { ok: false, needs_rehash: false };
  }

  const expected = Buffer.from(derivedHex, 'hex');
  if (expected.length !== derived.length) return { ok: false, needs_rehash: false };
  const ok = timingSafeEqual(expected, derived);

  return {
    ok,
    needs_rehash: ok && (Number(N) < SCRYPT.N || Number(r) < SCRYPT.r),
  };
}

/**
 * Unicode-normalise before hashing.
 *
 * Two visually identical passwords can be different byte sequences, and a user
 * who set their password on one device and cannot sign in on another has a
 * problem nobody will diagnose.
 */
const normalise = (password) => String(password ?? '').normalize('NFKC');

/**
 * What a password has to clear.
 *
 * Length and nothing else. Composition rules — a capital, a digit, a symbol —
 * push people towards `Password1!` and towards reuse, and the evidence that they
 * help is thin. Length is the thing that matters.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblems(password, { email = '' } = {}) {
  const value = String(password ?? '');
  const problems = [];

  if (value.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password `
      + 'hard to guess — a long ordinary phrase beats a short complicated one.');
  }
  if (value.length > 1024) {
    // Not a security rule; a guard against someone pasting a file into the box
    // and making the server do scrypt over a megabyte.
    problems.push('That is longer than any password needs to be.');
  }
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length > 2 && value.toLowerCase().includes(local)) {
    problems.push('This contains your email address, which is the first thing anybody would try.');
  }
  for (const common of COMMON) {
    if (value.toLowerCase() === common) {
      problems.push('This is one of the most commonly used passwords in the world.');
      break;
    }
  }
  return problems;
}

/** A short list, checked exactly. A full breach corpus belongs behind an API, not in a repo. */
const COMMON = Object.freeze([
  'password', 'password123', 'passw0rd', '123456789012', 'qwertyuiop12',
  'letmein12345', 'administrator', 'welcome12345',
]);

// ──────────────────────────────────────────────────────────────── sessions ──

export const SESSION_COOKIE = 'rr_session';
export const SESSION_DAYS = 14;
const TOKEN_BYTES = 32;

export const hashToken = (raw) => createHash('sha256').update(String(raw), 'utf8').digest('hex');

export function mintSessionToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, token_hash: hashToken(token) };
}

export const mintCsrfToken = () => randomBytes(32).toString('base64url');

export function sessionExpiry(nowIso, days = SESSION_DAYS) {
  const d = new Date(nowIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * The session cookie.
 *
 * `HttpOnly` so a script cannot read it, `SameSite=Lax` so it is not sent on a
 * cross-site POST, `Secure` everywhere except plain-HTTP local development —
 * and `Path=/` so signing out clears it from every route.
 */
export function sessionCookie(token, { secure = true, maxAgeDays = SESSION_DAYS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeDays * 86_400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = ({ secure = true } = {}) =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

export function readCookie(header, name = SESSION_COOKIE) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────── CSRF ──

/**
 * Compare a submitted CSRF token with the session's, in constant time.
 *
 * `SameSite=Lax` already blocks the common case, but it is one browser setting
 * away from not doing so, and defence that rests on a single mechanism is how a
 * form ends up submittable from somebody else's page.
 */
export function csrfValid(submitted, expected) {
  const a = Buffer.from(String(submitted ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ──────────────────────────────────────────────────────── login throttling ──

/**
 * Lock an account briefly after repeated failures.
 *
 * Counted per account rather than per address, because an attacker has many
 * addresses and the thing being protected is one person's password. The lock is
 * short and self-clearing: a long one hands anybody a way to lock a user out by
 * guessing their password wrongly on purpose.
 */
export const MAX_FAILED_LOGINS = 8;
export const LOCK_MINUTES = 15;

export function lockState(user, nowIso) {
  if (!user?.locked_until) return { locked: false };
  if (String(nowIso) >= String(user.locked_until)) return { locked: false, expired: true };
  const seconds = Math.ceil((new Date(user.locked_until).getTime() - new Date(nowIso).getTime()) / 1000);
  return {
    locked: true,
    until: user.locked_until,
    says: `Too many attempts. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minutes.`,
  };
}

export function lockUntil(nowIso, minutes = LOCK_MINUTES) {
  const d = new Date(nowIso);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

// ───────────────────────────────────────────────────────── password resets ──

/**
 * How long a reset link lives.
 *
 * Short, because the link is a bearer token for an account and it sits in an
 * inbox — which is the one place a password is not. Sixty minutes is long
 * enough for somebody to find the mail in a spam folder and short enough that
 * a laptop left open at a conference is not a standing invitation.
 *
 * Not shorter: a fifteen-minute link is one a person on a corporate mail
 * gateway genuinely cannot use, and a reset they cannot complete is a support
 * ticket that ends with somebody reading a password down a phone line.
 */
export const RESET_MINUTES = 60;

/** A reset token. The raw value is returned once and never stored. */
export function mintResetToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, token_hash: hashToken(token) };
}

export function resetExpiry(nowIso, minutes = RESET_MINUTES) {
  const d = new Date(nowIso);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

/**
 * May this reset link be used right now?
 *
 * Pure, so the rule is testable without a database, a clock or a request.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY A USED LINK IS NOT TREATED AS AN UNKNOWN ONE
 *
 * An unknown token says nothing at all — the same rule a share token follows,
 * for the same reason: a message that distinguishes "never existed" from
 * "expired" tells somebody probing it which of their guesses was real.
 *
 * But a token the holder has ALREADY USED is different. They know it existed,
 * because they used it a minute ago; telling them it is unknown would be
 * theatre that only confuses an honest person who double-clicked a link or
 * came back to it from their browser history. So that case says so plainly.
 *
 * The order matters: used is checked before expired, because a link that was
 * used and has since expired was used, and that is the more useful true thing
 * to say.
 */
export function resetDecision(row, nowIso) {
  if (!row) {
    return { usable: false, code: 'reset_unknown', says: 'That reset link is not valid. Ask for a new one.' };
  }
  if (row.used_at) {
    return {
      usable: false,
      code: 'reset_used',
      says: 'That reset link has already been used. Ask for a new one if you still need it.',
    };
  }
  if (String(nowIso) >= String(row.expires_at)) {
    return {
      usable: false,
      code: 'reset_expired',
      says: 'That reset link has expired. Ask for a new one.',
    };
  }
  return { usable: true, code: null, says: null };
}
// ─────────────────────────────────────────────────────────────────── headers ──

/**
 * Response headers set on every page.
 *
 * The content-security policy is the load-bearing one. `script-src 'self'` with
 * no `unsafe-inline` means an injected `<script>` does not run even if escaping
 * somewhere else failed — which is the whole point of having a second line of
 * defence rather than trusting the first.
 *
 * Styles need `unsafe-inline` because generated documents carry inline style
 * attributes, and splitting those out would be a large change to the renderer
 * for a much smaller gain than the script rule provides.
 */
export function securityHeaders({ secure = true, nonce = null, storageOrigin = null } = {}) {
  const script = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  // `connect-src` is the one directive a deployment has to widen, and only when
  // file storage lives on another host: the browser PUTs uploads straight to it,
  // and `default-src 'self'` would block that. One exact origin, nothing else —
  // and absent entirely when storage is served from this application, which is
  // the local driver's case and the one the tests run under.
  const connect = ["'self'", ...(storageOrigin ? [safeOrigin(storageOrigin)] : [])]
    .filter(Boolean).join(' ');
  const headers = {
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src ${script}`,
      `connect-src ${connect}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Nothing in this product is cacheable by a shared cache: every page is
    // specific to one signed-in person and most of it is confidential.
    'Cache-Control': 'no-store',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/**
 * Reduce a configured value to a bare origin, or to nothing.
 *
 * A policy is a single header built by string concatenation, so a value with a
 * space or a semicolon in it does not widen one directive — it invents new ones.
 * `https://bucket.example 'unsafe-inline'; script-src *` in an environment
 * variable would otherwise be a working way to turn the whole policy off.
 *
 * Anything that is not a plain http(s) origin is dropped rather than repaired,
 * and dropping it fails closed: the upload is blocked and the browser console
 * says which origin it wanted.
 */
function safeOrigin(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Is this request's origin one we accept a form from?
 *
 * Belt and braces with SameSite and CSRF. Checked on every mutating request.
 */
export function originAllowed({ origin, host, secure = true }) {
  if (!origin) return true;          // same-origin form posts often omit it
  try {
    const url = new URL(origin);
    return url.host === host && (!secure || url.protocol === 'https:');
  } catch {
    return false;
  }
}
