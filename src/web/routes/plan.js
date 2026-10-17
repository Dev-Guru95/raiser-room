/**
 * The plan, the people on it, the workbook credit, who else can see this
 * company, and the audit log.
 *
 * Everything here is reached from Settings, which stays the single page a
 * returning user finds things on. These are separate routes because each one
 * either writes or is long enough to deserve its own page, and because a
 * settings page that tries to be all of them is a settings page nobody reads.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THAT SHAPES THESE PAGES
 *
 * An expired or cancelled account is read-only with a full export, never locked
 * out. So no page here can be written as though losing a plan loses the work. The
 * plan page leads with what is kept, names what stops working, and the export is
 * one click from all of it. A product holding a company's diligence file and
 * using it as leverage would deserve the reputation it would get.
 */

import * as billing from '../../api/billing.js';
import * as onramp from '../../api/onramp.js';
import * as portfolio from '../../api/portfolio.js';
import * as exporter from '../../api/export.js';
import * as usage from '../../api/usage.js';
import * as svc from '../../api/service.js';
import { ROLES } from '../../domain/access.js';
import { providerFor, providerConfigured, NO_PROVIDER } from '../payments.js';
import { shell, attempt, can } from './shell.js';
import {
  page, section, record, table, form, field, select, emptyState, banner, h, action, csrfField, figure, pill, ref,
} from '../html.js';

/** Audit actions, in words. The dotted keys are for machines. */
const actionWords = (key) => String(key)
  .replace(/_/g, ' ')
  .replace('.', ' — ');

