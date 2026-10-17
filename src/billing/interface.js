/**
 * The billing provider contract.
 *
 * The fourth seam of this kind, and the one with the sharpest edges: the others
 * can produce a wrong document, this one can take somebody's money.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 *
 *   {
 *     id:      'whop',
 *     version: '2026-10-01',
 *
 *     // Verify a webhook came from the provider. Signature over the RAW body.
 *     verify({ body, headers, secret }) -> { ok: true, event } | { ok: false, why }
 *
 *     // What the provider currently believes about a subscription.
 *     async fetchSubscription(providerRef) -> {
 *       provider_ref, plan_ref, state, term, current_period_end, seats?
 *     }
 *
 *     // Record a credit against a subscription. Idempotent on `idempotency_key`.
 *     async applyCredit({ providerRef, amountMinor, currency, reason, idempotencyKey })
 *       -> { provider_ref }
 *
 *     // Where to send somebody to subscribe or to fix a card.
 *     checkoutUrl({ planRef, term, orgId }) -> string
 *     portalUrl({ providerRef }) -> string
 *   }
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PRODUCT NEVER DOES
 *
 * 1. **Hold a card.** No card number, no expiry, no CVC, no token that could be
 *    charged, ever, in any table. The provider's hosted checkout takes payment
 *    and this product never sees it. There is no PCI scope to manage because
 *    there is nothing in scope.
 *
 * 2. **Store a price.** The provider holds the plan and what it costs. A price
 *    in two places disagrees eventually, and the copy that is wrong is the one
 *    shown to the customer.
 *
 * 3. **Trust a webhook it has not verified.** An unverified webhook is an
 *    unauthenticated request that upgrades accounts, and the endpoint is public.
 *    Verification happens before the body is parsed for meaning, and a failure
 *    is recorded rather than silently dropped — a run of failures is either an
 *    attack or a rotated secret, and both need to be visible.
 *
 * 4. **Decide a subscription's state from its own arithmetic.** Whether somebody
 *    has paid is the provider's fact, not ours. This product records what it was
 *    told, when it was told, and what it did about it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ON SIGNATURE COMPARISON
 *
 * Compare in constant time. A webhook verifier that uses `===` leaks the
 * expected signature a byte at a time to anyone willing to send enough requests,
 * and the endpoint is, by necessity, reachable by anyone.
 */

import { timingSafeEqual, createHmac } from 'node:crypto';

export const BILLING_CONTRACT_VERSION = '1';

export class BillingProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new BillingProviderError('no_provider', 'a billing provider is required');
  }
  for (const field of ['id', 'version']) {
    if (!provider[field]) {
      throw new BillingProviderError('provider_unidentified',
        `a billing provider must carry ${field} — a billing dispute is answered from the record of `
        + 'which system said what, and when');
    }
  }
  for (const method of ['verify', 'fetchSubscription', 'applyCredit']) {
    if (typeof provider[method] !== 'function') {
      throw new BillingProviderError('provider_incomplete',
        `a billing provider must implement ${method}()`);
    }
  }
  return provider;
}

/**
 * HMAC-SHA256 over the raw body, compared in constant time.
 *
 * Offered here so a provider implementation does not have to get this right
 * again. The raw body matters: re-serialising JSON before signing produces a
 * different byte sequence and a signature that never matches, which is usually
 * discovered by disabling verification.
 */
export function verifyHmac({ rawBody, signature, secret, algorithm = 'sha256' }) {
  if (!secret) return { ok: false, why: 'no signing secret is configured' };
  if (!signature) return { ok: false, why: 'the request carried no signature' };

  const expected = createHmac(algorithm, secret).update(String(rawBody ?? ''), 'utf8').digest('hex');
  const given = String(signature).trim().replace(/^sha256=/i, '');

  // Length is checked first because `timingSafeEqual` throws on a mismatch —
  // and the length of a signature is not a secret.
  if (given.length !== expected.length) return { ok: false, why: 'signature length does not match' };

  const same = timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
  return same ? { ok: true } : { ok: false, why: 'signature does not match' };
}
