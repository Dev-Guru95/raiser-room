/**
 * The illustrative-example notice, and the marker that says an organisation is
 * one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE COPY, AND IT IS THIS ONE
 *
 * The notice is fixed copy. It is not reworded, shortened to fit, split across
 * two lines of different text, or paraphrased in a footer — and the reason is
 * not pedantry. Everything the worked example contains is invented: the company,
 * the revenue, the customer concentration, the forecast misses, the cap table.
 * The product then renders those inventions into documents that look exactly
 * like the real ones, because that is the point of it. A deck of invented
 * figures that a reader cannot tell from a real one is the single most damaging
 * artefact this codebase is capable of producing.
 *
 * So the notice has one home, every surface reads it from here, and
 * `test/seed.test.js` asserts the string.
 *
 * This module sits in `domain/` and imports nothing, so that both the seeding
 * module and the rendering module can use it. They cannot import each other:
 * seeding generates documents, so it already depends on rendering.
 */

export const ILLUSTRATIVE_NOTICE = 'Illustrative example. Not a real company, client, engagement, '
  + 'or performance result. All names, figures, workflows, and outcomes are invented for teaching '
  + 'purposes.';

/**
 * The fact that marks an organisation as the worked example.
 *
 * A fact rather than a column, for two reasons. It travels with the data — it is
 * in the export, in the audit trail, and in any copy of the database — and it
 * cannot be unset by an administrator fixing something else. And it means the
 * check is the same one anything else does: look for a fact.
 */
export const ILLUSTRATIVE_MARKER_KEY = 'example.illustrative';
