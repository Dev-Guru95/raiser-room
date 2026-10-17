/**
 * Accounts and sign-in.
 *
 * The one part of this product that knows a person has a password. Everything
 * below the web layer takes `ctx.auth` as given, which is what let the whole
 * service layer be built and tested without any of this existing — and is why
 * swapping this for an identity provider later changes this file and nothing
 * else.
 */

import { randomUUID } from 'node:crypto';
import {
  hashPassword, verifyPassword, passwordProblems, mintSessionToken, mintCsrfToken,
  hashToken, sessionExpiry, lockState, lockUntil, MAX_FAILED_LOGINS, AuthError,
  mintResetToken, resetExpiry, resetDecision, RESET_MINUTES,
} from './security.js';
import { passwordReset as passwordResetMessage } from '../email/messages.js';

const ok = (body, status = 200) => ({ status, body });

/**
 * Email, normalised for comparison.
 *
 * Lower-cased and trimmed, and nothing more. Stripping dots or `+tags` is a
 * provider-specific convention, and applying Gmail's rules to somebody's
 * corporate address can merge two different people into one account.
 */
export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function register(ctx, { email, password, name = null }) {
  const address = String(email ?? '').trim();
  const lower = normaliseEmail(address);

  const problems = [];
  if (!EMAIL.test(address)) problems.push('That does not look like an email address.');
  problems.push(...passwordProblems(password, { email: address }));
  if (problems.length) throw new AuthError('registration_rejected', problems[0], 400, { problems });

  if (ctx.db.findOne('user_account', { email_lower: lower })) {
    // Deliberately the same shape of answer as a successful registration would
    // give at the UI level — see `routes/auth.js`. Saying "that address is taken"
    // on a public signup form tells anybody who asks which addresses have
    // accounts here.
    throw new AuthError('email_in_use', 'That address cannot be registered.', 409);
  }

  const user = ctx.db.insert('user_account', {
    id: randomUUID(),
    email: address, email_lower: lower,
    name: name ? String(name).trim() : null,
    password_hash: hashPassword(password),
    failed_logins: 0, locked_until: null, last_login_at: null,
    created_at: ctx.now(),
  });

  return ok({ user: present(user) }, 201);
}

/**
 * Sign in.
 *
 * Every failure returns the same message. "No account with that address" and
 * "wrong password" are different facts, and telling them apart turns a login
 * form into a way to enumerate who has an account.
 */
export function signIn(ctx, { email, password, userAgent = null }) {
  const lower = normaliseEmail(email);
  const user = ctx.db.findOne('user_account', { email_lower: lower });

  const generic = () => new AuthError('invalid_credentials',
    'That email address and password do not match an account.', 401);

  if (!user) {
    // Hash anyway. Returning immediately makes a missing account measurably
    // faster than a wrong password, which is the same disclosure by a side
    // channel.
    hashPassword(String(password ?? ''));
    throw generic();
  }

  const lock = lockState(user, ctx.now());
  if (lock.locked) throw new AuthError('account_locked', lock.says, 429, { until: lock.until });
  if (lock.expired) ctx.db.update('user_account', user.id, { failed_logins: 0, locked_until: null });

  const result = verifyPassword(password, user.password_hash);
  if (!result.ok) {
    const failed = (lock.expired ? 0 : user.failed_logins) + 1;
    ctx.db.update('user_account', user.id, {
      failed_logins: failed,
      locked_until: failed >= MAX_FAILED_LOGINS ? lockUntil(ctx.now()) : null,
    });
    throw generic();
  }

  ctx.db.update('user_account', user.id, {
    failed_logins: 0, locked_until: null, last_login_at: ctx.now(),
    // Quietly upgrade a hash derived under weaker parameters, now that the
    // password is in hand and known to be right.
    ...(result.needs_rehash ? { password_hash: hashPassword(password) } : {}),
  });

  return ok({ user: present(user), session: openSession(ctx, user.id, userAgent) });
}

