/**
 * The demonstration deployment.
 *
 *   DEMO_SEED=1 node --experimental-sqlite src/web/boot.js
 *
 * One account, one organisation, the worked example loaded into it, and the nine
 * generated documents written to storage so they actually open. A reviewer signs
 * in and walks all twelve phases against real content.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THIS SAFE TO DEPLOY, AND WHAT MAKES IT HONEST
 *
 * It refuses to run unless the database is empty. A demonstration seeder that
 * runs against a database with somebody's company in it would put invented
 * figures next to real ones in the same data room, and after that nobody can
 * tell them apart — including the people reading the documents it produces.
 * That is the single worst thing this product could do, so the check is first
 * and it is absolute.
 *
 * Every page of the seeded organisation carries the illustrative notice, on
 * every page rather than on a landing page, because a screenshot taken out of
 * context is exactly how invented figures end up quoted as real ones.
 *
 * The subscription it grants is marked as a demonstration rather than faked as
 * a paying one, so `billing.status` reports `demonstration: true` and no screen
 * can mistake it for a customer.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY STILL MISSING
 *
 * No advisor, no translator and no payment provider, unless the deployment
 * configures them. Each of those is an external system, each has a file in this
 * directory explaining why a stub is worse than nothing, and each page says in
 * a sentence that it is not configured. A demonstration that stubbed them would
 * be showing a reviewer four capabilities that do not exist.
 *
 * The example's source documents are register rows with filenames and page
 * numbers and no bytes behind them. There is no real set of accounts to put
 * there, and inventing one would be a forgery rather than an illustration. The
 * filenames and the page numbers the figures cite are what provenance needs, and
 * those are real. The nine documents the product *generates* are real files.
 */

import * as auth from './auth.js';
import * as svc from '../api/service.js';
import * as seed from '../api/seed.js';
import * as prose from '../api/prose.js';
import * as sharing from '../api/sharing.js';
import * as freshness from '../api/freshness.js';

export const DEMO_EMAIL = 'founder@example.com';

/** Long enough to pass the product's own rule, and printed at boot. */
export const DEMO_PASSWORD = 'illustrative example only';

export class DemoRefused extends Error {
  constructor(message) { super(message); this.code = 'demo_refused'; }
}

/**
 * Seed a demonstration into an empty database.
 *
 * @param {object} options
 * @param {object} options.db       an open database
 * @param {object} options.storage  a storage driver; the documents need somewhere to go
 * @param {() => string} [options.now]
 * @returns a summary worth printing at boot
 */
