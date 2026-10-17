/**
 * The advisor, the forecast ledger, valuation readiness, and settings —
 * which carries brand, language, plan, portfolio and the export.
 */

import * as advisorApi from '../../api/advisor.js';
import * as actionsApi from '../../api/actions.js';
import * as cadence from '../../api/cadence.js';
import * as valuation from '../../api/valuation.js';
import * as brandApi from '../../api/brand.js';
import * as localisation from '../../api/localisation.js';
import * as billing from '../../api/billing.js';
import * as portfolio from '../../api/portfolio.js';
import * as exporter from '../../api/export.js';
import * as svc from '../../api/service.js';
import { advisorFor, advisorConfigured, NO_ADVISOR } from '../advisor.js';
import { shell, attempt, can, gatedNote } from './shell.js';
import {
  page, section, record, form, field, select, textarea, figure, emptyState, banner, h, action, csrfField, ref, table,
} from '../html.js';

export const advancedRoutes = [
  // ─────────────────────────────────────────────────────────── advisor ──
  {
    path: '/org/:org/advisor', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'advisor' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const gate = can(ctx, s.org.id, 'ADVISOR');
      const proposals = attempt(s, () => actionsApi.listProposals(ctx, s.org.id, { state: 'PROPOSED' }).body);
      if (!proposals.ok) return proposals.response;
      const catalogue = actionsApi.catalogue(ctx, s.org.id).body;

      return s.render('Advisor', page({
        title: 'Advisor',
        lede: catalogue.rule,
        body: gatedNote(gate)
          + (proposals.value.proposals.length
            ? section({
              title: 'Waiting for you',
              note: 'Nothing has changed. Each of these shows what it would actually change, taken '
                  + 'from the record as it is now — not from what was suggested.',
              body: proposals.value.proposals.map((p) => record({
                title: p.label,
                meta: `${p.action_kind}${p.drift?.length ? ' · what it touches has changed since' : ''}`,
                state: p.drift?.length ? 'attention' : 'active',
                body: `<p class="note">${h(p.rationale)}</p>`
                  + (p.change?.changes?.length
                    ? `<div class="table-scroll"><table class="data"><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${
                      p.change.changes.map((c) => `<tr><td>${h(c.field)}</td><td>${h(c.from ?? '—')}</td><td>${h(c.to ?? '—')}</td></tr>`).join('')
                    }</tbody></table></div>`
                    : '<p class="note">This would change nothing now.</p>'),
                actions: `<form method="post" action="/org/${s.org.id}/advisor/${h(p.id)}/confirm" class="inline">
                    ${csrfField(s.csrf)}<button class="button button-quiet" type="submit">Confirm</button></form>
                  <form method="post" action="/org/${s.org.id}/advisor/${h(p.id)}/reject" class="inline">
                    ${csrfField(s.csrf)}<button class="button button-danger" type="submit">No</button></form>`,
              })).join(''),
            })
            : '')
          + (gate.allowed
            ? (advisorConfigured(req)
              ? section({
                title: 'Ask something',
                note: 'Answers come from a versioned, citable corpus and from your own confirmed '
                    + 'figures. If neither covers it, the answer is that nobody has supplied it.',
                body: form({
                  action: `/org/${s.org.id}/advisor`, csrf: s.csrf, submit: 'Ask',
                  body: textarea({ name: 'question', label: 'Your question', rows: 3 }),
                }),
              })
              // Said rather than hidden. A form that always answers "nothing in
              // the records covers this" is indistinguishable from an advisor
              // with nothing to say, and that is the wrong thing to be
              // indistinguishable from.
              : banner({ tone: 'info', says: NO_ADVISOR.says, detail: NO_ADVISOR.detail }))
            : '')
          + section({
            title: 'What the advisor may do',
            note: `It never touches: ${catalogue.never_touches.join(', ')}.`,
            body: `<div class="table-scroll"><table class="data"><thead><tr><th>Action</th><th>Reversible</th></tr></thead><tbody>${
              catalogue.actions.map((a) => `<tr><td>${h(a.label)}</td><td>${a.reversible ? 'yes' : 'no'}</td></tr>`).join('')
            }</tbody></table></div>`,
          }),
      }));
    },
  },

  {
    path: '/org/:org/advisor', method: 'POST',
    handle: async (req) => {
      const s = shell({ ...req, section: 'advisor' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const advisor = advisorFor(req);
      if (!advisor) {
        return s.render('Advisor', page({
          title: 'Advisor',
          body: banner({ tone: 'info', says: NO_ADVISOR.says, detail: NO_ADVISOR.detail })
            + `<p><a href="/org/${s.org.id}/advisor">Back</a></p>`,
        }), { status: 503 });
      }

      try {
        const thread = advisorApi.createThread(ctx, s.org.id, {
          title: String(req.body.question ?? '').slice(0, 60) || 'Question',
        }).body.thread;
        const res = await advisorApi.ask(ctx, s.org.id, thread.id, req.body.question, advisor);
        const { message } = res.body;

        return s.render('Advisor', page({
          title: 'Advisor',
          body: section({
            title: 'Your question',
            body: `<p>${h(req.body.question)}</p>`,
          }) + section({
            title: message.refused ? 'Not answered' : 'Answer',
            note: message.refused
              ? 'A refusal is a successful turn. An answer assembled from what a model happens to '
                + 'remember is the failure this product exists to prevent.'
              : null,
            // `ask` always writes an answer row, refused or not, and
            // `answer_text` always carries the text. There is no other field to
            // fall back to, and a fallback chain here would render a wrong
            // guess rather than failing where it could be seen.
            body: `<p>${h(message.answer_text)}</p>`
                + (message.citations?.length
                  ? `<p class="note">${message.citations.length} citation${message.citations.length === 1 ? '' : 's'}, listed in the answer above.</p>`
                  : ''),
          }) + `<p><a href="/org/${s.org.id}/advisor">Back</a></p>`,
        }));
      } catch (err) {
        return s.refuse(err, 'Advisor');
      }
    },
  },

  {
    path: '/org/:org/advisor/:proposal/confirm', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'advisor' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => actionsApi.confirm(req.ctx, s.org.id, req.params.proposal));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/advisor` };
    },
  },

  {
    path: '/org/:org/advisor/:proposal/reject', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'advisor' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => actionsApi.reject(req.ctx, s.org.id, req.params.proposal, {}));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/advisor` };
    },
  },

  // ───────────────────────────────────────────────────────── forecasts ──
  {
    path: '/org/:org/cadence', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'cadence' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const gate = can(ctx, s.org.id, 'OPERATING_CADENCE');
      let report = null;
      try { report = cadence.credibilityReport(ctx, s.org.id).body; } catch { report = null; }
      const forecasts = ctx.db.find('forecast', { org_id: s.org.id })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

      return s.render('Forecasts', page({
        title: 'Forecasts',
        lede: 'A forecast is locked when it is made, and never re-baselined. That is deliberate: a '
            + 'forecast you can edit afterwards is not evidence of anything. It is also the one thing '
            + 'nobody can produce retrospectively.',
        body: gatedNote(gate)
          + (report
            ? `<div class="row">${figure({
              label: 'Cycles completed',
              value: `${report.credibility.cycles_complete}/${report.credibility.cycles_needed}`,
              from: report.credibility.meets_criterion
                ? `Criterion ${report.criterion} is satisfied`
                : `Criterion ${report.criterion} is not satisfied yet`,
            })}${figure({
              label: 'Variances explained',
              value: `${report.credibility.variances_explained}/${report.credibility.variances_needing_explanation}`,
              from: report.credibility.unexplained
                ? `${report.credibility.unexplained} still unexplained`
                : 'Every miss has a written reason',
            })}</div>`
              + banner({ tone: report.credibility.meets_criterion ? 'good' : 'info',
                says: report.credibility.statement, detail: report.why_it_matters })
            : '')
          + (forecasts.length
            ? section({
              title: 'Forecasts',
              body: forecasts.map((f) => record({
                title: f.label ?? `Forecast ${String(f.created_at).slice(0, 10)}`,
                meta: `${f.state.toLowerCase()}${f.locked_at ? `, locked ${String(f.locked_at).slice(0, 10)}` : ''}`,
                state: f.state === 'LOCKED' ? 'done' : f.state === 'SUPERSEDED' ? null : 'active',
                actions: f.state === 'DRAFT' && gate.allowed
                  ? `<form method="post" action="/org/${s.org.id}/cadence/${h(f.id)}/lock" class="inline">
                      ${csrfField(s.csrf)}<button class="button button-quiet" type="submit">Lock</button></form>`
                  : '',
              })).join(''),
            })
            : emptyState({
              says: 'No forecasts yet. The first one starts a record nobody can assemble after the '
                  + 'fact — which is the whole argument for doing it now rather than before a raise.',
            }))
          + (gate.allowed
            ? section({
              title: 'Start a forecast',
              body: form({
                action: `/org/${s.org.id}/cadence`, csrf: s.csrf, submit: 'Create draft',
                body: field({ name: 'label', label: 'What is it?', placeholder: 'FY2027 plan', required: true }),
              }),
            })
            : ''),
      }));
    },
  },

  {
    path: '/org/:org/cadence', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'cadence' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => cadence.createForecast(req.ctx, s.org.id, { label: req.body.label }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/cadence` };
    },
  },

  {
    path: '/org/:org/cadence/:forecast/lock', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'cadence' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => cadence.lockForecast(req.ctx, s.org.id, req.params.forecast));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/cadence` };
    },
  },

  // ───────────────────────────────────────────────────────── valuation ──
  {
    path: '/org/:org/valuation', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'valuation' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const pack = attempt(s, () => valuation.readinessPack(ctx, s.org.id).body);
      if (!pack.ok) return pack.response;
      const bases = valuation.assumptionBases(ctx, s.org.id).body.bases ?? [];

      const areas = pack.value.areas.map((a) => record({
        title: a.name,
        meta: a.state === 'EVIDENCED' ? 'Evidenced'
          : a.state === 'PARTIAL' ? 'Partly evidenced' : 'Not started',
        state: a.state === 'EVIDENCED' ? 'done' : a.state === 'PARTIAL' ? 'attention' : null,
        body: `<p class="note">${h(a.demonstrates)}</p>
          <p class="note"><strong>Reproducible when:</strong> ${h(a.reproducible_when)}</p>
          ${a.missing_required.length
    ? `<p class="note">Missing: ${a.missing_required.map((k) => ref(k)).join(' ')}</p>` : ''}
          <p class="note">Usually weakest at: ${h(a.usual_weakness)}</p>`,
      })).join('');

      return s.render('Valuation', page({
        title: 'Valuation readiness',
        lede: pack.value.what_this_is,
        body: banner({ tone: 'info', says: pack.value.no_estimate })
          + section({ title: 'What you will be asked to evidence', body: areas })
          + section({
            title: 'The two kinds of valuation',
            note: pack.value.why_they_differ,
            body: pack.value.kinds.map((k) => record({
              title: k.name,
              meta: k.who,
              body: `<p class="note">${h(k.what)}</p><p class="note">${h(k.what_this_product_does)}</p>`,
            })).join(''),
          })
          + section({
            title: 'Your own assumption',
            note: 'You supply the multiple; this multiplies. It is arithmetic on your assumption, not '
                + 'a valuation — nobody here has assessed whether that multiple fits this business.',
            body: bases.length
              ? form({
                action: `/org/${s.org.id}/valuation`, csrf: s.csrf, submit: 'Calculate',
                body: select({
                  name: 'base_fact_key', label: 'Apply it to',
                  options: bases.map((b) => ({ value: b.fact_key, label: `${b.label} (${b.value_numeric})` })),
                }) + field({ name: 'multiple', label: 'Multiple', type: 'number', step: 'any', placeholder: '4' }),
              })
              : emptyState({ says: 'No confirmed figures to apply a multiple to yet.' }),
          })
          + section({
            title: 'What to do next',
            body: pack.value.next_steps.map((n) => record({
              title: n.step, body: `<p class="note">${h(n.detail)}</p>`,
            })).join(''),
          }),
      }));
    },
  },

  {
    path: '/org/:org/valuation', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'valuation' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => valuation.calculateOnAssumption(req.ctx, s.org.id, {
        base_fact_key: req.body.base_fact_key, multiple: req.body.multiple,
      }));
      if (!r.ok) return r.response;

      return s.render('Valuation', page({
        title: 'Your assumption',
        body: `<div class="row">${figure({
          label: r.value.body.fact.label,
          value: Number(r.value.body.value_numeric).toLocaleString('en-US'),
          source: 'CALCULATED',
          from: r.value.body.formula,
        })}</div>`
          + banner({ tone: 'warn', says: r.value.body.disclosure })
          + `<p><a href="/org/${s.org.id}/valuation">Back</a></p>`,
      }));
    },
  },

  // ───────────────────────────────────────────────────────── settings ──
  {
    path: '/org/:org/settings', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const { ctx } = req;

      const plan = billing.status(ctx, s.org.id).body;
      const plans = billing.plans(ctx).body;
      const brand = brandApi.getBrand(ctx, s.org.id).body;
      const locales = localisation.locales(ctx, s.org.id).body;
      const manifest = exporter.exportManifest(ctx, s.org.id).body;
      const members = svc.listMembers(ctx, s.org.id).body.members ?? [];
      const holders = portfolio.whoCanSeeUs(ctx, s.org.id).body;

      return s.render('Settings', page({
        title: 'Settings',
        lede: 'The things that are set once and then left alone, and the way out of all of it.',
        body: section({
          title: 'Plan',
          note: plan.says,
          body: `<div class="row">${figure({
            label: 'Plan', value: plan.plan.name,
            from: plan.demonstration
              ? 'A demonstration grant, not a paying subscription'
              : plan.term === 'TRIAL'
                ? `Trial, ${plan.trial.days_left} days left`
                : plan.state.toLowerCase(),
          })}${plan.credit ? figure({
            label: plan.credit.label, value: plan.credit.amount,
            from: plan.credit.applied ? 'Applied' : 'Waiting for an annual subscription',
          }) : ''}</div>`
            + `<div class="table-scroll"><table class="data"><thead><tr><th>Capability</th><th>Available</th></tr></thead><tbody>${
              plan.capabilities.map((c) => `<tr><td>${h(c.name)}</td><td>${
                c.allowed ? 'yes' : h(`no — ${(c.available_in ?? []).join(', ') || 'not in any plan'}`)}</td></tr>`).join('')
            }</tbody></table></div>`
            + `<p class="note">${h(plans.note)}</p>`
            + action({ href: `/org/${s.org.id}/plan`, label: 'Change the plan', tone: 'quiet' }),
        })
          + section({
            title: 'Your data',
            note: manifest.note,
            body: `<p>${manifest.total_rows} rows across ${manifest.tables.length} tables.</p>`
              + action({ href: `/org/${s.org.id}/export`, label: 'Export everything', tone: 'quiet' })
              + action({ href: `/org/${s.org.id}/audit`, label: 'What has happened', tone: 'quiet' }),
          })
          + section({
            title: 'Brand',
            note: brand.note ?? 'Your colour is used wherever it is legible, and a darker version '
                + 'where it would not be. Every adjustment is reported.',
            body: form({
              action: `/org/${s.org.id}/settings/brand`, csrf: s.csrf, submit: 'Set brand',
              body: field({
                name: 'accent', label: 'Accent colour', type: 'text',
                value: brand.tokens?.accent ?? '', placeholder: '#7E3FF2',
                hint: 'A hex value. If it is too pale to read on a page, you will be told rather than '
                    + 'shown an unreadable document.',
              }),
            }) + (brand.adjustments?.length
              ? brand.adjustments.map((a) => `<p class="note">${h(a.reason)}</p>`).join('')
              : ''),
          })
          + section({
            title: 'Languages',
            note: locales.note,
            body: `<div class="table-scroll"><table class="data"><thead><tr><th>Language</th><th>Interface wording</th></tr></thead><tbody>${
              locales.locales.map((l) => `<tr><td>${h(l.name)}</td><td>${
                l.strings_complete ? 'complete' : h(`${l.missing_strings} missing`)}</td></tr>`).join('')
            }</tbody></table></div>`
              + action({ href: `/org/${s.org.id}/languages`, label: 'Translate your passages', tone: 'quiet' }),
          })
          + section({
            title: 'People',
            body: members.map((m) => record({
              title: m.email ?? m.user_id,
              meta: String(m.role).toLowerCase(),
            })).join('')
              + `<p class="note">${plan.seats.used} of ${
                plan.seats.limit ?? 'unlimited'} seats used.</p>`
              + action({ href: `/org/${s.org.id}/people`, label: 'Invite and manage people', tone: 'quiet' }),
          })
          + section({
            title: 'Who can see this company',
            note: holders.they_will_never_see.join(' · '),
            body: (holders.holders.length
              ? holders.holders.map((hd) => record({
                title: hd.holder_name ?? hd.holder_org_id,
                meta: `${hd.scope.toLowerCase()} since ${String(hd.since).slice(0, 10)}`,
                actions: `<form method="post" action="/org/${s.org.id}/settings/portfolio/${h(hd.id)}/revoke" class="inline">
                  ${csrfField(s.csrf)}<button class="button button-danger" type="submit">Stop sharing</button></form>`,
              })).join('')
              : emptyState({ says: 'Nobody outside this company can see it.' }))
              + action({ href: `/org/${s.org.id}/visibility`, label: 'See exactly what they would see', tone: 'quiet' }),
          })
          + section({
            title: 'The worked example',
            note: 'A complete company with four years of confirmed figures, loadable into an empty '
                + 'organisation.',
            body: action({ href: `/org/${s.org.id}/example`, label: 'The worked example', tone: 'quiet' }),
          }),
      }));
    },
  },

  {
    path: '/org/:org/settings/brand', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => brandApi.setBrand(req.ctx, s.org.id, { accent: req.body.accent }));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/settings` };
    },
  },

  {
    path: '/org/:org/settings/portfolio/:link/revoke', method: 'POST',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => portfolio.revokeHolder(req.ctx, s.org.id, req.params.link, {}));
      if (!r.ok) return r.response;
      return { redirect: `/org/${s.org.id}/settings` };
    },
  },

  {
    path: '/org/:org/export', method: 'GET',
    handle: (req) => {
      const s = shell({ ...req, section: 'settings' });
      if (!s.ok) return s.response;
      const r = attempt(s, () => exporter.exportEverything(req.ctx, s.org.id));
      if (!r.ok) return r.response;
      return {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Content-Disposition': `attachment; filename="raiseroom-export-${s.org.id}.json"` },
        html: JSON.stringify(r.value.body, null, 2),
      };
    },
  },
];
