/**
 * The advisor contract.
 *
 * As with `src/extract/interface.js`, this is the seam where the tested part
 * stops. An advisor is a language model. What it returns is checked
 * exhaustively; what it chooses to say is not predictable and is not claimed to
 * be.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 *
 *   {
 *     id:      'anthropic-advisor-v1',
 *     version: '2026-10-01',
 *
 *     async answer({ question, context, history }) -> {
 *       sections: [{
 *         heading: string | null,
 *         claims: [{ text: string, cites: string[] }],
 *       }],
 *       staleness_acknowledged?: boolean,
 *       cannot_answer?: { why: string },
 *     }
 *   }
 *
 * `context` is the entire permitted world for the turn: the organisation's
 * usable facts, the retrieved knowledge records, figures the app calculated,
 * and the open gaps. Nothing outside it may be used.
 *
 * Citations are `fact:<id>`, `knowledge:<id>`, `criterion:<ref>`,
 * `figure:<ref>` or `gap:<id>`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT AN ADVISOR MAY NOT DO
 *
 * 1. It may not emit a claim with no citations. There is no "general knowledge"
 *    exemption, and there is no claim obvious enough to be exempt.
 *
 * 2. It may not cite anything not in `context`. A reference to a plausible
 *    record id that was not retrieved is a fabricated citation, which is worse
 *    than an uncited claim: it carries the appearance of having been checked.
 *
 * 3. It may not write a numeral that is not in something it cites. Not an
 *    estimate, not a rounded figure it recalls, not an illustrative example.
 *    If the question needs a number nobody has supplied, the answer is that
 *    nobody has supplied it.
 *
 * 4. It may not value a company, predict an outcome, issue a readiness verdict,
 *    give legal, tax or accounting advice, speak for what investors "require",
 *    assert a benchmark, or suggest who to approach.
 *
 * 5. When the context does not contain the answer, it returns `cannot_answer`
 *    with a reason. That is a successful turn. An answer assembled from what
 *    the model happens to remember is the failure this whole architecture
 *    exists to prevent, and it is indistinguishable from a good answer at a
 *    glance.
 *
 * Every one of these is enforced in `src/domain/advisor.js` and tested. The
 * list is here so that whoever implements a real advisor knows what the
 * validator will do before they meet it.
 */

export const ADVISOR_CONTRACT_VERSION = '1';

export class AdvisorProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function assertAdvisor(advisor) {
  if (!advisor || typeof advisor !== 'object') {
    throw new AdvisorProviderError('no_advisor', 'an advisor is required');
  }
  for (const field of ['id', 'version']) {
    if (!advisor[field]) {
      throw new AdvisorProviderError('advisor_unidentified',
        `an advisor must carry ${field} — every stored answer records which model produced it, so that an `
        + 'answer given today is still explicable after the model has been replaced');
    }
  }
  if (typeof advisor.answer !== 'function') {
    throw new AdvisorProviderError('advisor_incomplete', 'an advisor must implement answer()');
  }
  return advisor;
}
