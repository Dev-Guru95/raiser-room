/**
 * Sign up, sign in, sign out, change password.
 */

import * as auth from '../auth.js';
import { sessionCookie, clearCookie, MIN_PASSWORD_LENGTH } from '../security.js';
import { layout, page, form, field, h, refusal, section, banner } from '../html.js';
import { throttleSays } from '../throttle.js';
import { emailConfigured, NO_EMAIL } from '../mail.js';

const render = (body, extra = {}) => ({ html: layout(body), ...extra });

/**
 * Where to go after signing in.
 *
 * Only a path on this site. A full URL here is an open redirect: a link to
 * `/sign-in?next=https://elsewhere` that lands a freshly authenticated user on
 * somebody else's page is a phishing primitive, and it is the commonest one.
 */
export function safeNext(value) {
  const next = String(value ?? '');
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

/**
 * The 429.
 *
 * It says what happened and when to come back, and nothing about whether the
 * address typed in has an account. The whole design of these two forms is that
 * they reveal nothing either way, and a rate-limit message is an easy place to
 * undo that by accident — "too many attempts for this account" would be a
 * working account enumerator.
 *
 * `Retry-After` is set because a well-behaved client reads it, and because an
 * operator reading a log of 429s wants to know the window without guessing.
 */
function tooMany(title, retryAfter, query = null) {
  const next = query ? `?next=${encodeURIComponent(safeNext(query.get('next')))}` : '';
  return {
    status: 429,
    headers: { 'Retry-After': String(retryAfter) },
    html: layout({
      title,
      body: page({
        title,
        body: banner({ tone: 'warn', says: throttleSays(retryAfter) })
          + `<p class="note"><a href="${title === 'Sign in' ? `/sign-in${next}` : '/sign-up'}">Back</a></p>`,
      }),
    }),
  };
}

export const authRoutes = [
  {
    path: '/sign-in', method: 'GET', auth: false,
    handle: ({ query, user }) => {
      if (user) return { redirect: '/' };
      return render({
        title: 'Sign in',
        body: page({
          title: 'Sign in',
          lede: 'Your diligence file, your figures, and everything you have generated.',
          body: form({
            action: `/sign-in?next=${encodeURIComponent(safeNext(query.get('next')))}`,
            csrf: '',
            submit: 'Sign in',
            body: field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' })
              + field({ name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }),
          }) + '<p class="note">No account? <a href="/sign-up">Create one</a>.</p>',
        }),
      });
    },
  },

  {
    // CSRF is not checked on sign-in: there is no session yet to carry a token,
    // and the request is not acting on anybody's behalf. SameSite and the origin
    // check still apply.
    path: '/sign-in', method: 'POST', auth: false,
    handle: ({ ctx, body, query, req, throttle, address }) => {
      // Counted before the password is checked, because the attack this guards
      // against is one or two attempts against each of ten thousand addresses —
      // every one of which fails, so counting failures only would count the same
      // thing and counting successes only would count nothing.
      const gate = throttle.check('sign-in', address);
      if (!gate.allowed) return tooMany('Sign in', gate.retryAfter, query);

      try {
        const result = auth.signIn(ctx, {
          email: body.email, password: body.password, userAgent: req?.headers?.['user-agent'],
        });
        // Somebody who got it right on the third attempt is not three closer to
        // being locked out for the rest of the window.
        throttle.clear('sign-in', address);
        return {
          redirect: safeNext(query.get('next')),
          headers: { 'Set-Cookie': sessionCookie(result.body.session.token, { secure: true }) },
        };
      } catch (err) {
        return {
          status: err.status ?? 401,
          html: layout({
            title: 'Sign in',
            body: page({
              title: 'Sign in',
              body: refusal(err) + form({
                action: `/sign-in?next=${encodeURIComponent(safeNext(query.get('next')))}`,
                csrf: '', submit: 'Sign in',
                body: field({ name: 'email', label: 'Email', type: 'email', value: body.email ?? '', required: true, autocomplete: 'username' })
                  + field({ name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }),
              }),
            }),
          }),
        };
      }
    },
  },

  {
    path: '/sign-up', method: 'GET', auth: false,
    handle: ({ user }) => {
      if (user) return { redirect: '/' };
      return render({
        title: 'Create an account',
        body: page({
          title: 'Create an account',
          lede: 'Two weeks of everything, then pick a plan. Nothing you record is ever locked away '
              + 'from you, including after a subscription ends.',
          body: form({
            action: '/sign-up', csrf: '', submit: 'Create account',
            body: field({ name: 'name', label: 'Your name', autocomplete: 'name' })
              + field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' })
              + field({
                name: 'password', label: 'Password', type: 'password', required: true,
                autocomplete: 'new-password',
                hint: `At least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password `
                    + 'hard to guess — a long ordinary phrase beats a short complicated one.',
              }),
          }) + '<p class="note">Already have one? <a href="/sign-in">Sign in</a>.</p>',
        }),
      });
    },
  },

  {
    path: '/sign-up', method: 'POST', auth: false,
    handle: ({ ctx, body, throttle, address }) => {
      // An unlimited sign-up form on a product with a free plan is a way to fill
      // somebody else's database, and once account email is wired it is a way to
      // send mail from their domain.
      const gate = throttle.check('sign-up', address);
      if (!gate.allowed) return tooMany('Create an account', gate.retryAfter);

      try {
        auth.register(ctx, { email: body.email, password: body.password, name: body.name });
      } catch (err) {
        // An address already in use must not be distinguishable from a new one,
        // or this form becomes a way to ask which addresses have accounts here.
        // So that one case falls through to the same outcome as success.
        if (err.code !== 'email_in_use') {
          return {
            status: err.status ?? 400,
            html: layout({
              title: 'Create an account',
              body: page({
                title: 'Create an account',
                body: refusal(err) + form({
                  action: '/sign-up', csrf: '', submit: 'Create account',
                  body: field({ name: 'name', label: 'Your name', value: body.name ?? '' })
                    + field({ name: 'email', label: 'Email', type: 'email', value: body.email ?? '', required: true })
                    + field({ name: 'password', label: 'Password', type: 'password', required: true }),
                }),
              }),
            }),
          };
        }
      }

      try {
        const result = auth.signIn(ctx, { email: body.email, password: body.password });
        return {
          redirect: '/',
          headers: { 'Set-Cookie': sessionCookie(result.body.session.token, { secure: true }) },
        };
      } catch {
        // Registration was refused as a duplicate and the password did not match
        // the existing account. Same page either way.
        return { redirect: '/sign-in?registered=1' };
      }
    },
  },

  // ── password reset ────────────────────────────────────────────────────────
  //
  // Four routes, and the pair of them that matters is `/forgot`: it answers the
  // same way for an address with an account and an address without one. The
  // temptation to be helpful here — "no account with that address" — is the
  // whole vulnerability.

  {
    path: '/forgot', method: 'GET', auth: false,
    handle: ({ ctx, user }) => {
      if (user) return { redirect: '/account' };

      // Rule 12: a page whose external system is absent says so, rather than
      // taking a request it cannot act on. Somebody told "a link is on its way"
      // by a deployment that cannot send mail waits for ever.
      if (!emailConfigured(ctx)) {
        return render({
          title: 'Reset your password',
          body: page({
            title: 'Reset your password',
            body: banner({ tone: 'warn', says: NO_EMAIL.says })
              + `<p class="note">${h(NO_EMAIL.detail)}</p>`
              + '<p class="note"><a href="/sign-in">Back to sign in</a></p>',
          }),
        });
      }

      return render({
        title: 'Reset your password',
        body: page({
          title: 'Reset your password',
          lede: 'Type the address you signed up with and we will send a link that sets a new password.',
          body: form({
            action: '/forgot', csrf: '', submit: 'Send a reset link',
            body: field({
              name: 'email', label: 'Email', type: 'email', required: true,
              autocomplete: 'username',
            }),
          }) + '<p class="note"><a href="/sign-in">Back to sign in</a></p>',
        }),
      });
    },
  },

  {
    // CSRF is not checked, for the same reason as sign-in: there is no session
    // yet to carry a token, and the request acts on nobody's behalf. The origin
    // check and SameSite still apply.
    path: '/forgot', method: 'POST', auth: false,
    handle: ({ ctx, body, throttle, address }) => {
      if (!emailConfigured(ctx)) {
        return {
          status: 503,
          html: layout({
            title: 'Reset your password',
            body: page({
              title: 'Reset your password',
              body: banner({ tone: 'warn', says: NO_EMAIL.says })
                + `<p class="note">${h(NO_EMAIL.detail)}</p>`,
            }),
          }),
        };
      }

      // Counted before anything else. This is the one form that makes the
      // product send mail to an address somebody else typed.
      const gate = throttle.check('password-reset', address);
      if (!gate.allowed) return tooMany('Reset your password', gate.retryAfter);

      const result = auth.requestPasswordReset(ctx, {
        email: body.email,
        baseUrl: ctx.baseUrl,
        // The only place the failure is visible. Not to the person asking —
        // telling them would reveal that their address caused a send, which is
        // the fact this form exists not to reveal.
        onSendFailure: (err) => {
          console.error(`[email] password reset not accepted by the provider: ${err?.code ?? 'unknown'}`);
        },
      });

      // One page, one sentence, whatever happened underneath.
      return {
        html: layout({
          title: 'Check your email',
          body: page({
            title: 'Check your email',
            body: banner({ tone: 'good', says: result.body.says })
              + '<p class="note">Nothing arrived? The address may not have an account here, or the '
              + 'message may be in a spam folder. You can <a href="/forgot">ask again</a>.</p>',
          }),
        }),
      };
    },
  },

  {
    // A GET that looks at the token and does NOT spend it. A mail client that
    // prefetches links would otherwise burn every reset link before its owner
    // clicked one.
    path: '/reset/:link', method: 'GET', auth: false,
    handle: ({ ctx, params }) => {
      const state = auth.resolveReset(ctx, params.link);
      if (!state.usable) {
        return {
          status: 400,
          html: layout({
            title: 'Reset your password',
            body: page({
              title: 'Reset your password',
              body: banner({ tone: 'warn', says: state.says })
                + '<p class="note"><a href="/forgot">Ask for a new link</a></p>',
            }),
          }),
        };
      }

      return render({
        title: 'Set a new password',
        body: page({
          title: 'Set a new password',
          lede: 'Setting a new password signs out every browser that is currently signed in to this '
              + 'account, including any you have forgotten about.',
          body: form({
            action: `/reset/${encodeURIComponent(params.link)}`, csrf: '', submit: 'Set password',
            body: field({
              name: 'password', label: 'New password', type: 'password', required: true,
              autocomplete: 'new-password',
              hint: `At least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password hard `
                  + 'to guess — a long ordinary phrase beats a short complicated one.',
            }),
          }),
        }),
      });
    },
  },

  {
    path: '/reset/:link', method: 'POST', auth: false,
    handle: ({ ctx, params, body }) => {
      try {
        auth.completePasswordReset(ctx, { token: params.link, password: body.password });
        // Not signed in automatically. Every session was just ended, including
        // any this browser held, and signing somebody in off the back of a
        // link in an inbox is the thing the sessions were ended to prevent.
        return { redirect: '/sign-in?reset=1', headers: { 'Set-Cookie': clearCookie({ secure: true }) } };
      } catch (err) {
        // A refused password leaves the link alive, so the form comes back with
        // the reason rather than sending somebody to their inbox again.
        const alive = err.code === 'password_rejected';
        return {
          status: err.status ?? 400,
          html: layout({
            title: 'Set a new password',
            body: page({
              title: 'Set a new password',
              body: refusal(err) + (alive
                ? form({
                  action: `/reset/${encodeURIComponent(params.link)}`, csrf: '', submit: 'Set password',
                  body: field({
                    name: 'password', label: 'New password', type: 'password', required: true,
                    autocomplete: 'new-password',
                    hint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
                  }),
                })
                : '<p class="note"><a href="/forgot">Ask for a new link</a></p>'),
            }),
          }),
        };
      }
    },
  },

  {
    path: '/sign-out', method: 'POST',
    handle: ({ ctx, session }) => {
      auth.signOut(ctx, session?.id);
      return { redirect: '/sign-in', headers: { 'Set-Cookie': clearCookie({ secure: true }) } };
    },
  },

  {
    path: '/account', method: 'GET',
    handle: ({ user, session, query }) => render({
      title: 'Your account', user: { ...user, csrf: session.csrf_token },
      flash: query.get('changed') ? { tone: 'good', says: 'Password changed. Every other session was signed out.' } : null,
      body: page({
        title: 'Your account',
        body: section({
          title: 'Change your password',
          note: 'Changing it signs out every other browser you are signed in on.',
          body: form({
            action: '/account/password', csrf: session.csrf_token, submit: 'Change password',
            body: field({ name: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' })
              + field({ name: 'next', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD_LENGTH} characters.` }),
          }),
        }) + section({
          title: 'Signed in as',
          body: `<p>${h(user.email)}</p>`,
        }),
      }),
    }),
  },

  {
    path: '/account/password', method: 'POST',
    handle: ({ ctx, user, session, body }) => {
      try {
        auth.changePassword(ctx, user.id, { current: body.current, next: body.next });
        // Every session ended, including this one. Signing back in is the honest
        // outcome of "this signs you out everywhere".
        return { redirect: '/sign-in?changed=1', headers: { 'Set-Cookie': clearCookie({ secure: true }) } };
      } catch (err) {
        return {
          status: err.status ?? 400,
          html: layout({
            title: 'Your account', user: { ...user, csrf: session.csrf_token },
            body: page({ title: 'Your account', body: refusal(err) + '<p><a href="/account">Try again</a></p>' }),
          }),
        };
      }
    },
  },
];
