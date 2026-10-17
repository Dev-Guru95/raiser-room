/**
 * The advisor and the translator, against one model provider.
 *
 * Two implementations in one file because they are one vendor account, one API
 * key and one HTTP client. Splitting them would mean configuring the same
 * credential twice in `server.mjs`, which is how two halves of a deployment end
 * up pointing at different models.
 *
 * As with `src/billing/whop.js`, this is the one place a vendor name belongs:
 * it is the adapter, and nothing imports it but `server.mjs`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS NOT RESPONSIBLE FOR
 *
 * Almost all of the rules. Everything below is already enforced by the caller,
 * is already tested, and must not be re-implemented here — a second copy of a
 * rule is a second place for it to be wrong:
 *
 *   · The question has been screened. One asking for a valuation, a benchmark,
 *     a readiness verdict or an introduction never reaches this code.
 *   · The passages are the entire permitted world for the turn.
 *   · The answer is validated after it returns: every claim must cite something
 *     in the context, every citation must resolve, and every numeral must trace
 *     to something cited. An unsupported claim is rejected and retried once.
 *   · For translation: figures are masked out before the text is sent and put
 *     back after it returns, and a translation that comes back containing a
 *     number is rejected outright.
 *
 * So the job here is narrow: take what the caller gives, ask the model for it in
 * a shape the validator can read, and return it. Nothing more.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEVER SENT
 *
 * The organisation's facts, documents or data room. The privacy policy says a
 * model provider receives only the question text and the corpus passages, and
 * that is a published commitment rather than an implementation detail.
 *
 * `buildPrompt` is exported so a test can assert exactly that — see
 * `vendors.test.js`, which checks that an organisation's figures handed to it
 * deliberately do not appear in the bytes that would go over the wire.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ON ASKING FOR JSON
 *
 * The validator needs sections, claims and citations. Asking a model for prose
 * and parsing it back into that shape is guesswork; asking for JSON and
 * refusing anything that is not JSON is not. A response that does not parse is
 * discarded with `cannot_answer`, which is a legitimate and carefully written
 * outcome in this product rather than an error — the caller shows the reader
 * that the question was not answered, which is true.
 */

import { AdvisorProviderError } from './interface.js';
import { TranslatorProviderError } from '../translate/interface.js';

const DEFAULT_API_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MAX_TOKENS = 2048;

/**
 * What the model is told, and the only thing it is given.
 *
 * Exported so a test can read the exact bytes. The citation vocabulary is the
 * one `domain/advisor.js` validates against; a model inventing a fifth kind of
 * citation fails that validator, which is the correct outcome, but telling it
 * the four up front wastes fewer turns.
 */
export function buildPrompt({ question, passages = [] }) {
  const corpus = passages.map((p, i) => {
    const id = p?.id ?? p?.record_id ?? `knowledge:${i}`;
    const body = String(p?.text ?? p?.body ?? '');
    return `[${id}]\n${body}`;
  }).join('\n\n');

  const system = [
    'You answer questions about preparing a company to raise money or to be sold.',
    '',
    'You may use ONLY the numbered passages supplied below. You have no other',
    'source. You do not know anything about the company asking.',
    '',
    'Rules, each of which is checked after you answer:',
    '1. Every claim cites at least one passage. There is no general-knowledge',
    '   exemption and no claim obvious enough to be exempt.',
    '2. Every citation is an id that appears in the passages. An id you did not',
    '   receive is a fabricated citation, which is worse than an uncited claim',
    '   because it looks as though it was checked.',
    '3. Every numeral you write appears in a passage you cite. Not an estimate,',
    '   not a rounded recollection, not an illustrative figure.',
    '4. You never value a company, predict an outcome, issue a readiness',
    '   verdict, give legal, tax or accounting advice, state what investors',
    '   "require", assert a benchmark, or suggest who to approach.',
    '5. If the passages do not contain the answer, say so. That is a complete',
    '   and successful answer. An answer assembled from what you happen to',
    '   remember is the one failure this whole design exists to prevent.',
    '',
    'Reply with JSON only, in this shape:',
    '{"sections":[{"heading":string|null,"claims":[{"text":string,"cites":[string]}]}]}',
    'or, when you cannot answer from the passages:',
    '{"cannot_answer":{"why":string}}',
  ].join('\n');

  const user = `Question:\n${String(question ?? '')}\n\nPassages:\n${corpus}`;

  return { system, user };
}

