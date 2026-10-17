/**
 * Which billing provider this deployment is wired to, and what the plan page
 * does without one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE CASE FOR BEING BLUNT HERE
 *
 * Billing is the one place where a plausible-looking stub does real damage. A
 * checkout button that leads somewhere pretend produces an organisation that
 * believes it is subscribed, a subscription row nobody is paying for, and a
 * conversation about a refund later. A page that says "no payment provider is
 * configured" produces a question, which is the correct outcome.
 *
 * So there is no fallback. With no provider:
 *
 *   · The plans are still listed, with what each includes, because that is
 *     information rather than a transaction.
 *   · There is no checkout button, and the page says why.
 *   · Everything already paid for keeps working. The entitlement check reads
 *     the subscription row, not this file.
 *
 * `grantDemonstration` is the deliberate exception and is not a payment: it
 * marks a subscription as a demonstration so the worked example can show the
 * whole product, and `billing.status` reports `demonstration: true` so no screen
 * can mistake it for a paying customer.
 */

import { fakeBillingProvider } from '../billing/fake.js';

export const NO_PROVIDER = {
  says: 'No payment provider is configured on this deployment, so a plan cannot be changed here.',
  detail: 'Everything already subscribed keeps working — entitlements are read from your own '
        + 'subscription record rather than from a provider. Nothing you have recorded is ever locked '
        + 'away from you in any case, including after a subscription ends.',
};

export function providerFor(req) {
  return req?.ctx?.payments ?? null;
}

export function providerConfigured(req) {
  return Boolean(providerFor(req));
}

export { fakeBillingProvider };
