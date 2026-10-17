/**
 * Shared plumbing for every signed-in page.
 *
 * One job: turn a request into `{ org, csrf, render }` or a refusal, so that no
 * route handler repeats the membership lookup — and so that a route cannot
 * accidentally skip it, because the only way to get an organisation is through
 * here.
 */

import { layout, page, refusal, h } from '../html.js';
import * as billing from '../../api/billing.js';
import { isSeeded } from '../../api/seed.js';

/**
 * The organisation a page is about.
 *
 * Membership is checked by the service layer on every call the page then makes;
 * this is the lookup that decides whether to render a page at all. A user with
 * no membership gets the same 404 the service layer would give — never a 403,
 * which would confirm the organisation exists.
 */
export function shell({ ctx, user, session, params, section = null, wide = false }) {
  const org = ctx.db.get('organisation', params.org);
  const membership = org
    ? ctx.db.findOne('membership', { org_id: org.id, user_id: user.id })
    : null;

  if (!org || !membership) {
    return {
      ok: false,
      response: {
        status: 404,
        html: layout({
          title: 'Not found', user: { ...user, csrf: session.csrf_token },
          body: page({
            title: 'Not found',
            lede: 'There is no organisation here that you are a member of.',
            body: '<p><a href="/">Back to your organisations</a></p>',
          }),
        }),
      },
    };
  }

  const csrf = session.csrf_token;
  // Asked once per request and carried into every render, so no page can forget
  // the notice. A seeded organisation holds a marker fact; see api/seed.js.
  const illustrative = isSeeded(ctx, org.id);

  return {
    ok: true,
    org,
    membership,
    csrf,
    /** Render a page inside this organisation's shell. */
    illustrative,
    render: (title, body, { flash = null, status = 200, wide: pageWide = wide, scripts = [] } = {}) => ({
      status,
      html: layout({
        title, body, section, org, flash, illustrative, scripts,
        wide: pageWide,
        user: { ...user, csrf },
      }),
    }),
    /** Render a refusal from the service layer, as the service layer wrote it. */
    refuse: (err, title = 'Refused') => ({
      status: err?.status ?? 400,
      html: layout({
        title, section, org, illustrative, user: { ...user, csrf },
        body: page({ title, body: refusal(err) + backLink(org.id, section) }),
      }),
    }),
  };
}

const backLink = (orgId, section) =>
  `<p><a href="/org/${orgId}${section && section !== 'overview' ? `/${sectionPath(section)}` : ''}">Back</a></p>`;

const sectionPath = (section) => ({
  assessment: 'readiness', gaps: 'gaps', room: 'room', documents: 'documents',
  facts: 'facts', writing: 'writing', artifacts: 'artifacts', cadence: 'cadence',
  sharing: 'sharing', advisor: 'advisor', valuation: 'valuation', settings: 'settings',
}[section] ?? '');

/**
 * Run a service call and render either its result or its refusal.
 *
 * Keeps every handler to one shape and makes it impossible for a route to
 * swallow an error quietly.
 */
export function attempt(s, fn, { title = 'Refused' } = {}) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    // `error` as well as `response`, because a route answering a script needs
    // the refusal itself rather than a rendered page of it. Every caller that
    // only reads `response` is unaffected.
    return { ok: false, response: s.refuse(err, title), error: err };
  }
}

/**
 * Whether this request wants JSON back.
 *
 * Decided by the Accept header, not by a query parameter. A `?json=1` on a URL
 * is a thing somebody can be sent a link to; an Accept header is something the
 * caller sets about itself. For a form POST that is the difference between a
 * page and a payload.
 */
export const wantsJson = (req) =>
  String(req.req?.headers?.accept ?? '').includes('application/json');

export const json = (body, status = 200) => ({
  status,
  html: JSON.stringify(body),
  contentType: 'application/json; charset=utf-8',
});

/**
 * A refusal, as JSON.
 *
 * The message is the service layer's own wording, which was written to be read
 * by a person — so the script can show it directly instead of replacing it with
 * "something went wrong", which is the most carefully written text in the
 * product thrown away.
 */
export const jsonRefusal = (err) => json({
  error: { code: err?.code ?? 'refused', message: err?.message ?? 'That was refused.' },
}, err?.status ?? 400);

/** Whether this organisation can do something, for showing or hiding a control. */
export function can(ctx, orgId, entitlement) {
  try {
    billing.requireEntitlement(ctx, orgId, entitlement);
    return { allowed: true };
  } catch (err) {
    return { allowed: false, says: err.message, available_in: err.available_in ?? null };
  }
}

/** A control that is visible but explains why it is unavailable. */
export function gatedNote(check) {
  if (check.allowed) return '';
  return `<div class="banner banner-warn"><p>${h(check.says)}</p>${
    check.available_in?.length
      ? `<p class="banner-detail">Available in: ${h(check.available_in.join(', '))}.</p>`
      : ''}</div>`;
}
