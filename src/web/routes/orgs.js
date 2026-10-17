/**
 * Organisations: the list, creating one, and the overview page.
 *
 * The overview is the page somebody opens on a Monday morning, so it answers the
 * three questions they actually have — where do I stand, what is in the way, and
 * what has moved since I last looked — rather than showing a grid of metrics.
 */

import * as svc from '../../api/service.js';
import * as dataroom from '../../api/dataroom.js';
import * as assessments from '../../api/assessments.js';
import * as billing from '../../api/billing.js';
import * as freshness from '../../api/freshness.js';
import { categoryLabel } from '../../domain/gaps.js';
import { shell, attempt } from './shell.js';
import { landingPage } from '../landing.js';
import {
  layout, page, section, record, form, field, select, figure, emptyState, banner, action, refusal,
} from '../html.js';

export const orgRoutes = [
  {
    // Public, so that `/` can be the landing page for somebody with no account.
    // It was previously a redirect to `/sign-in`, which meant the landing page
    // in `docs/landing/` was unreachable: the one page a visitor arrives on was
    // a form asking them to sign in to a product they had not been told about.
    //
    // Signed in, this is the organisation list exactly as before. The branch is
    // on whether there is a session, which is the same branch `layout()` already
    // makes to decide between "Sign in" and "Sign out" in the header.
    path: '/', method: 'GET', auth: false,
    handle: ({ ctx, user, session, query }) => {
      if (!user) {
        const html = landingPage();
        // No landing page on disk — a deployment that trimmed `docs/`. The
        // sign-in page is where `/` went for everybody until now, so it is the
        // honest fallback rather than a 404 on the home page.
        return html
          ? { html, contentType: 'text/html; charset=utf-8' }
          : { redirect: '/sign-in' };
      }

      const orgs = svc.listOrganisations(ctx).body.organisations ?? [];
      const body = orgs.length
        ? orgs.map((o) => record({
          title: o.name,
          meta: `${o.path === 'SALE' ? 'Preparing to sell' : o.path === 'RAISE' ? 'Preparing to raise' : 'Path not chosen'}, your role is ${String(o.role ?? '').toLowerCase()}`,
          href: `/org/${o.id}`,
          state: 'active',
        })).join('')
        : emptyState({
          says: 'You are not in any organisation yet. Create one and the first thing it will do is '
              + 'tell you, honestly, how ready you are. If you would rather look around first, '
              + 'create one and load the worked example into it.',
        });

      return {
        html: layout({
          title: 'Your organisations',
          user: { ...user, csrf: session.csrf_token },
          flash: query.get('created') ? { tone: 'good', says: 'Organisation created.' } : null,
          body: page({
            title: 'Your organisations',
            body: body + section({
              title: 'Add an organisation',
              body: form({
                action: '/orgs', csrf: session.csrf_token, submit: 'Create',
                body: field({ name: 'name', label: 'Company name', required: true })
                  + select({
                    name: 'path', label: 'What are you preparing for?',
                    hint: 'This decides which documents the data room asks for. You can change it later.',
                    options: [
                      { value: 'RAISE', label: 'Raising money' },
                      { value: 'SALE', label: 'Selling the business' },
                      { value: 'UNDECIDED', label: 'Not decided yet' },
                    ],
                  }),
              }),
            }),
          }),
        }),
      };
    },
  },

  {
    path: '/orgs', method: 'POST',
    handle: ({ ctx, body, user, session }) => {
      try {
        const org = svc.createOrganisation(ctx, { name: body.name, path: body.path }).body.organisation;
        // The room is what the rest of the product hangs off, so it is built now
        // rather than behind a button somebody has to find.
        try { dataroom.buildRoom(ctx, org.id); } catch { /* already built */ }
        return { redirect: `/org/${org.id}?created=1` };
      } catch (err) {
        return {
          status: err.status ?? 400,
          html: layout({
            title: 'Your organisations', user: { ...user, csrf: session.csrf_token },
            body: page({ title: 'Your organisations', body: refusal(err) + '<p><a href="/">Back</a></p>' }),
          }),
        };
      }
    },
  },

  {
    path: '/org/:org', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'overview' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const room = attempt(s, () => dataroom.getRoom(ctx, s.org.id).body);
      if (!room.ok) return room.response;

      const assessed = assessments.listAssessments(ctx, s.org.id).body.assessments ?? [];
      // `listAssessments` returns them oldest first and presents `is_complete`
      // as `complete`. Reading the column name gave undefined, so a company
      // that had been scored was shown as "not assessed" on its own overview.
      const latest = [...assessed].reverse().find((a) => a.complete) ?? null;
      const gaps = assessments.listGaps(ctx, s.org.id).body.gaps ?? [];
      const plan = billing.status(ctx, s.org.id).body;
      // `plan.credit` carries `applied`; the onramp's own credit summary does
      // not, and reading it from there made this banner show for ever — a signal
      // that fires regardless of state is one nobody reads.
      const credit = plan.credit;

      // Nothing generated yet is the normal state of a new organisation, not an
      // error, so a failure here leaves the banner off rather than the page.
      let needingAttention = 0;
      try {
        const health = freshness.artifactHealth(ctx, s.org.id).body;
        needingAttention = (health.artifacts ?? []).filter((a) => a.severity && a.severity !== 'CURRENT').length;
      } catch { needingAttention = 0; }

      const band = latest?.band ?? null;
      const figures = [
        figure({
          label: 'Readiness',
          value: band ? band.replace('_', ' ').toLowerCase() : 'not assessed',
          from: latest ? `Scored ${String(latest.completed_at).slice(0, 10)}` : 'Run the assessment to find out',
        }),
        figure({
          label: 'Required room items filled',
          value: `${room.value.required_satisfied}/${room.value.required_total}`,
          from: 'Counted from the room, not self-reported',
        }),
        figure({
          label: 'Gaps open',
          value: String(gaps.length),
          from: gaps.length ? 'In fix order, not score order' : 'Nothing open',
        }),
      ].join('');

      const next = gaps.slice(0, 3).map((g) => record({
        title: g.description,
        meta: `${categoryLabel(g.category)} · ${g.owner_user_id ? 'owned' : 'no owner yet'}${g.due_date ? ` · due ${g.due_date}` : ''}`,
        state: g.category === 'BLOCKER' ? 'blocked' : 'attention',
        href: `/org/${s.org.id}/gaps`,
      })).join('');

      return s.render('Overview', page({
        title: s.org.name,
        lede: s.org.path === 'SALE'
          ? 'Preparing to sell. Everything here is pointed at what a buyer will ask for.'
          : 'Preparing to raise. Everything here is pointed at what an investor will ask for.',
        body: `<div class="row">${figures}</div>`
          + (plan.term === 'TRIAL'
            ? banner({
              tone: 'info',
              says: `You are on a free trial of ${plan.plan.name}, with ${plan.trial.days_left} days left.`,
              detail: 'Nothing you record is ever locked away from you — including after a trial or a '
                    + 'subscription ends.',
            })
            : '')
          + (credit && !credit.applied
            ? banner({
              tone: 'good',
              says: `Your ${credit.amount} workbook credit is waiting for an annual subscription.`,
              detail: credit.note,
            })
            : '')
          + (needingAttention
            ? banner({
              tone: 'warn',
              says: `${needingAttention} generated document${needingAttention === 1 ? '' : 's'} rest on figures that have changed since.`,
              detail: 'Regenerate before sending anything. Nothing was changed under a reader — the '
                    + 'versions already sent still say what they said.',
            })
            : '')
          + section({
            title: 'What to do next',
            note: gaps.length
              ? 'The register is sorted in fix order — what unblocks the most, soonest — not by score.'
              : null,
            body: next || emptyState({
              says: latest
                ? 'Nothing is open. That is either very good news or a sign the assessment needs redoing.'
                : 'Run the readiness assessment. It takes about twenty minutes and it is the thing '
                  + 'everything else here is built on.',
              action: action({ href: `/org/${s.org.id}/readiness`, label: 'Start the assessment', tone: 'solid' })
                + (latest ? '' : action({
                  href: `/org/${s.org.id}/example`, label: 'Or look at a worked example', tone: 'quiet',
                })),
            }),
          }),
      }));
    },
  },
];
