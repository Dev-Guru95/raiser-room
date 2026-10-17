/**
 * The email contract.
 *
 * The fourth seam, alongside `src/advisor/interface.js`,
 * `src/translate/interface.js` and `src/billing/interface.js`, and the only one
 * whose absence stops a person getting back into their own account. It is
 * therefore the one seam where "not configured" has to be said on the page
 * rather than discovered at the moment somebody needs it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 *
 *   {
 *     id:      'postmark-v1',
 *     version: '2026-10-15',
 *
 *     async send({ to, subject, text, html, tag }) -> { id }
 *   }
 *
 * `to` is ONE address. There is no `cc`, no `bcc` and no array, and that is
 * deliberate: every message this product sends is addressed to one person about
 * their own account, and a bulk interface is the thing a mistake needs in order
 * to become a disclosure.
 *
 * `text` is required and `html` is optional. A message that exists only as HTML
 * is a message some readers receive blank.
 *
 * `tag` is a coarse label — `password-reset`, `invite` — for the provider's own
 * dashboard. It carries no organisation and no person, for the same reason
 * `usage_counter` does not.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT AN IMPLEMENTATION IS SENT, AND WHAT IT IS NEVER SENT
 *
 * Sent: one address, a subject, and a body assembled from the catalogue in
 * `src/email/messages.js` — which is in git, reviewable, and tested.
 *
 * Never sent: a figure from the company's accounts, a fact, a document, a
 * filename from the data room, or the name of a counterparty. The privacy
 * policy names an email provider as a sub-processor and says what it receives;
 * `email.test.js` holds the catalogue to that, so the commitment is enforced
 * where it can be rather than promised where it cannot.
 *
 * This is why the catalogue exists at all. A handler that composes its own
 * subject line is a handler that can put a customer's revenue in a subject line
 * on a Friday afternoon, and nothing would fail.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT `send()` RETURNING MEANS, AND WHAT IT DOES NOT
 *
 * It means the provider ACCEPTED the message. It does not mean anybody received
 * it, and nothing in this product claims otherwise: there is no "delivered"
 * state, no read receipt, and no retry queue. A bounce is visible in the
 * provider's own dashboard and nowhere in here.
 *
 * That is a real limitation and it is written down rather than hidden, because
 * the alternative — a delivery table that is only ever approximately true — is
 * worse than not having one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW A FAILURE MUST BE HANDLED BY THE CALLER
 *
 * `send()` throws `EmailProviderError`. What the caller does with it differs by
 * route, and getting this wrong undoes a guarantee elsewhere:
 *
 *   · A password reset request must answer identically whether the address has
 *     an account, whether the provider accepted the message, and whether the
 *     provider was down. A 502 on the reset form is an account enumerator — it
 *     fires only for addresses that exist, because only those cause a send.
 *
 *   · An invite may report the failure, because the person asking already knows
 *     the address they typed and is inside an organisation they belong to.
 */

export const EMAIL_CONTRACT_VERSION = '1';

export class EmailProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Check an implementation before it is wired in, not at the moment it is first
 * needed — which, for this seam, is somebody locked out of their account.
 */
export function assertEmailer(emailer) {
  if (!emailer || typeof emailer !== 'object') {
    throw new EmailProviderError('no_emailer', 'an email provider is required');
  }
  for (const field of ['id', 'version']) {
    if (!emailer[field]) {
      throw new EmailProviderError('emailer_unidentified',
        `an email provider must carry ${field} — a deployment that cannot say which provider sent `
        + 'last month\'s mail cannot answer a deliverability question, and the privacy policy names '
        + 'the provider by name');
    }
  }
  if (typeof emailer.send !== 'function') {
    throw new EmailProviderError('emailer_incomplete', 'an email provider must implement send()');
  }
  return emailer;
}

/**
 * The shape check that runs on every outgoing message.
 *
 * Here rather than in the implementation, so that a provider adapter cannot
 * decide to be lenient about it.
 */
export function assertMessage(message) {
  const { to, subject, text } = message ?? {};
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    throw new EmailProviderError('invalid_recipient', 'one deliverable address is required', 400);
  }
  if (!subject || !String(subject).trim()) {
    throw new EmailProviderError('invalid_subject', 'a subject is required', 400);
  }
  if (!text || !String(text).trim()) {
    throw new EmailProviderError('invalid_body',
      'a plain-text body is required — an HTML-only message arrives blank for some readers', 400);
  }
  // A newline in a header is header injection: it lets the body of a subject
  // line become a second header, and `Bcc:` is the one that matters.
  if (/[\r\n]/.test(String(to)) || /[\r\n]/.test(String(subject))) {
    throw new EmailProviderError('header_injection',
      'a recipient or subject containing a newline is refused', 400);
  }
  return message;
}
