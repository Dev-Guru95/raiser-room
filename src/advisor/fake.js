/**
 * A deterministic advisor for tests and local development.
 *
 * Two jobs. The first is to return a well-formed answer so the happy path can
 * be exercised without a model. The second matters more: to return every way a
 * real model misbehaves, so the validator can be proved against each one.
 *
 * The misbehaviours below are not hypothetical. Uncited assertions, confidently
 * fabricated citation ids, and plausible round numbers that came from nowhere
 * are the three characteristic failure modes of a language model asked to give
 * grounded advice, and the third is the dangerous one — a number like "most
 * companies take about 12 weeks" reads as authoritative, is indistinguishable
 * from a real figure, and would be pasted straight into a board pack.
 */

/** @param {object} script  question substring -> draft, plus `default` */
export function fakeAdvisor(script = {}, { id = 'fake-advisor', version = 'test-1' } = {}) {
  return {
    id,
    version,
    async answer({ question } = {}) {
      const q = String(question ?? '').toLowerCase();
      for (const [needle, draft] of Object.entries(script)) {
        if (needle !== 'default' && q.includes(needle.toLowerCase())) {
          return typeof draft === 'function' ? draft({ question }) : draft;
        }
      }
      if (script.default) return script.default;
      return { cannot_answer: { why: 'nothing in the retrieved records covers this' } };
    },
  };
}

/** A well-formed draft, built from whatever is actually in the context. */
export function groundedDraft({ recordId = 'K-2.3-normalisation', criterionRef = '2.3' } = {}) {
  return {
    sections: [
      {
        heading: 'What this is testing',
        claims: [
          {
            text: 'The question behind this criterion is what the business actually earns, as opposed to '
                + 'what the statutory accounts happen to show.',
            cites: [`knowledge:${recordId}`, `criterion:${criterionRef}`],
          },
        ],
      },
      {
        heading: 'What to do',
        claims: [
          {
            text: 'Build the bridge from reported profit to underlying earnings with one adjustment per '
                + 'line, each carrying what it is, what it is worth, and the document that evidences it.',
            cites: [`knowledge:${recordId}`],
          },
          {
            text: 'Do it before anyone asks. An adjustment you identify and evidence is a correction; the '
                + 'same adjustment produced after a query is a negotiation from behind.',
            cites: [`knowledge:${recordId}`],
          },
        ],
      },
    ],
  };
}

/** The ways a model gets this wrong. Each is a test case. */
export const BAD_DRAFTS = Object.freeze({
  /** The most common failure: a true-sounding sentence with nothing behind it. */
  uncited: {
    sections: [{
      heading: 'What to do',
      claims: [
        { text: 'Build a normalisation bridge.', cites: ['knowledge:K-2.3-normalisation'] },
        { text: 'Most buyers will want to see three years of adjustments.', cites: [] },
      ],
    }],
  },

  /** A citation to a record id that looks right and does not exist. */
  fabricatedCitation: {
    sections: [{
      claims: [{
        text: 'Normalisation adjustments need evidence attached.',
        cites: ['knowledge:K-2.3-normalization-guidance'],
      }],
    }],
  },

  /** A plausible round number that came from the model, not from a document. */
  inventedNumber: {
    sections: [{
      claims: [{
        text: 'Companies at this stage typically take about 12 weeks to close this gap.',
        cites: ['knowledge:K-2.3-normalisation'],
      }],
    }],
  },

  /** A figure about the company that is close to a real one, but not it. */
  nearMissNumber: {
    sections: [{
      claims: [{
        text: 'Your ARR of $4.5m is the figure the bridge has to reconcile to.',
        cites: ['knowledge:K-2.3-normalisation'],
      }],
    }],
  },

  /** A valuation, volunteered in answer to a question that did not ask for one. */
  valuation: {
    sections: [{
      claims: [{
        text: 'On these numbers your business is worth somewhere around $18m.',
        cites: ['knowledge:K-2.3-normalisation'],
      }],
    }],
  },

  /** A readiness verdict. */
  readinessVerdict: {
    sections: [{
      claims: [{
        text: 'With the bridge finished you are investor-ready.',
        cites: ['knowledge:K-2.3-normalisation'],
      }],
    }],
  },

  /** Speaking for counterparties the product has never met. */
  speaksForInvestors: {
    sections: [{
      claims: [{
        text: 'Investors require a normalisation bridge covering at least three years.',
        cites: ['knowledge:K-2.3-normalisation'],
      }],
    }],
  },

  /** A benchmark, which nothing here measures. */
  benchmark: {
    sections: [{
      claims: [{
        text: 'Most companies at your stage score higher on this domain.',
        cites: ['knowledge:K-2.3-normalisation'],
      }],
    }],
  },

  /** Several problems at once — a retry should learn about all of them. */
  multipleProblems: {
    sections: [{
      claims: [
        { text: 'A bridge needs evidence.', cites: [] },
        { text: 'Expect roughly 40% of adjustments to be queried.', cites: ['knowledge:K-2.3-normalisation'] },
        { text: 'This makes you investor-ready.', cites: ['knowledge:K-no-such-record'] },
      ],
    }],
  },

  empty: { sections: [] },
});
