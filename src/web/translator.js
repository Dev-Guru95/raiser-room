/**
 * Which translator this deployment is wired to, and what the page does without
 * one.
 *
 * Same reasoning as `advisor.js`: a stub left wired in would make a deployment
 * with no translator indistinguishable from a translator that declined, and
 * declining is a legitimate, carefully handled outcome rather than a failure.
 *
 * The difference is what remains possible. Without an advisor there is nothing
 * to ask. Without a translator a person can still write the translation
 * themselves — `writeTranslation` needs no model, checks the references just as
 * strictly, and is approved on arrival because a human wrote it, which was
 * always the bar. So the page without a translator is not a degraded page; it is
 * the same page with one convenience missing, and it says which.
 */

import { fakeTranslator } from '../translate/fake.js';

export const NO_TRANSLATOR = {
  says: 'No machine translator is configured on this deployment.',
  detail: 'You can still write a translation yourself, and that is the only kind a document will '
        + 'render anyway — a machine translation has to be approved by somebody who reads the '
        + 'language before anything uses it. The references in the passage are checked either way.',
};

export function translatorFor(req) {
  return req?.ctx?.translator ?? null;
}

export function translatorConfigured(req) {
  return Boolean(translatorFor(req));
}

export { fakeTranslator };
