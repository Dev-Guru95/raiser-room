/**
 * The billing provider, implemented against the one this product was designed
 * for.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A VENDOR NAME IN THIS FILE, AND NOWHERE ELSE
 *
 * The rule is that no vendor name appears in `src/` — a vendor compiled into
 * the application is a vendor nobody can change without a code review. This
 * file is the exception the rule exists to make possible: it is the adapter,
 * it is named after what it adapts, and nothing imports it except
 * `server.mjs`. The service layer knows only `src/billing/interface.js`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SIGNATURE SCHEME, WHICH IS NOT THE ONE THE INTERFACE'S HELPER IMPLEMENTS
 *
 * `verifyHmac()` in `src/billing/interface.js` computes a hex HMAC over the raw
 * body alone. That is the common scheme and it is NOT this provider's. This one
 * signs three fields joined by dots and base64-encodes the result:
 *
 *     HMAC-SHA256( `${webhook-id}.${webhook-timestamp}.${rawBody}` )
 *
 * carried as `webhook-signature: v1,<base64>`, alongside `webhook-id` and
 * `webhook-timestamp`. So this adapter implements it rather than calling the
 * helper, and the helper is left alone because other providers do use it.
 *
 * Getting this wrong fails closed — every webhook is rejected — which is the
 * right direction, and is also why the usual next step is to disable
 * verification "just to test the rest". Do not. An unverified webhook endpoint
 * is a public form for granting yourself a plan.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS CONFIRMED AND WHAT IS NOT
 *
 * Confirmed from the provider's published webhook documentation: the three
 * header names, the signed string, HMAC-SHA256, the base64 encoding, the `v1,`
 * prefix, the five-minute timestamp window, and that retries reuse
 * `webhook-id` so a handler must be idempotent on it.
 *
 * NOT confirmed, and the one thing to check before this goes live: how the
 * signing secret is turned into the HMAC key. The documentation says to pass
 * the secret exactly as issued, prefix and all, because "the helper derives the
 * key" — without saying what the derivation is. Two readings are plausible:
 * the key is the secret's literal bytes, or the key is the part after the
 * prefix, base64-decoded, as the Standard Webhooks convention does.
 *
 * So `keyFrom` is a named option with both implementations available and
 * `'literal'` as the default. Send one real test webhook from the provider's
 * dashboard; if it fails to verify, switch to `'standard'`. That is a
 * one-character change and a five-minute test, and it is written down here
 * rather than guessed at silently, because a verifier that is wrong in this
 * particular way rejects every webhook and looks exactly like a rotated
 * secret.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES NOT DO
 *
 * Hold a price, or map one. The product's plan keys are FREE, RAISEROOM and
 * FIRM and the amounts live in `src/domain/billing.js`; what the provider
 * charges lives with the provider. The mapping here is between the product's
 * plan keys and the provider's plan ids, and nothing else — no amounts, no
 * currencies, no intervals.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { BillingProviderError } from './interface.js';

/** The provider's own API, versioned in the path. */
const DEFAULT_API_BASE = 'https://api.whop.com/api/v5';

/** How far out of date a webhook's timestamp may be. The provider's own limit. */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Derive the HMAC key from the issued secret.
 *
 * See the note above: which of these is right is the one unconfirmed detail in
 * this adapter, and it is a named choice rather than a buried assumption.
 */
export const KEY_DERIVATIONS = Object.freeze({
  /** The secret's literal bytes, prefix included, as the documentation's wording suggests. */
  literal: (secret) => Buffer.from(String(secret), 'utf8'),
  /** The Standard Webhooks convention: drop the prefix, base64-decode the rest. */
  standard: (secret) => Buffer.from(String(secret).replace(/^[a-z]+_/i, ''), 'base64'),
});

/**
 * Build the provider.
 *
 * @param {object}   config
 * @param {string}   config.apiKey        server-side API key. Never sent to a browser.
 * @param {string}   config.webhookSecret the signing secret, exactly as issued.
 * @param {object}   config.plans         product plan key → the provider's plan id.
 * @param {string}  [config.keyFrom]      'literal' (default) or 'standard'. See above.
 * @param {string}  [config.apiBase]
 * @param {Function}[config.fetchImpl]    injected in tests; the global otherwise.
 */