/** A new session. The raw token is returned once and never stored. */
export function openSession(ctx, userId, userAgent = null) {
  const { token, token_hash } = mintSessionToken();
  const row = ctx.db.insert('web_session', {
    id: randomUUID(), user_id: userId, token_hash,
    csrf_token: mintCsrfToken(),
    user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    expires_at: sessionExpiry(ctx.now()),
    last_seen_at: ctx.now(), created_at: ctx.now(),
  });
  return { token, id: row.id, csrf_token: row.csrf_token, expires_at: row.expires_at };
}

/**
 * Resolve a cookie to a signed-in user.
 *
 * Returns null rather than throwing: an expired session is the ordinary state of
 * a browser left open overnight, not an error.
 */
export function resolveSession(ctx, token) {
  if (!token) return null;
  const row = ctx.db.findOne('web_session', { token_hash: hashToken(token) });
  if (!row) return null;

  if (String(ctx.now()) >= String(row.expires_at)) {
    ctx.db.remove('web_session', row.id);
    return null;
  }

  const user = ctx.db.get('user_account', row.user_id);
  if (!user) {
    ctx.db.remove('web_session', row.id);
    return null;
  }

  ctx.db.update('web_session', row.id, { last_seen_at: ctx.now() });
  return { user: present(user), session: row };
}

export function signOut(ctx, sessionId) {
  if (sessionId) ctx.db.remove('web_session', sessionId);
  return ok({ signed_out: true });
}

/** Sign out everywhere — for a password change, or a lost laptop. */
export function signOutEverywhere(ctx, userId) {
  const sessions = ctx.db.find('web_session', { user_id: userId });
  for (const s of sessions) ctx.db.remove('web_session', s.id);
  return ok({ signed_out: sessions.length });
}

export function changePassword(ctx, userId, { current, next }) {
  const user = ctx.db.get('user_account', userId);
  if (!user) throw new AuthError('no_account', 'No such account.', 404);

  if (!verifyPassword(current, user.password_hash).ok) {
    throw new AuthError('wrong_password', 'That is not your current password.', 403);
  }
  const problems = passwordProblems(next, { email: user.email });
  if (problems.length) throw new AuthError('password_rejected', problems[0], 400, { problems });

  ctx.db.update('user_account', userId, { password_hash: hashPassword(next) });
  // Every other session ends. A password change is usually a response to
  // somebody else having had access, and leaving their session alive defeats it.
  const ended = signOutEverywhere(ctx, userId).body.signed_out;
  return ok({ changed: true, sessions_ended: ended });
}

// ──────────────────────────────────────────────────────────── password reset ──

/**
 * Ask for a reset link.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THIS WHOLE FUNCTION EXISTS TO KEEP
 *
 * The answer is identical whether the address has an account, has no account,
 * had one that was deleted, or belongs to somebody whose provider refused the
 * message. Every one of those returns the same body with the same status in
 * about the same time.
 *
 * That is not politeness. A reset form that answers differently for a real
 * address is an account enumerator, and this product has customers in
 * confidential processes — the same reason a non-member gets 404 rather than
 * 403. A competitor who can ask "does this person have an account here" has
 * learned something the product promised they could not.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THE SEND IS NOT AWAITED
 *
 * Three reasons, and the first is the one that matters:
 *
 *   · TIMING. Awaiting a provider round trip makes a request for a real
 *     address measurably slower than one for an address with no account,
 *     which leaks exactly what the identical wording was protecting. The
 *     response does not wait, so both paths cost a database read.
 *   · A provider outage must not change the answer. A 502 on this form would
 *     fire only for addresses that exist, because only those cause a send.
 *   · The service layer is synchronous by design — `(ctx, input)` to
 *     `{ status, body }` — and this is the only place in the product that
 *     wants to talk to a network at all.
 *
 * The cost is honest and written down: a message this product believes it
 * handed over may never have been accepted. The provider's own dashboard is
 * where that is visible, and `src/email/interface.js` says so.
 */