export const planRoutes = [
  // ───────────────────────────────────────────────────────────── the plan ──
  {
    path: '/org/:org/plan', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const status = attempt(s, () => billing.status(ctx, s.org.id).body);
      if (!status.ok) return status.response;
      const current = status.value;
      const catalogue = billing.plans(ctx).body;
      const manifest = exporter.exportManifest(ctx, s.org.id).body;

      // Two sources, two different questions, and they are easy to confuse.
      // `billing.status().credit` is the credit itself — what it is worth and
      // whether it has been applied. `onramp.creditStatus().eligible` is whether
      // a workbook could still be redeemed at all. Reading `applied` off the
      // onramp summary, which does not carry it, is a mistake this product has
      // already made once: the "your credit is waiting" banner then shows for
      // ever, including after it has been spent, which is exactly the kind of
      // signal people learn to ignore.
      const credit = current.credit;
      const redeemable = onramp.creditStatus(ctx, s.org.id).body;

      // A trial has taken no money and the demonstration grant is not a
      // subscription, so neither has anything at a provider to manage. Offering
      // a cancel link for either would send somebody to a page about nothing.
      const subscribed = !current.demonstration
        && current.term !== 'TRIAL' && current.term !== 'NONE';

      const planCards = catalogue.plans.map((p) => record({
        title: p.name,
        meta: `${p.seats === null ? 'unlimited seats' : `${p.seats} seats`}`
          + `${p.key === current.plan.key ? ' · your plan' : ''}`,
        state: p.key === current.plan.key ? 'active' : null,
        body: `<p class="note">${h(p.purpose)}</p>`
          + (p.includes.length
            ? `<p>${p.includes.map((i) => pill(i, 'neutral')).join(' ')}</p>`
            : '<p class="note">Everything every plan includes, and nothing more.</p>'),
        actions: p.key === current.plan.key || !p.terms.some((t) => t !== 'NONE')
          ? ''
          : (providerConfigured(req)
            ? p.terms.filter((t) => t !== 'NONE').map((term) =>
              `<form method="post" action="/org/${s.org.id}/plan/checkout" class="inline">
                  ${csrfField(s.csrf)}
                  <input type="hidden" name="plan_key" value="${h(p.key)}">
                  <input type="hidden" name="term" value="${h(term)}">
                  <button class="button button-quiet" type="submit">${h(term.toLowerCase())}</button>
                </form>`).join('')
            : ''),
      })).join('');

      return s.render('Plan', page({
        title: 'Plan',
        lede: current.says,
        actions: action({ href: `/org/${s.org.id}/settings`, label: 'Back to settings', tone: 'quiet' }),
        body: `<div class="row">${figure({
          label: 'Plan',
          value: current.plan.name,
          from: current.demonstration
            ? 'A demonstration grant, not a paying subscription'
            : current.term === 'TRIAL'
              ? `Trial, ${current.trial.days_left} days left`
              : `${String(current.state).toLowerCase()}${current.term === 'NONE' ? '' : `, ${String(current.term).toLowerCase()}`}`,
        })}${figure({
          label: 'Seats used',
          value: `${current.seats.used}${current.seats.limit === null ? '' : ` / ${current.seats.limit}`}`,
          from: current.seats.limit === null ? 'No limit on this plan' : 'Each person is one seat',
        })}${credit ? figure({
          label: credit.label,
          value: credit.amount,
          from: credit.applied
            ? `Applied${credit.applied_at ? ` ${String(credit.applied_at).slice(0, 10)}` : ''}`
            : 'Waiting for an annual subscription',
        }) : ''}</div>`
          + (current.lost.length
            ? banner({
              tone: 'warn',
              says: `${current.lost.length} capabilit${current.lost.length === 1 ? 'y has' : 'ies have'} stopped working.`,
              detail: 'Everything you have recorded is still here, still readable, and still '
                    + 'exportable in full. That does not change with a plan.',
            })
            : '')
          + (providerConfigured(req)
            ? ''
            : banner({ tone: 'info', says: NO_PROVIDER.says, detail: NO_PROVIDER.detail }))
          + (credit && !credit.applied
            ? banner({
              tone: 'good',
              says: `Your ${credit.amount} workbook credit is waiting.`,
              detail: credit.note,
            })
            : '')
          + (redeemable.eligible
            ? banner({
              tone: 'info',
              says: redeemable.note,
              detail: 'Transcribing the sheet carries your scores and figures across as well as '
                    + 'claiming the credit.',
            }) + action({
              href: `/org/${s.org.id}/transfer-sheet`, label: 'Transcribe the workbook', tone: 'quiet',
            })
            : '')
          + section({ title: 'Plans', note: catalogue.note, body: planCards })
          // Placed here, under the plans and above the reassurance, because this
          // is where somebody who came to this page to leave is looking. The
          // sentence beside the link is the same one a customer whose card has
          // failed is shown, and it is here for the same reason: the moment
          // somebody is worried about losing access is the moment to answer it.
          + (subscribed
            ? section({
              title: 'Change or cancel',
              note: 'Your subscription is managed by the payment provider, so the link goes to them.',
              // ───────────────────────────────────────────────────────────
              // THE REASSURANCE GOES ABOVE THE BUTTON, NOT BELOW IT
              //
              // This said the same thing before, in small grey text under the
              // cancel link — which is to say it was read after the decision
              // rather than before it, by somebody who had already braced for
              // bad news.
              //
              // The terms promise that an ended subscription stays readable and
              // exportable, and the software does exactly that. It is the
              // strongest clause in the document, and the one moment it is
              // worth anything to a person is the moment they are wondering
              // whether cancelling costs them their diligence file. So it is
              // stated first, at full weight, in the affirmative.
              body: banner({
                tone: 'good',
                says: 'Cancelling does not delete anything.',
                detail: 'Your organisation becomes read-only. Every figure, document and record '
                      + 'stays exactly where it is, you keep reading all of it, and you keep '
                      + 'exporting all of it in full — on the day a subscription ends and every '
                      + 'day after. We do not hold a company\'s own records to collect a payment.',
              })
                + `<p>${h(current.says)}</p>`
                + (providerConfigured(req)
                  ? action({
                    label: 'Manage or cancel', tone: 'quiet',
                    confirm: `/org/${s.org.id}/plan/portal`, csrf: s.csrf,
                  })
                  : `<p class="note">No payment provider is configured on this deployment, so there `
                    + `is no portal to open. Nothing above changes.</p>`)
                + '<p class="note">Cancelling stops the next renewal, and takes effect at the end '
                + 'of the period you have already paid for.</p>',
            })
            : '')
          + section({
            title: 'What never depends on a plan',
            note: 'The list is deliberately short and deliberately load-bearing.',
            body: `<p>${current.never_gated.map((k) =>
              pill(String(k).replace(/_/g, ' ').toLowerCase(), 'good')).join(' ')}</p>`
              + `<p class="note">${manifest.total_rows} rows across ${manifest.tables.length} tables, `
              + 'exportable now and exportable after a subscription ends.</p>'
              + action({ href: `/org/${s.org.id}/export`, label: 'Export everything', tone: 'quiet' }),
          }),
      }), { wide: true });
    },
  },

  {
    path: '/org/:org/plan/checkout', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;

      const provider = providerFor(req);
      if (!provider) {
        return s.render('Plan', page({
          title: 'Plan',
          body: banner({ tone: 'info', says: NO_PROVIDER.says, detail: NO_PROVIDER.detail })
            + `<p><a href="/org/${s.org.id}/plan">Back</a></p>`,
        }), { status: 503 });
      }

      const r = attempt(s, () => billing.checkout(req.ctx, s.org.id, {
        plan_key: req.body.plan_key, term: req.body.term,
      }, provider));
      if (!r.ok) return r.response;

      // Off to the provider. The price lives there and is deliberately not
      // duplicated in this product — a price stored in two places disagrees
      // eventually, and the wrong copy is always the one the customer sees.
      return { redirect: r.value.body.url };
    },
  },

  {
    path: '/org/:org/plan/portal', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;

      const provider = providerFor(req);
      if (!provider) {
        return s.render('Plan', page({
          title: 'Plan',
          body: banner({ tone: 'info', says: NO_PROVIDER.says, detail: NO_PROVIDER.detail })
            + `<p><a href="/org/${s.org.id}/plan">Back</a></p>`,
        }), { status: 503 });
      }

      const r = attempt(s, () => billing.portal(req.ctx, s.org.id, provider));
      if (!r.ok) return r.response;
      return { redirect: r.value.body.url };
    },
  },

  // ─────────────────────────────────────────────────────────────── people ──
  {
    path: '/org/:org/people', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const roster = attempt(s, () => svc.listMembers(ctx, s.org.id).body);
      if (!roster.ok) return roster.response;
      const { members, pending_invites: invites, my_role: myRole } = roster.value;
      const seats = billing.seatStatus(ctx, s.org.id).body;

      return s.render('People', page({
        title: 'People',
        lede: 'Three levels. A viewer reads everything and changes nothing; an editor records figures, '
            + 'generates documents and issues links; an owner can also change the plan and the people. '
            + 'The last owner cannot be removed or demoted, because an organisation nobody can '
            + 'administer is a support ticket waiting to happen.',
        actions: action({ href: `/org/${s.org.id}/settings`, label: 'Back to settings', tone: 'quiet' }),
        body: `<div class="row">${figure({
          label: 'Seats used',
          value: `${seats.used}${seats.limit === null ? '' : ` / ${seats.limit}`}`,
          from: seats.limit === null ? 'No limit on this plan' : 'Invites count when they are claimed',
        })}</div>`
          + (seats.allowed
            ? ''
            : banner({
              tone: 'warn',
              says: 'Every seat on this plan is taken.',
              detail: 'Remove somebody, or move to a plan with more seats. Nobody is locked out of '
                    + 'anything they have already recorded.',
            }))
          + section({
            title: 'On this organisation',
            // The controls are rendered for everybody and refused by the service
            // layer for anybody who is not an owner. They are shown rather than
            // hidden because a reader who cannot see that roles exist does not
            // know what to ask for.
            body: members.map((m) => record({
              title: m.email ?? m.user_id,
              meta: String(m.role).toLowerCase(),
              body: `<form class="inline" method="post" action="/org/${s.org.id}/people/${h(m.id)}">
                  ${csrfField(s.csrf)}
                  <select name="role" aria-label="Role">
                    ${ROLES.map((role) =>
    `<option value="${role}"${m.role === role ? ' selected' : ''}>${role.toLowerCase()}</option>`).join('')}
                  </select>
                  <button class="button button-quiet" type="submit">Change</button>
                </form>`,
              actions: `<form method="post" action="/org/${s.org.id}/people/${h(m.id)}/remove" class="inline">
                  ${csrfField(s.csrf)}<button class="button button-danger" type="submit">Remove</button></form>`,
            })).join(''),
          })
          + ((invites ?? []).length
            ? section({
              title: 'Invited, not yet joined',
              note: 'An invite takes a seat when it is claimed, not when it is sent.',
              body: invites.map((i) => record({
                title: i.email,
                meta: `${String(i.role).toLowerCase()} · invited ${String(i.created_at).slice(0, 10)}`,
                state: 'attention',
              })).join(''),
            })
            : '')
          + section({
            title: 'Invite somebody',
            note: 'Two people scoring the readiness assessment separately and comparing is the single '
                + 'most useful thing you can do with it, and it needs two accounts. An invite can be '
                + 'a viewer or an editor; ownership is granted afterwards, deliberately.',
            body: form({
              action: `/org/${s.org.id}/people`, csrf: s.csrf, submit: 'Invite',
              body: field({ name: 'email', label: 'Their email', type: 'email', required: true })
                + select({
                  name: 'role', label: 'What they can do',
                  options: [
                    { value: 'VIEWER', label: 'Viewer — reads everything, changes nothing' },
                    { value: 'EDITOR', label: 'Editor — records figures, generates documents, shares' },
                  ],
                }),
            }),
          })
          + `<p class="note">You are ${h(String(myRole).toLowerCase())} here.</p>`,
      }));
    },
  },

  {
    path: '/org/:org/people', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => svc.createInvite(req.ctx, s.org.id, {
        email: req.body.email, role: req.body.role,
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/people` };
    },
  },

  {
    path: '/org/:org/people/:membership', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () =>
        svc.changeMemberRole(req.ctx, s.org.id, req.params.membership, req.body.role));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/people` };
    },
  },

  {
    path: '/org/:org/people/:membership/remove', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => svc.removeMember(req.ctx, s.org.id, req.params.membership));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/people` };
    },
  },

  // ───────────────────────────────────────── letting an investor see progress ──
  {
    path: '/org/:org/visibility', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const scope = req.query.get('scope') === 'PROGRESS' ? 'PROGRESS' : 'SUMMARY';
      const preview = attempt(s, () => portfolio.whatTheyWillSee(ctx, s.org.id, { scope }).body);
      if (!preview.ok) return preview.response;
      const holders = portfolio.whoCanSeeUs(ctx, s.org.id).body;
      const analytics = usage.analyticsSetting(ctx, s.org.id).body;

      return s.render('Who can see this company', page({
        title: 'Who can see this company',
        lede: 'An investor or an adviser can be given a read-only line of sight into how ready you '
            + 'are. The complete list of what they would see is below — not a summary of it, the '
            + 'list.',
        actions: action({ href: `/org/${s.org.id}/settings`, label: 'Back to settings', tone: 'quiet' }),
        body: `<nav class="row">${['SUMMARY', 'PROGRESS'].map((sc) =>
          `<a class="button ${sc === scope ? 'button-solid' : 'button-quiet'}" `
            + `href="/org/${s.org.id}/visibility?scope=${sc}">${sc.toLowerCase()}</a>`).join('')}</nav>`
          + section({
            title: `What they would see — ${scope.toLowerCase()}`,
            note: preview.value.note,
            body: table({
              columns: [
                { key: 'field', label: 'Field', raw: true },
                { key: 'means', label: 'What it is' },
              ],
              rows: preview.value.they_will_see.map((f) => ({
                field: ref(f.field), means: f.means,
              })),
            }),
          })
          + section({
            title: 'What they would never see',
            note: 'Not configurable, not a setting, not something a later plan unlocks.',
            body: preview.value.they_will_never_see.map((line) => record({
              title: line, state: 'done',
            })).join(''),
          })
          + section({
            title: 'Currently sharing with',
            body: holders.holders.length
              ? holders.holders.map((hd) => record({
                title: hd.holder_name ?? hd.holder_org_id,
                meta: `${String(hd.scope).toLowerCase()} since ${String(hd.since).slice(0, 10)}`,
                actions: `<form method="post" action="/org/${s.org.id}/settings/portfolio/${h(hd.id)}/revoke" class="inline">
                    ${csrfField(s.csrf)}<button class="button button-danger" type="submit">Stop sharing</button></form>`,
              })).join('')
              : emptyState({ says: 'Nobody outside this company can see it.' }),
          })
          + section({
            title: 'Invite somebody to watch',
            note: 'Revoking takes effect immediately, and there is no aggregate anywhere that would '
                + 'keep a copy of your figures after you revoke — because no aggregate is ever '
                + 'computed across companies in the first place.',
            body: form({
              action: `/org/${s.org.id}/visibility`, csrf: s.csrf, submit: 'Invite',
              body: field({
                name: 'holder_org_id', label: 'Their organisation id', required: true,
                hint: 'They give you this. A company cannot add itself to your file.',
              })
                + select({
                  name: 'scope', label: 'How much',
                  options: [
                    { value: 'SUMMARY', label: 'Summary — band and room completeness' },
                    { value: 'PROGRESS', label: 'Progress — the same, plus movement over time' },
                  ],
                }),
            }),
          })
          // ── what RaiseRoom itself records ────────────────────────────────
          //
          // On this page rather than buried in a policy, because this is the
          // page somebody opens when the question in their head is "who can see
          // this". The honest answer to that question includes us.
          //
          // The list is generated from the capability catalogue, so it cannot
          // describe something the code does not count, or miss something it
          // does. A hand-written list beside the code is a list that is wrong
          // within two releases, and a privacy disclosure that is wrong is worse
          // than none.
          + section({
            title: 'What we record about how you use RaiseRoom',
            note: analytics.says,
            // The same visual language as "What they would never see" directly
            // above, because it is the same kind of statement. Set as pills it
            // was both inconsistent and too wide — the longest line overflowed a
            // narrow viewport by 36 pixels, which no assertion caught and a
            // screenshot showed immediately.
            body: analytics.never.map((line) => record({ title: line, state: 'done' })).join('')
              + `<p class="note">Kept for ${Math.round(analytics.retention_days / 365)} years, `
              + 'then deleted.</p>'
              + `<details><summary>The complete list — ${analytics.recorded.length} things</summary>`
              + table({
                columns: [
                  { key: 'label', label: 'Counted' },
                  { key: 'why', label: 'What it tells us' },
                ],
                rows: analytics.recorded.map((r) => ({
                  label: r.timed ? `${r.label} (and how long it took)` : r.label,
                  why: r.why,
                })),
              })
              + '</details>'
              + form({
                action: `/org/${s.org.id}/visibility/analytics`, csrf: s.csrf, compact: true,
                submit: analytics.on ? 'Stop counting' : 'Start counting',
                body: `<input type="hidden" name="on" value="${analytics.on ? '0' : '1'}">`,
              }),
          }),
      }), { wide: true });
    },
  },

  // The objection the privacy policy grants, as a switch rather than an email
  // somebody has to action. A right that depends on a person reading a mailbox
  // is a right the product cannot prove it honoured.
  {
    path: '/org/:org/visibility/analytics', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => usage.setAnalytics(req.ctx, s.org.id, req.body.on === '1'));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/visibility` };
    },
  },

  {
    path: '/org/:org/visibility', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => portfolio.inviteHolder(req.ctx, s.org.id, {
        holder_org_id: req.body.holder_org_id, scope: req.body.scope,
      }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/visibility` };
    },
  },

  // ──────────────────────────────────────────────────────── the audit log ──
  {
    path: '/org/:org/audit', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const limit = Math.min(500, Math.max(10, Number(req.query.get('limit')) || 100));
      const log = attempt(s, () => svc.listAudit(ctx, s.org.id, { limit }).body);
      if (!log.ok) return log.response;

      return s.render('What has happened', page({
        title: 'What has happened',
        lede: 'Every act that changed something, who did it and when. This is the record a buyer\'s '
            + 'lawyer asks for, and it exists because the product was used rather than because '
            + 'somebody kept notes.',
        actions: action({ href: `/org/${s.org.id}/settings`, label: 'Back to settings', tone: 'quiet' }),
        body: table({
          columns: [
            { key: 'when', label: 'When' },
            { key: 'what', label: 'What' },
            { key: 'who', label: 'Who' },
            { key: 'target', label: 'On', raw: true },
          ],
          rows: log.value.entries.map((e) => ({
            when: String(e.created_at).replace('T', ' ').slice(0, 16),
            what: actionWords(e.action),
            // `recipient` is the actor id recorded for anything done by somebody
            // holding a share link, who has no account to name.
            who: e.actor_id === 'recipient' ? 'a share recipient' : (e.actor_id ?? 'the system'),
            target: `${h(String(e.target_type).replace(/_/g, ' '))} ${ref(String(e.target_id).slice(0, 8))}`,
          })),
          empty: 'Nothing has happened yet.',
        })
          + `<p class="note">The ${log.value.entries.length} most recent. `
          + `<a href="/org/${s.org.id}/audit?limit=500">Show more</a>, or `
          + `<a href="/org/${s.org.id}/export">export the whole thing</a>.</p>`,
      }), { wide: true });
    },
  },
];