export function whopProvider({
  apiKey,
  webhookSecret,
  plans = {},
  keyFrom = 'literal',
  apiBase = DEFAULT_API_BASE,
  fetchImpl = undefined,
  now = () => Date.now(),
} = {}) {
  if (!apiKey) {
    throw new BillingProviderError('no_api_key',
      'a billing provider needs an API key; leave the provider null in server.mjs rather than '
      + 'configuring half of one — the plan page then says checkout is not available, which is true');
  }
  if (!webhookSecret) {
    throw new BillingProviderError('no_webhook_secret',
      'a billing provider needs its webhook signing secret. Without it every webhook is rejected, '
      + 'which means a subscription is taken and the plan never changes');
  }
  if (!KEY_DERIVATIONS[keyFrom]) {
    throw new BillingProviderError('unknown_key_derivation',
      `keyFrom must be one of ${Object.keys(KEY_DERIVATIONS).join(', ')}`);
  }

  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const deriveKey = KEY_DERIVATIONS[keyFrom];

  /** The provider's plan id for one of the product's plan keys. */
  const planRefFor = (planKey) => plans[planKey] ?? null;

  async function call(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      // Retrying a credit must not apply it twice. The provider keys on this.
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
    };

    let res;
    try {
      res = await doFetch(`${apiBase}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // A network failure is not a billing decision. The caller records what it
      // was told, and it was told nothing.
      throw new BillingProviderError('provider_unreachable',
        `the billing provider could not be reached (${err?.code ?? err?.message ?? 'unknown'})`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new BillingProviderError('provider_refused',
        `the billing provider answered ${res.status} for ${method} ${path}: ${text.slice(0, 300)}`,
        res.status === 404 ? 404 : 502);
    }

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new BillingProviderError('provider_unparseable',
        'the billing provider answered with something that is not JSON');
    }
  }

  return {
    id: 'whop',
    version: '2026-10-16',
    secret: webhookSecret,

    // ── the webhook ────────────────────────────────────────────────────────
    /**
     * Verify a webhook.
     *
     * Synchronous and total: it returns `{ ok }` rather than throwing, because
     * the caller records every failure as a `billing_event` and a throw here
     * would lose that record. `{ ok: false, why }` is a normal outcome of a
     * public endpoint.
     */
    verify({ rawBody, headers = {}, secret = webhookSecret } = {}) {
      // Headers arrive lower-cased from Node, but a test or another transport
      // may not, so this does not assume it.
      const header = (name) => {
        const direct = headers[name];
        if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
        const found = Object.keys(headers).find((k) => k.toLowerCase() === name);
        const value = found ? headers[found] : undefined;
        return Array.isArray(value) ? value[0] : value;
      };

      const id = header('webhook-id');
      const timestamp = header('webhook-timestamp');
      const signature = header('webhook-signature');

      if (!secret) return { ok: false, why: 'no signing secret is configured' };
      if (!id) return { ok: false, why: 'the request carried no webhook-id' };
      if (!timestamp) return { ok: false, why: 'the request carried no webhook-timestamp' };
      if (!signature) return { ok: false, why: 'the request carried no webhook-signature' };

      // Replay window, before any cryptography: a signature that is valid
      // forever is a request anybody who ever saw it can send again.
      const sent = Number(timestamp);
      if (!Number.isFinite(sent)) return { ok: false, why: 'webhook-timestamp is not a number' };
      const driftSeconds = Math.abs(Math.floor(now() / 1000) - sent);
      if (driftSeconds > TIMESTAMP_TOLERANCE_SECONDS) {
        return {
          ok: false,
          why: `webhook-timestamp is ${driftSeconds}s away from now, outside the `
            + `${TIMESTAMP_TOLERANCE_SECONDS}s window`,
        };
      }

      const signed = `${id}.${timestamp}.${String(rawBody ?? '')}`;
      const expected = createHmac('sha256', deriveKey(secret)).update(signed, 'utf8').digest('base64');

      // The header may carry several space-separated versioned signatures. Any
      // one matching is a match, which is what makes a secret rotation
      // survivable.
      const offered = String(signature).split(/\s+/).filter(Boolean)
        .map((part) => (part.includes(',') ? part.slice(part.indexOf(',') + 1) : part));

      const expectedBuf = Buffer.from(expected, 'utf8');
      const matched = offered.some((candidate) => {
        const buf = Buffer.from(candidate, 'utf8');
        // Length first: timingSafeEqual throws on a mismatch, and the length of
        // a signature is not a secret.
        return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
      });

      if (!matched) return { ok: false, why: 'signature does not match' };

      // `event_ref` is what the caller deduplicates on, and retries reuse
      // `webhook-id` — so that is the id to hand back, not one out of the body.
      return { ok: true, event: { id } };
    },

    // ── reading the provider's own view ────────────────────────────────────
    /**
     * What the provider currently believes about a subscription.
     *
     * Shaped into the contract's fields rather than passed through, so the
     * provider's own spelling never reaches the service layer.
     */
    async fetchSubscription(providerRef) {
      if (!providerRef) {
        throw new BillingProviderError('no_provider_ref', 'a subscription reference is required', 400);
      }
      const row = await call(`/memberships/${encodeURIComponent(providerRef)}`);
      const m = row?.data ?? row;

      return {
        provider_ref: m?.id ?? providerRef,
        plan_ref: m?.plan_id ?? m?.plan?.id ?? null,
        state: m?.status ?? m?.state ?? null,
        term: m?.billing_period ?? m?.term ?? null,
        current_period_end: m?.renewal_period_end ?? m?.current_period_end ?? null,
        seats: m?.quantity ?? m?.seats ?? null,
      };
    },

    /**
     * Record a credit against a subscription.
     *
     * Idempotent on `idempotencyKey`: the $147 credit is guarded twice in this
     * product already, and this is the third guard, at the provider.
     */
    async applyCredit({ providerRef, amountMinor, currency, reason, idempotencyKey }) {
      if (!providerRef) {
        throw new BillingProviderError('no_provider_ref', 'a subscription reference is required', 400);
      }
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new BillingProviderError('invalid_credit_amount',
          'a credit is a positive whole number of minor units', 400);
      }
      if (!idempotencyKey) {
        throw new BillingProviderError('no_idempotency_key',
          'a credit without an idempotency key can be applied twice by a retry', 400);
      }

      const row = await call(`/memberships/${encodeURIComponent(providerRef)}/credits`, {
        method: 'POST',
        idempotencyKey,
        body: {
          amount: amountMinor,
          currency: String(currency ?? 'USD').toUpperCase(),
          notes: String(reason ?? '').slice(0, 500),
        },
      });

      return { provider_ref: row?.data?.id ?? row?.id ?? providerRef };
    },

    // ── where somebody is sent ─────────────────────────────────────────────
    /**
     * Where to send somebody to subscribe.
     *
     * `orgId` rides along as a reference the webhook comes back with, which is
     * how a payment is attached to an organisation without this product ever
     * seeing a card. It is an opaque id, not a name — nothing about the company
     * travels to the provider in a query string.
     */
    checkoutUrl({ planRef, planKey, term, orgId }) {
      const ref = planRef ?? planRefFor(planKey);
      if (!ref) {
        throw new BillingProviderError('unmapped_plan',
          `no provider plan is configured for ${planKey ?? '(no plan key)'} — create the plans at the `
          + 'provider to match FREE, RAISEROOM and FIRM, and map them in server.mjs', 500);
      }
      const url = new URL(`https://whop.com/checkout/${encodeURIComponent(ref)}`);
      if (orgId) url.searchParams.set('metadata[org_id]', String(orgId));
      if (term) url.searchParams.set('metadata[term]', String(term));
      return url.toString();
    },

    /**
     * Where somebody manages or cancels.
     *
     * Null when there is nothing to link to, which the plan page handles by
     * saying cancellation is not available here rather than offering a dead
     * link.
     */
    portalUrl({ providerRef } = {}) {
      if (!providerRef) return null;
      return `https://whop.com/orders/${encodeURIComponent(providerRef)}`;
    },

    /** Exposed for the plan page's own sanity check and for tests. */
    planRefFor,
  };
}
