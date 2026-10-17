/**
 * Every message this product can send, in one file, in git.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A CATALOGUE RATHER THAN A SUBJECT LINE AT THE CALL SITE
 *
 * The same argument as `src/knowledge/` makes for guidance: a string composed
 * inside a handler cannot be reviewed, cannot be diffed, and cannot be held to
 * a commitment made in the privacy policy. A handler that writes its own body
 * is a handler that can interpolate a customer's revenue into a subject line,
 * and nothing in the suite would notice.
 *
 * So a builder here takes named inputs and nothing else. There is no `data`
 * argument, no spread, and no template lookup by string — a figure cannot reach
 * a message because no builder accepts one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVERY LINK IS ABSOLUTE
 *
 * A relative link works in a browser and is dead in an email client. That is
 * what `BASE_URL` is for, and a builder refuses to run without it rather than
 * emitting `/reset/abc` and letting somebody discover it from a support
 * message.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PLAIN TEXT IS THE REAL MESSAGE
 *
 * The HTML is a courtesy. Corporate mail gateways strip it, some readers refuse
 * it, and the one message that absolutely must arrive — a password reset — is
 * the one most likely to be read through a filter. So the text body is written
 * first and says everything; the HTML says the same thing and adds nothing.
 */

import { EmailProviderError } from './interface.js';

/** How a link is built, in the one place that builds links. */
function link(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base || !/^https?:\/\//.test(base)) {
    throw new EmailProviderError('no_base_url',
      'BASE_URL is not set, so an email would carry a relative link that no mail client can '
      + 'follow. Set it before sending anything.', 500);
  }
  return `${base}${path}`;
}

/** Minimal escaping for the HTML courtesy copy. */
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const wrap = (paragraphs) => `<!doctype html><html><body style="font:16px/1.5 system-ui,sans-serif;color:#1a1a1a">`
  + paragraphs.map((p) => `<p>${p}</p>`).join('')
  + '</body></html>';

/**
 * A password reset.
 *
 * What it deliberately does NOT say: whether this address had an account before
 * today, which organisations it belongs to, or who else is on them. The request
 * form reveals nothing either way, and an email that says "your RaiseRoom
 * account for Northwind Systems" would undo that for anybody who can read a
 * screen over a shoulder.
 */
export function passwordReset({ to, baseUrl, token, minutes }) {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new EmailProviderError('invalid_expiry', 'a reset link needs a positive whole-minute life', 500);
  }
  const url = link(baseUrl, `/reset/${encodeURIComponent(String(token))}`);
  const life = minutes === 1 ? 'one minute' : `${minutes} minutes`;

  const text = [
    'Somebody asked to reset the password for this address on RaiseRoom.',
    '',
    'To set a new one, open this link:',
    url,
    '',
    `The link works once and expires in ${life}.`,
    '',
    'If that was not you, nothing has happened and nothing needs doing. The link',
    'cannot be used to read anything without setting a new password first, and',
    'setting a new password signs out every browser that is currently signed in.',
  ].join('\n');

  return {
    to,
    tag: 'password-reset',
    subject: 'Reset your RaiseRoom password',
    text,
    html: wrap([
      'Somebody asked to reset the password for this address on RaiseRoom.',
      `<a href="${esc(url)}">Set a new password</a>`,
      `The link works once and expires in ${esc(life)}.`,
      'If that was not you, nothing has happened and nothing needs doing.',
    ]),
  };
}

/**
 * An invitation to an organisation.
 *
 * The organisation's name IS included, and that is a considered decision rather
 * than an oversight: an invitation that does not say who sent it is
 * indistinguishable from phishing, and the first thing a careful recipient does
 * with one is delete it. It is the only customer-held string any message
 * carries, it goes only to the address somebody inside that organisation typed,
 * and it is named in the handover so the privacy policy's sub-processor wording
 * can be checked against it.
 *
 * What it does not carry: a figure, a document name, a counterparty, or the
 * names of anybody else on the organisation.
 */
export function invitation({ to, baseUrl, organisation, invitedBy = null }) {
  const org = String(organisation ?? '').trim();
  if (!org) {
    throw new EmailProviderError('invalid_invitation',
      'an invitation with no organisation name reads as phishing and is refused', 500);
  }
  const url = link(baseUrl, '/sign-up');
  const who = String(invitedBy ?? '').trim();

  const text = [
    who
      ? `${who} has invited you to ${org} on RaiseRoom.`
      : `You have been invited to ${org} on RaiseRoom.`,
    '',
    'RaiseRoom is where the company keeps the figures it will be asked for when it',
    'raises or sells, each one traceable to the document it came from.',
    '',
    'Create an account with this address and the invitation is waiting:',
    url,
    '',
    'If you were not expecting this, you can ignore it. Nothing is shared with you',
    'until you accept.',
  ].join('\n');

  return {
    to,
    tag: 'invite',
    subject: `You have been invited to ${org} on RaiseRoom`,
    text,
    html: wrap([
      who ? `${esc(who)} has invited you to <strong>${esc(org)}</strong> on RaiseRoom.`
        : `You have been invited to <strong>${esc(org)}</strong> on RaiseRoom.`,
      `<a href="${esc(url)}">Create an account</a> with this address and the invitation is waiting.`,
      'If you were not expecting this, you can ignore it. Nothing is shared with you until you accept.',
    ]),
  };
}

/**
 * The catalogue, by name.
 *
 * Frozen, and checked by `email.test.js` against the builders actually exported,
 * so a message added without being listed here — or listed without existing —
 * fails the suite rather than being discovered when somebody needs it.
 */
export const MESSAGES = Object.freeze({
  'password-reset': passwordReset,
  invite: invitation,
});
