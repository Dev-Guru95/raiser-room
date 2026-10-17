/**
 * A deterministic billing provider for tests and local development.
 *
 * As with the other fakes, the second job matters more than the first: this one
 * reproduces the ways a real billing integration goes wrong, and every one of
 * them has cost somebody money in some product somewhere.
 *
 *   · the same webhook delivered five times (every provider retries)
 *   · a cancellation arriving after the renewal that superseded it
 *   · an event type nobody has mapped yet, because the provider shipped a
 *     feature on a Tuesday
 *   · a webhook with a signature from a rotated secret
 *   · a credit applied twice because the first response was lost in transit
 */

import { createHmac } from 'node:crypto';

export function fakeBillingProvider({
  id = 'fake-billing',
  version = 'test-1',
  secret = 'test-secret',
  subscriptions = {},
  behaviour = 'normal',
} = {}) {
  const creditsApplied = new Map();

  return {
    id,
    version,
    secret,
    creditsApplied,

    verify({ rawBody, signature } = {}) {
      if (behaviour === 'verification_always_fails') return { ok: false, why: 'rejected for the test' };
      const expected = createHmac('sha256', secret).update(String(rawBody ?? ''), 'utf8').digest('hex');
      if (String(signature ?? '') !== expected) return { ok: false, why: 'signature does not match' };
      return { ok: true };
    },

    async fetchSubscription(providerRef) {
      if (behaviour === 'unreachable') throw new Error('provider unreachable');
      const found = subscriptions[providerRef];
      if (!found) throw new Error(`no subscription ${providerRef}`);
      return { provider_ref: providerRef, ...found };
    },

    /**
     * Idempotent on the key, which is the whole point.
     *
     * A lost response is indistinguishable from a failed request, so the caller
     * retries — and a provider that is not idempotent credits twice.
     */
    async applyCredit({ providerRef, amountMinor, currency, idempotencyKey }) {
      if (behaviour === 'credit_fails') throw new Error('credit could not be applied');
      if (creditsApplied.has(idempotencyKey)) {
        return { provider_ref: creditsApplied.get(idempotencyKey), replayed: true };
      }
      const ref = `credit_${creditsApplied.size + 1}`;
      creditsApplied.set(idempotencyKey, ref);
      void providerRef; void amountMinor; void currency;
      return { provider_ref: ref, replayed: false };
    },

    checkoutUrl: ({ planRef, term, orgId }) =>
      `https://billing.test/checkout/${planRef}?term=${term}&ref=${orgId}`,
    portalUrl: ({ providerRef }) => `https://billing.test/portal/${providerRef}`,
  };
}

/** A signed webhook, as a provider would send it. */
export function signedWebhook(payload, secret = 'test-secret') {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    signature: createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
  };
}
