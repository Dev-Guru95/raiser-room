/**
 * Which email provider this deployment is wired to, and what to say when it is
 * none.
 *
 * The same shape as `src/web/advisor.js`, for the same reason — but with a
 * sharper edge, because the consequence of getting this wrong is different.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A MISSING PROVIDER MUST BE SAID OUT LOUD HERE
 *
 * An unconfigured advisor costs somebody an answer. An unconfigured email
 * provider costs somebody their account: they ask for a reset, the page says a
 * link has been sent — because that page is required to say the same thing
 * whether or not the address exists — and no link is ever sent. They wait, try
 * again, and conclude the product is broken. They would be right.
 *
 * So with no provider configured the reset page does not pretend. It says there
 * is no way to send mail from this deployment and names the one route back in:
 * somebody who is still signed in somewhere can change their password at
 * `/account`, and an owner can be reached. That is worse than a reset link and
 * much better than a lie.
 */

import { fakeEmailer } from '../email/fake.js';

export const NO_EMAIL = {
  says: 'This deployment cannot send email, so a reset link cannot be sent.',
  detail: 'Resetting a password needs a link delivered to your address, and no email provider is '
        + 'configured here. If you are still signed in in another browser you can change your '
        + 'password from your account page without a link. If you are not, ask an owner of your '
        + 'organisation to reach whoever runs this deployment.',
};

/**
 * Resolve the provider. Null when none is wired.
 *
 * Takes `ctx` rather than the handler's argument object, which is where this
 * differs from `advisorFor` in `src/web/advisor.js` — and the difference is
 * deliberate, because the name `req` means two different things in two route
 * files. In `routes/advanced.js` the whole argument object is called `req`, so
 * `req.ctx` is the context. In `routes/auth.js` the object is destructured and
 * `req` is the raw Node request, which has no `ctx` on it at all.
 *
 * A helper that reads `.ctx` off whatever it is handed therefore returns null
 * in one of those files and the truth in the other, and it fails in the
 * direction that hides itself: "not configured" is exactly what an
 * unconfigured deployment says, so the bug looks like the feature working.
 * Taking `ctx` cannot be called wrongly that way.
 */
export function emailerFor(ctx) {
  return ctx?.emailer ?? null;
}

export function emailConfigured(ctx) {
  return Boolean(emailerFor(ctx));
}

/** The fake, for tests. Never a silent fallback — see `src/web/advisor.js`. */
export { fakeEmailer };
