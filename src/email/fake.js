/**
 * A deterministic email provider, for tests.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 *
 * It is the reference a real adapter is held to: point your implementation at
 * `email.test.js` and it has to behave the same way at the seam. It records
 * what it was asked to send so a test can assert on the message, which is the
 * only way to prove "the reset form reveals nothing" — that claim is about what
 * the page says versus what the mail says, so a test needs both halves.
 *
 * It is NOT wired into the running application, for the reason given in
 * `src/web/advisor.js` and repeated in rule 12 of the extension rules: a fake
 * that silently accepts everything is indistinguishable from a provider that is
 * working, so a deployment with no provider configured would look fine until the
 * first person was locked out. `server.mjs` is where a real one goes, and with
 * none there the reset page says so in a sentence.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FAILURE MODES IT CAN BE ASKED TO PERFORM
 *
 * Every one of these is a thing a real provider does, and each one is a
 * different bug in the caller if the caller gets it wrong:
 *
 *   `fails: true`          the provider is down. A reset request must still
 *                          answer exactly as it does on success, or the error
 *                          page becomes an account enumerator.
 *   `rejects: 'address'`   the provider refuses the recipient as undeliverable.
 *   `slow: true`           accepted, but nothing arrives for a while. There is
 *                          no delivery state in this product, which is what
 *                          makes this indistinguishable from success — on
 *                          purpose, and written down rather than papered over.
 */

import { assertMessage, EmailProviderError } from './interface.js';

export function fakeEmailer({ fails = false, rejects = null, slow = false } = {}) {
  /** Every message accepted, oldest first. */
  const sent = [];
  let counter = 0;

  return {
    id: 'fake-emailer',
    version: '2026-10-15',

    async send(message) {
      // Shape first, so a caller that composes a malformed message is caught
      // here rather than by a provider's API returning something unhelpful.
      assertMessage(message);

      if (fails) {
        throw new EmailProviderError('provider_unavailable', 'the email provider did not accept the message');
      }
      if (rejects && String(message.to).includes(String(rejects))) {
        throw new EmailProviderError('undeliverable', 'the provider refused that address', 400);
      }

      const record = { ...message, id: `fake-${++counter}`, accepted_at: counter, delivered: !slow };
      sent.push(record);
      return { id: record.id };
    },

    // ── test surface ────────────────────────────────────────────────────────
    /** Everything accepted. */
    sent: () => sent.slice(),
    /** The most recent message, or null. */
    last: () => (sent.length ? { ...sent[sent.length - 1] } : null),
    /** Messages carrying a given tag. */
    tagged: (tag) => sent.filter((m) => m.tag === tag),
    /** Forget everything, for a test that reuses one provider across cases. */
    reset: () => { sent.length = 0; },
  };
}
