/**
 * A deterministic translator for tests and local development.
 *
 * Two jobs, as with the fake advisor. The first is a well-formed response so the
 * happy path runs without a model. The second matters more: every way a real
 * translation system mishandles the markers, so each refusal can be proved.
 *
 * None of these are invented. Dropping a bracketed token, merging two of them,
 * "tidying" the digits inside one, and helpfully expanding a placeholder into
 * prose are all things translation systems do, and every one of them produces a
 * document that is fluent, complete-looking and wrong.
 */

/** @param {object} options  behaviour by name; default is a faithful translation */
export function fakeTranslator({ behaviour = 'faithful', id = 'fake-translator', version = 'test-1' } = {}) {
  return {
    id,
    version,
    async translate({ text, to } = {}) {
      const body = String(text ?? '');
      switch (behaviour) {
        case 'faithful':
          // Word order changes, markers survive. What a good translation looks
          // like: the text is different, the markers are not.
          return { text: `[${to}] ${body}` };

        case 'drops_marker':
          return { text: `[${to}] ${body.replace(/⟦\d+⟧/, '')}` };

        case 'duplicates_marker': {
          const first = body.match(/⟦\d+⟧/);
          return { text: first ? `[${to}] ${body} ${first[0]}` : { text: body } };
        }

        case 'alters_marker':
          // The dangerous one: still well-formed, still the right shape, points
          // at a different figure.
          return { text: `[${to}] ${body.replace(/⟦(\d+)⟧/, (_, n) => `⟦${Number(n) + 7}⟧`)}` };

        case 'expands_marker':
          return { text: `[${to}] ${body.replace(/⟦\d+⟧/, 'le chiffre pertinent')}` };

        case 'invents_figure':
          return { text: `[${to}] ${body} Le total atteint 9,9 millions.` };

        case 'empty':
          return { text: '' };

        case 'refuses':
          return { cannot_translate: { why: 'this passage is too ambiguous to translate safely' } };

        case 'malformed':
          return { notes: 'no text field at all' };

        default:
          return { text: body };
      }
    },
  };
}
