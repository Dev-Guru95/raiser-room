/**
 * The billing webhook.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE DID NOT EXIST
 *
 * The handover says the webhook endpoint already exists and is tested against a
 * fake provider. The second half is true: `api/billing.js: handleWebhook` is
 * written and `billing.test.js` covers verification, replay and out-of-order
 * delivery. The first half was not — nothing in `src/web/` called it, so there
 * was no URL to give a provider, and no route could even have received the raw
 * bytes a signature covers.
 *
 * So this is the endpoint, and `raw: true` in `src/web/server.js` is what lets
 * it see the body as it arrived.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PATH CARRIES NO VENDOR NAME
 *
 * `/webhooks/billing`, not the provider's name. The provider is configured in
 * `server.mjs` and changing it should not mean changing a URL that a third
 * party has in its dashboard — which is the kind of migration that gets done at
 * the wrong time of day.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT ANSWERS 200 TO A WEBHOOK IT COULD NOT APPLY
 *
 * Two different failures, two different answers:
 *
 *   · UNVERIFIED → 401. The caller is not the provider, or the secret has been
 *     rotated. The service layer has already recorded it as a `billing_event`
 *     so a run of them is visible, and a 401 tells an honest provider that
 *     retrying will not help.
 *
 *   · VERIFIED BUT NOT APPLIED → 200. A duplicate, an event about a
 *     subscription this product does not know, an event type it ignores. The
 *     provider did its job; retrying changes nothing; and a provider that
 *     receives a 4xx or 5xx will retry for hours and then disable the endpoint,
 *     which turns a shrug into an outage.
 *
 * Anything actually broken still throws, and the error page's reference is how
 * it gets matched to a stack trace.
 */

import * as billing from '../../api/billing.js';

export const webhookRoutes = [
  {
    path: '/webhooks/billing',
    method: 'POST',
    // Not a browser form: there is no session, no CSRF token and no Origin.
    // What authorises it is the signature over the raw body, checked before the
    // body is parsed for meaning.
    auth: false,
    raw: true,
    handle: ({ ctx, rawBody, req }) => {
      if (!ctx.payments) {
        // No provider configured, so nothing can be verified, so nothing may be
        // believed. 503 rather than 404: the endpoint exists and the deployment
        // is incomplete, and a provider reading its own delivery log should be
        // able to tell those apart.
        return {
          status: 503,
          contentType: 'application/json; charset=utf-8',
          html: JSON.stringify({ ok: false, why: 'no billing provider is configured' }),
        };
      }

      try {
        const result = billing.handleWebhook(
          ctx,
          {
            rawBody,
            // Some providers put the signature in a header this product does not
            // name. The adapter reads whichever header it uses out of `headers`;
            // this is the common case, passed for the adapters that expect it.
            signature: req?.headers?.['webhook-signature'] ?? req?.headers?.['x-signature'] ?? null,
            headers: req?.headers ?? {},
          },
          ctx.payments,
        );

        return {
          contentType: 'application/json; charset=utf-8',
          html: JSON.stringify({ ok: true, applied: Boolean(result?.body?.applied) }),
        };
      } catch (err) {
        if (err.code === 'webhook_unverified') {
          return {
            status: 401,
            contentType: 'application/json; charset=utf-8',
            html: JSON.stringify({ ok: false, why: 'unverified' }),
          };
        }
        // A verified webhook this product chose not to act on is not a failure
        // of the provider's, and a retry would not change it.
        if (err.status === 400 || err.status === 404 || err.status === 409) {
          return {
            contentType: 'application/json; charset=utf-8',
            html: JSON.stringify({ ok: true, applied: false, why: err.code }),
          };
        }
        throw err;
      }
    },
  },
];
