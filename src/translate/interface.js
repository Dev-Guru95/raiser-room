/**
 * The translator contract.
 *
 * The third seam of this kind, after the extractor and the advisor, and written
 * to the same principle: what comes back is checked exhaustively; what the model
 * chooses to do is neither predictable nor claimed to be.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 *
 *   {
 *     id:      'anthropic-translator-v1',
 *     version: '2026-10-01',
 *
 *     async translate({ text, from, to, kind }) -> {
 *       text: string,
 *       notes?: string,
 *       cannot_translate?: { why: string },
 *     }
 *   }
 *
 * `text` ARRIVES MASKED. Fact references have already been replaced with opaque
 * markers, so a translator never holds a fact key and never holds a figure. It
 * sees `⟦0⟧` where the document will later render £4.2m.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A TRANSLATOR MUST DO WITH THE MARKERS
 *
 * Carry them through unchanged, each exactly once. They may move within the
 * sentence — word order is the whole job — but they may not be altered, dropped,
 * duplicated or invented.
 *
 * This is checked, not trusted. A response that loses a marker is discarded in
 * full; there is no partial acceptance, because a sentence with one figure
 * missing is not a worse translation, it is a wrong document.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A TRANSLATOR IS NEVER ASKED TO DO
 *
 * 1. Translate a figure. It is never given one.
 * 2. Translate a disclaimer, a legal notice, or a name. Those never reach it —
 *    see `NEVER_MACHINE_TRANSLATED` in `domain/locale.js`.
 * 3. Improve the text. A translation that adds a claim the original did not make
 *    is a fabrication in another language, and it is harder to spot than one in
 *    English because the person who wrote the original cannot read it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND WHAT HAPPENS AFTERWARDS
 *
 * A machine translation is stored as MACHINE_TRANSLATED and is NOT usable in a
 * generated document until a person approves it — exactly as `USABLE_SOURCES`
 * excludes an unconfirmed extraction. The same shape of answer, for the same
 * reason: a document that goes to an investor should not contain a sentence no
 * human has read.
 */

export const TRANSLATOR_CONTRACT_VERSION = '1';

export class TranslatorProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function assertTranslator(translator) {
  if (!translator || typeof translator !== 'object') {
    throw new TranslatorProviderError('no_translator', 'a translator is required');
  }
  for (const field of ['id', 'version']) {
    if (!translator[field]) {
      throw new TranslatorProviderError('translator_unidentified',
        `a translator must carry ${field} — every stored translation records which model produced it, `
        + 'so a passage translated today is still explicable after the model has been replaced');
    }
  }
  if (typeof translator.translate !== 'function') {
    throw new TranslatorProviderError('translator_incomplete', 'a translator must implement translate()');
  }
  return translator;
}