export function requestPasswordReset(ctx, { email, baseUrl = null, onSendFailure = null }) {
  const lower = normaliseEmail(email);
  const user = ctx.db.findOne('user_account', { email_lower: lower });

  // Said once, here, so no caller can accidentally say something else.
  const answer = ok({
    requested: true,
    says: 'If that address has an account, a reset link is on its way. The link works once and '
      + `expires in ${RESET_MINUTES} minutes.`,
  });

  if (!user) return answer;
  if (!ctx.emailer) {
    // No provider: do not mint a token nobody can ever receive. The route shows
    // `NO_EMAIL` before reaching here, so this is the belt to that brace rather
    // than the thing a person normally meets.
    return answer;
  }

  // A second request supersedes the first. Two live links for one account is
  // twice the window for the same benefit, and the older row is DELETED rather
  // than marked used: it was never used, and telling its holder it was would be
  // false. Deleted, it reads as unknown, which is both true and silent.
  for (const row of ctx.db.find('password_reset', { user_id: user.id })) {
    if (!row.used_at) ctx.db.remove('password_reset', row.id);
  }

  const { token, token_hash } = mintResetToken();
  ctx.db.insert('password_reset', {
    id: randomUUID(),
    user_id: user.id,
    token_hash,
    expires_at: resetExpiry(ctx.now()),
    used_at: null,
    created_at: ctx.now(),
  });

  // Composed from the catalogue in git — this layer does not write subject
  // lines. Fired and not awaited, for the reasons above.
  const message = passwordResetMessage({
    to: user.email,
    baseUrl: baseUrl ?? ctx.baseUrl ?? '',
    token,
    minutes: RESET_MINUTES,
  });

  Promise.resolve()
    .then(() => ctx.emailer.send(message))
    .catch((err) => {
      // Nothing is told to the person asking. An operator is: this is the
      // failure that looks like nothing at all from the outside, and the one the
      // monitoring section of the handover exists to catch.
      if (onSendFailure) onSendFailure(err);
    });

  return answer;
}

/**
 * Look at a reset link without spending it.
 *
 * The GET that renders the form must not consume the token: a mail client that
 * prefetches links would otherwise burn every reset link before its owner ever
 * clicked one, and that failure is invisible to whoever shipped it.
 */
export function resolveReset(ctx, token) {
  const row = token ? ctx.db.findOne('password_reset', { token_hash: hashToken(token) }) : null;
  const decision = resetDecision(row, ctx.now());
  return { ...decision, reset: decision.usable ? row : null };
}

/**
 * Spend a reset link and set a new password.
 *
 * Single-use is enforced by stamping `used_at` in the same call that changes the
 * password, and every other session ends — a reset is usually a response to
 * having lost control of something, so leaving the old sessions alive defeats
 * the point, exactly as it would on a deliberate password change.
 */
export function completePasswordReset(ctx, { token, password }) {
  const { usable, code, says, reset } = resolveReset(ctx, token);
  if (!usable) throw new AuthError(code, says, 400);

  const user = ctx.db.get('user_account', reset.user_id);
  if (!user) {
    // The account went away between the request and the click. Spend the token
    // anyway, so it cannot be presented again.
    ctx.db.update('password_reset', reset.id, { used_at: ctx.now() });
    throw new AuthError('reset_unknown', 'That reset link is not valid. Ask for a new one.', 400);
  }

  const problems = passwordProblems(password, { email: user.email });
  if (problems.length) {
    // NOT spent. A password the rules refuse is the commonest thing to happen on
    // this form, and burning the link for it would send somebody back to their
    // inbox for a second link to make the same mistake with.
    throw new AuthError('password_rejected', problems[0], 400, { problems });
  }

  ctx.db.update('password_reset', reset.id, { used_at: ctx.now() });
  ctx.db.update('user_account', user.id, {
    password_hash: hashPassword(password),
    // A reset is also the way out of a lockout. Somebody who proved they hold
    // the address should not meet a fifteen-minute wait they cannot explain.
    failed_logins: 0,
    locked_until: null,
  });

  const ended = signOutEverywhere(ctx, user.id).body.signed_out;
  return ok({ reset: true, sessions_ended: ended });
}

const present = (user) => ({
  id: user.id, email: user.email, name: user.name, created_at: user.created_at,
});

export { AuthError };