export function seedDemonstration({ db, storage, now = () => new Date().toISOString() } = {}) {
  if (!storage) {
    throw new DemoRefused(
      'The demonstration needs file storage: the nine documents it generates are real files, and '
      + 'without somewhere to put them a reviewer would find nine rows that will not open. Set '
      + 'STORAGE_DIR.',
    );
  }

  const existing = db.find('organisation', {}).length + db.find('user_account', {}).length;
  if (existing > 0) {
    throw new DemoRefused(
      'This database already has an account or an organisation in it, so the demonstration was not '
      + 'loaded. Invented figures and real ones in the same data room cannot be told apart '
      + 'afterwards. Point DATABASE_FILE at a new file, or load the example from inside the product '
      + 'into an empty organisation.',
    );
  }

  const sys = { db, now, auth: { userId: 'system', email: 'system' }, storage };
  const user = auth.register(sys, {
    email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'A Founder',
  }).body.user;

  const ctx = { db, now, auth: { userId: user.id, email: user.email }, storage };
  const org = svc.createOrganisation(ctx, {
    name: seed.EXAMPLE_COMPANY, path: 'RAISE',
  }).body.organisation;

  const result = seed.seedWorkedExample(ctx, org.id, { entitle: true, generate: true });

  // A link to a document and a link to the room, so the counterparty's own page
  // is reachable without issuing one first. Both named, both withdrawable, and
  // both at a stage that leaves some of the room closed — because a reader
  // seeing every folder at a first meeting is not how this works.
  const artifact = db.find('artifact', { org_id: org.id })
    .find((a) => a.generated_at && !a.superseded_by);

  const links = [];
  links.push({
    for: 'the data room, at qualified stage',
    ...issue(ctx, org.id, {
      recipient_name: 'Vantage Partners', recipient_org: 'Vantage',
      subject_kind: 'ROOM', stage: 'QUALIFIED', share_mode: 'FOLLOW_LATEST',
    }),
  });
  if (artifact) {
    links.push({
      for: `one document — ${artifact.title}`,
      ...issue(ctx, org.id, {
        recipient_name: 'Harbour Capital', recipient_org: 'Harbour',
        subject_kind: 'ARTIFACT', artifact_id: artifact.id,
        stage: 'QUALIFIED', share_mode: 'PINNED',
      }),
    });
  }

  // A question from a counterparty, so the question log and the consistency
  // check have something in them on arrival. One of the two is answered: an
  // empty log and a full one teach different things, and the half-full one
  // teaches the most.
  if (links[0]?.token) {
    sharing.askThroughShare(ctx, links[0].token, {
      question: 'How concentrated is revenue across your largest customers, and which way is it moving?',
    });
    sharing.askThroughShare(ctx, links[0].token, {
      question: 'What happens to the business if the founder is unavailable for three months?',
    });
    const first = db.find('share_question', { org_id: org.id })
      .sort((a, b) => String(a.asked_at).localeCompare(String(b.asked_at)))[0];
    if (first) {
      sharing.answerQuestion(ctx, org.id, first.id, {
        answer: 'Our largest customer is a rising share of revenue and we have disclosed it rather '
              + 'than waiting to be asked. The figure and the comparison two years back are both in '
              + 'the concentration document, each traced to the management accounts.',
      });
    }
  }

  // Documents marked as sent. Without at least one, staleness has nothing to be
  // serious about: the product cannot tell a stale draft nobody has seen from a
  // stale document in an investor's inbox, and distinguishing those two is the
  // whole of phase seven.
  //
  // Issuing an artifact link already records a release — `createShare` calls
  // `markReleased` itself, because a link that has been handed out is a copy
  // that has gone out. So the one above is already marked, and the second is
  // marked by hand, which is the other path and the commoner one: most
  // documents leave a company as an email attachment.
  const alsoSent = db.find('artifact', { org_id: org.id })
    .find((a) => a.generated_at && !a.superseded_by && !a.released_at);
  if (alsoSent) {
    freshness.markReleased(ctx, org.id, alsoSent.id, {
      note: 'Emailed to Vantage Partners ahead of the second meeting.',
    });
  }

  const generated = result.body.produced.filter((p) => !p.blocked);
  const blocked = result.body.produced.filter((p) => p.blocked);

  return {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    organisation: { id: org.id, name: org.name },
    notice: result.body.notice,
    counts: {
      figures: result.body.figures,
      documents: result.body.documents,
      gaps: result.body.gaps,
      passages: result.body.passages,
      generated: generated.length,
      blocked: blocked.length,
      prose: prose.listProse(ctx, org.id).body.total,
    },
    blocked: blocked.map((b) => ({ kind: b.kind, why: b.blockers.join(', ') })),
    skipped: result.body.skipped,
    links,
    // Where to look, in the order that makes the product make sense. A reviewer
    // landing on an overview and clicking around finds the features; walking
    // this finds the argument.
    tour: [
      ['/org/:org/facts', 'Every figure, each with the document and page it was confirmed from.'],
      ['/org/:org/writing', 'A passage where no number is typed — each one is a reference.'],
      ['/org/:org/artifacts', 'Nine generated documents. Open one and read the appendix.'],
      ['/org/:org/artifacts/:artifact/regenerate', 'What would change, before anything changes.'],
      ['/org/:org/gaps', 'The register, in fix order rather than score order.'],
      ['/org/:org/cadence', 'Three closed forecast cycles, two of which missed and say why.'],
      ['/org/:org/questions', 'A counterparty question, checked against what was already said.'],
      ['/org/:org/valuation', 'What a valuer will ask for. No estimate, anywhere.'],
      ['/org/:org/export', 'Everything, in one file, on any plan.'],
    ].map(([path, why]) => [
      path.replace(':org', org.id).replace(':artifact', artifact?.id ?? ''),
      why,
    ]),
  };
}

function issue(ctx, orgId, input) {
  const made = sharing.createShare(ctx, orgId, input).body;
  return { token: made.token, path: `/s/${made.token}`, recipient: made.share.recipient_name };
}

/** What boot prints. Kept here so the banner and the seeding stay in step. */
export function describeDemonstration(summary, { origin = '' } = {}) {
  const lines = [
    '',
    '  ── a demonstration deployment ─────────────────────────────────────────',
    `  ${summary.notice}`,
    '',
    `  Sign in as   ${summary.email}`,
    `  Password     ${summary.password}`,
    '',
    `  ${summary.counts.figures} figures · ${summary.counts.documents} source documents · `
      + `${summary.counts.gaps} open gaps · ${summary.counts.prose} written passages · `
      + `${summary.counts.generated} generated documents`,
  ];

  if (summary.counts.blocked) {
    lines.push('', `  ${summary.counts.blocked} document(s) would not generate, which is the product working:`);
    for (const b of summary.blocked) lines.push(`    ${b.kind} — ${b.why}`);
  }
  if (summary.skipped.length) {
    lines.push('', '  Left out of the example:');
    for (const s of summary.skipped) lines.push(`    ${s.what} — ${s.why}`);
  }

  lines.push('', '  A counterparty\'s view, no account needed:');
  for (const link of summary.links) {
    lines.push(`    ${origin}${link.path}`);
    lines.push(`      ${link.for}, issued to ${link.recipient}`);
  }

  lines.push('', '  Worth seeing, in this order:');
  for (const [path, why] of summary.tour) {
    lines.push(`    ${origin}${path}`);
    lines.push(`      ${why}`);
  }
  lines.push('  ───────────────────────────────────────────────────────────────────────', '');

  return lines.join('\n');
}