/** One HTTP client, shared by both implementations. */
function clientFor({ apiKey, apiBase, model, maxTokens, fetchImpl, anthropicVersion }) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));

  return async function ask({ system, user, ErrorClass }) {
    let res;
    try {
      res = await doFetch(`${apiBase}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': anthropicVersion,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
    } catch (err) {
      throw new ErrorClass('provider_unreachable',
        `the model provider could not be reached (${err?.code ?? err?.message ?? 'unknown'})`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ErrorClass('provider_refused',
        `the model provider answered ${res.status}: ${text.slice(0, 300)}`);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ErrorClass('provider_unparseable', 'the model provider answered with something that is not JSON');
    }

    // The content is a list of blocks; the text ones joined are the answer.
    const body = (payload?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!body) throw new ErrorClass('provider_empty', 'the model provider answered with nothing');
    return body;
  };
}

/**
 * Strip a fenced code block, if the model wrapped its JSON in one.
 *
 * Not leniency for its own sake: this is the single commonest way a correct
 * answer arrives in an unusable envelope, and discarding it would mean telling
 * a reader their question could not be answered when it was.
 */
const unfence = (text) => String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

export function anthropicAdvisor({
  apiKey,
  model = DEFAULT_MODEL,
  apiBase = DEFAULT_API_BASE,
  maxTokens = DEFAULT_MAX_TOKENS,
  anthropicVersion = '2023-06-01',
  fetchImpl = undefined,
} = {}) {
  if (!apiKey) {
    throw new AdvisorProviderError('no_api_key',
      'an advisor needs an API key; leave the advisor null in server.mjs rather than configuring '
      + 'half of one — the page then says no advisor is configured, which is true');
  }

  const ask = clientFor({ apiKey, apiBase, model, maxTokens, fetchImpl, anthropicVersion });

  return {
    id: `anthropic-advisor-${model}`,
    version: '2026-10-16',

    async answer({ question, context = null, passages = null } = {}) {
      // The caller names it `context`; the contract's summary says `passages`.
      // Accept either rather than depending on which spelling the call site
      // used, because getting it wrong means sending an empty corpus and
      // producing a confident answer from nothing.
      const material = passages
        ?? context?.knowledge
        ?? context?.passages
        ?? (Array.isArray(context) ? context : []);

      const { system, user } = buildPrompt({ question, passages: material });
      const body = await ask({ system, user, ErrorClass: AdvisorProviderError });

      let parsed;
      try {
        parsed = JSON.parse(unfence(body));
      } catch {
        // Not an exception: an answer nobody can check is withheld, and that is
        // a legitimate outcome rather than a failure.
        return { cannot_answer: { why: 'the model did not answer in a form that could be checked' } };
      }

      if (parsed?.cannot_answer) {
        return { cannot_answer: { why: String(parsed.cannot_answer.why ?? 'the passages do not cover it') } };
      }

      const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
      if (!sections.length) {
        return { cannot_answer: { why: 'the model returned no sections' } };
      }

      // Shaped, not trusted. `domain/advisor.js` validates the content; this
      // only guarantees the shape the validator expects, so that a malformed
      // response fails as a refusal rather than as a crash in the validator.
      return {
        sections: sections.map((s) => ({
          heading: s?.heading != null ? String(s.heading) : null,
          claims: (Array.isArray(s?.claims) ? s.claims : []).map((c) => ({
            text: String(c?.text ?? ''),
            cites: (Array.isArray(c?.cites) ? c.cites : []).map(String),
          })),
        })),
      };
    },
  };
}

/**
 * The translator.
 *
 * The text arrives MASKED: figures are already `⟦0⟧` markers, so this never
 * holds a number out of anybody's accounts. Its one real obligation is to carry
 * every marker through exactly once — and that is checked by
 * `api/localisation.js`, which discards the whole response if a marker is lost.
 * The instruction below exists to waste fewer attempts, not to be relied upon.
 */
export function anthropicTranslator({
  apiKey,
  model = DEFAULT_MODEL,
  apiBase = DEFAULT_API_BASE,
  maxTokens = DEFAULT_MAX_TOKENS,
  anthropicVersion = '2023-06-01',
  fetchImpl = undefined,
} = {}) {
  if (!apiKey) {
    throw new TranslatorProviderError('no_api_key', 'a translator needs an API key');
  }

  const ask = clientFor({ apiKey, apiBase, model, maxTokens, fetchImpl, anthropicVersion });

  return {
    id: `anthropic-translator-${model}`,
    version: '2026-10-16',

    async translate({ text, from, to, kind = null } = {}) {
      const system = [
        'You translate business prose. You return the translation and nothing else:',
        'no preamble, no notes, no explanation, no quotation marks around it.',
        '',
        'The text contains markers that look like ⟦0⟧, ⟦1⟧ and so on. Each one',
        'stands for a figure that will be inserted afterwards.',
        '',
        '· Reproduce every marker exactly, each exactly once.',
        '· You may move a marker within the sentence — word order is the job —',
        '  but never alter, drop, duplicate or invent one.',
        '· Never write a number of your own. A response containing a digit that',
        '  was not a marker is discarded in full.',
        '· Do not improve, shorten, or add to the text. A claim the original did',
        '  not make is a fabrication in a language its author cannot read.',
      ].join('\n');

      const user = [
        `Translate from ${from ?? 'the source language'} to ${to ?? 'the target language'}.`,
        kind ? `This text is a ${kind}.` : null,
        '',
        String(text ?? ''),
      ].filter((line) => line !== null).join('\n');

      const body = await ask({ system, user, ErrorClass: TranslatorProviderError });
      return { text: unfence(body).trim() };
    },
  };
}
