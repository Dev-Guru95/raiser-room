/**
 * Which advisor this deployment is wired to, and what to say when it is none.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE RATHER THAN A LINE IN A ROUTE
 *
 * The advisor is the one capability in this product that needs a language
 * model, and no model provider is configured here. The tempting thing is to
 * leave the stub advisor wired in: the page loads, a question gets an answer of
 * sorts, and nothing looks broken. That is the worst option available, because
 * the stub returns `cannot_answer` for everything, and `cannot_answer` is a
 * legitimate and carefully written outcome — so a deployment with no advisor
 * would be indistinguishable from an advisor that genuinely had nothing to say.
 * Somebody evaluating the product would conclude the feature was poor rather
 * than absent.
 *
 * So the state is explicit. With no advisor configured, the page says there is
 * none and the ask form is not shown. Everything else on that page — the action
 * proposals, which are produced by rules rather than by a model — keeps working,
 * because those are the part of the advisor that was never a model to begin
 * with.
 */

import { fakeAdvisor } from '../advisor/fake.js';

export const NO_ADVISOR = {
  says: 'No advisor is configured on this deployment, so there is nothing to ask.',
  detail: 'The advisor answers only from your own records and a dated knowledge base, and it needs a '
        + 'language model behind it to assemble that answer. Everything else on this page is produced '
        + 'by rules rather than by a model, and works regardless.',
};

/**
 * Resolve the advisor for a request.
 *
 * `ctx.advisor` is set at boot when one is configured. The stub is used only
 * where a caller asked for it explicitly — the tests — never as a silent
 * fallback.
 */
export function advisorFor(req) {
  return req?.ctx?.advisor ?? null;
}

export function advisorConfigured(req) {
  return Boolean(advisorFor(req));
}

/** The stub, for tests and for a local walkthrough that wants the page to post. */
export { fakeAdvisor };
