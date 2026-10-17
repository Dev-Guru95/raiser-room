/**
 * The HTTP layer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIN, AND DELIBERATELY SO
 *
 * Every route does the same four things: resolve who is asking, parse what they
 * sent, call one service function, render what came back. There is no business
 * rule in this directory and there must never be one — the entire service layer
 * was built and tested without an HTTP server existing, and the moment a rule
 * lives up here it is a rule no test below can reach.
 *
 * The previous implementation of this product put its authorisation checks in
 * its HTTP handlers. All four of the bugs that started the rewrite were in
 * there, where nothing could test them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REFUSALS ARE THE INTERFACE
 *
 * The service layer's errors were written to be read by a person: they say what
 * happened, why, and what to do about it. This layer maps `err.status` to a
 * response code and shows `err.message` as written. It does not translate them
 * into "Something went wrong", which would throw away the most carefully written
 * text in the product.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../db/sqlite.js';
import { resolveSession } from './auth.js';
import {
  SESSION_COOKIE, readCookie, securityHeaders, csrfValid, originAllowed,
} from './security.js';
import { layout, stylesheet, banner, icon } from './html.js';
import { createThrottle, addressFor } from './throttle.js';
import { uploadScript } from './upload.js';
import { healthReport } from './health.js';
import { ROUTES } from './routes/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(here, '..', '..', 'tools', 'fonts');

/** Bodies are small — a form, not a file. Uploads are presigned straight to storage. */
const MAX_BODY = 512 * 1024;

/**
 * The app.
 *
 * Four of these are external systems, and all four default to null rather than
 * to a stub. A stub that makes a page load is the worst available option in
 * every one of these cases, and each has a file in `src/web/` saying why:
 * `advisor.js`, `translator.js`, `payments.js`, and storage, which is checked at
 * the point of use. A deployment with none of them configured is a complete,
 * honest product with four fewer capabilities, and every page that needs one
 * says so in a sentence.
 */
export function createApp({
  db,
  now = () => new Date().toISOString(),
  secure = true,
  storage = null,
  advisor = null,
  translator = null,
  payments = null,
  emailer = null,
  // The public origin, needed to put an absolute link in an email. A relative
  // link works in a browser and is dead in a mail client.
  baseUrl = '',
  // Where the four legal documents are read from. They are deliberately not in
  // this repository — see src/web/legal.js.
  legalDir = undefined,
  // Only true behind something that terminates TLS and sets X-Forwarded-For.
  // See src/web/throttle.js: trusting that header with no proxy in front lets a
  // caller choose their own rate-limit bucket, which makes the limit decoration.
  trustProxy = false,
  throttle = createThrottle(),
  // Only needed when uploads go to a bucket on another host; see the
  // connect-src note in security.js. Empty for the local driver, which is also
  // what the tests run under, so the policy they assert is the narrow one.
  storageOrigin = null,
} = {}) {
  const routes = ROUTES.map((r) => ({ ...r, pattern: compile(r.path) }));

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const headers = securityHeaders({ secure, storageOrigin });

    try {
      // Before the session, the route table and the database context, because
      // this endpoint has to be able to report that one of those is what is
      // broken. A health check that is itself served through the machinery it is
      // checking answers "healthy" or nothing at all.
      if (url.pathname === '/health') {
        const report = healthReport({ db, storage });
        return send(res, report.status, { ...headers, 'Cache-Control': 'no-store' },
          JSON.stringify(report.body), 'application/json; charset=utf-8');
      }

      if (url.pathname.startsWith('/assets/')) return serveAsset(url.pathname, res, headers);
      if (url.pathname.startsWith('/objects/')) {
        return await serveObject({ req, res, url, headers, storage });
      }

      const ctx = {
        db, now, auth: null, storage, advisor, translator, payments, emailer, baseUrl,
        ...(legalDir === undefined ? {} : { legalDir }),
      };
      const resolved = resolveSession(ctx, readCookie(req.headers.cookie, SESSION_COOKIE));
      const user = resolved?.user ?? null;
      const session = resolved?.session ?? null;
      if (user) ctx.auth = { userId: user.id, email: user.email };

      const match = routes
        .map((r) => ({ route: r, params: r.pattern(url.pathname) }))
        .find((m) => m.params && (m.route.method ?? 'GET') === req.method);

      if (!match) {
        // A path that exists under another method is a 405; anything else is a
        // 404. Saying which is the difference between a broken link and a
        // broken form.
        const otherMethod = routes.some((r) => r.pattern(url.pathname));
        return send(res, otherMethod ? 405 : 404, headers,
          notFoundPage(user, otherMethod));
      }

      const { route, params } = match;

      if (route.auth !== false && !user) {
        // Remember where they were going, so signing in lands them there rather
        // than on a dashboard they then have to navigate away from.
        const next = encodeURIComponent(url.pathname + url.search);
        return redirect(res, `/sign-in?next=${next}`, headers);
      }

      let body = {};
      let rawBody = null;
      if (req.method === 'POST') {
        // ───────────────────────────────────────────────────────────────────
        // A ROUTE THAT NEEDS THE BYTES AS THEY ARRIVED
        //
        // Everything else here is a browser form, so the body is form-parsed
        // and the raw string thrown away. A signed webhook cannot work that
        // way: the signature covers the exact bytes, and re-serialising the
        // body produces a different sequence and a signature that never
        // matches — which is reliably discovered by turning verification off.
        //
        // `raw: true` on a route therefore means two things, and both have to
        // be true together: hand the handler `rawBody`, and do not apply the
        // browser protections that do not fit. The origin check is skipped
        // because the caller is a server with no Origin header, and CSRF is
        // skipped because `auth: false` already skips it below — a webhook is
        // authorised by its signature and by nothing else.
        //
        // This is deliberately not a general escape hatch: the ONLY route
        // carrying this flag is the billing webhook, and `web.test.js` holds
        // it to that.
        if (route.raw) {
          rawBody = await readBody(req);
        } else {
          if (!originAllowed({ origin: req.headers.origin, host: url.host, secure })) {
            return send(res, 403, headers, errorPage(user, 'That form was submitted from somewhere else.'));
          }
          body = parseForm(await readBody(req));
        }
        if (route.auth !== false && !csrfValid(body.csrf, session?.csrf_token)) {
          // Almost always an expired session rather than an attack, and the
          // message says the thing that is actually true and actionable.
          return send(res, 403, headers,
            errorPage(user, 'This form expired. Sign in again and retry — nothing was changed.'));
        }
      }

      // `req` is passed because two routes need something only the request
      // carries: the user agent recorded against a session, and the address a
      // rate limit counts against. It was previously left out, which meant the
      // sign-in route's `req?.headers?.['user-agent']` resolved to undefined on
      // every request and the column it filled was always null — an optional
      // chain quietly standing in for a missing argument.
      const result = await route.handle({
        ctx, user, session, params, query: url.searchParams, body, rawBody, url, secure,
        req, throttle, address: addressFor(req, { trustProxy }),
      });

      if (result?.redirect) return redirect(res, result.redirect, { ...headers, ...result.headers });
      return send(res, result?.status ?? 200, { ...headers, ...result?.headers },
        result?.html ?? '', result?.contentType);
    } catch (err) {
      return send(res, err?.status ?? 500, headers, failurePage(err));
    }
  };
}

// ───────────────────────────────────────────────────────────── plumbing ──

/** `/org/:org/gaps` → a matcher returning `{ org }` or null. */
function compile(path) {
  const names = [];
  const source = path.split('/').map((part) => {
    if (!part.startsWith(':')) return escapeRe(part);
    names.push(part.slice(1));
    return '([^/]+)';
  }).join('/');
  const re = new RegExp(`^${source}/?$`);

  return (pathname) => {
    const m = re.exec(pathname);
    if (!m) return null;
    return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // Refused at the socket rather than after buffering it, so a large body
      // cannot be used to exhaust memory.
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Parse a form body.
 *
 * Repeated fields become arrays, which is how a checkbox list and the assessment
 * form both arrive. Taking only the last value would silently drop answers.
 */
export function parseForm(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(String(text ?? ''))) {
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

function send(res, status, headers, html, contentType = 'text/html; charset=utf-8') {
  res.writeHead(status, { ...headers, 'Content-Type': contentType });
  res.end(html);
}

function redirect(res, location, headers) {
  res.writeHead(303, { ...headers, Location: location });
  res.end();
}

/**
 * Static assets: the stylesheet and the brand faces.
 *
 * Served from the app rather than a CDN. In a product holding somebody's
 * diligence file, a font request to a third party tells that third party who is
 * reading what and when — a privacy property, not a performance one.
 */
function serveAsset(pathname, res, headers) {
  if (pathname === '/assets/app.css') {
    return send(res, 200, { ...headers, 'Cache-Control': 'public, max-age=3600' },
      stylesheet(), 'text/css; charset=utf-8');
  }

  if (pathname === '/assets/upload.js') {
    // A file rather than an inline block, because `script-src 'self'` with no
    // `unsafe-inline` is the policy that makes an injected <script> inert. Going
    // inline for one convenience would remove that for every page.
    return send(res, 200, { ...headers, 'Cache-Control': 'public, max-age=3600' },
      uploadScript(), 'text/javascript; charset=utf-8');
  }

  if (pathname === '/assets/icon.svg') {
    return send(res, 200, { ...headers, 'Cache-Control': 'public, max-age=86400' },
      icon(), 'image/svg+xml');
  }

  if (pathname.startsWith('/assets/fonts/')) {
    const name = pathname.slice('/assets/fonts/'.length);
    // Normalised and checked, so `../../etc/passwd` cannot be requested as a font.
    if (name !== normalize(name) || name.includes('/') || !name.endsWith('.ttf')) {
      return send(res, 404, headers, '');
    }
    const file = join(FONT_DIR, name);
    if (!existsSync(file)) return send(res, 404, headers, '');
    res.writeHead(200, {
      ...headers, 'Content-Type': 'font/ttf', 'Cache-Control': 'public, max-age=604800',
    });
    return res.end(readFileSync(file));
  }

  return send(res, 404, headers, '');
}

// ──────────────────────────────────────────────────────────────── objects ──

/** A document can be large. A form cannot. The two limits are separate on purpose. */
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

/**
 * Signed object access: upload and download of the actual bytes.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS ENDPOINT HAS NO SESSION CHECK
 *
 * It looks wrong, so it is worth being explicit. The signature on the URL *is*
 * the authority here, and it is a narrower authority than a session: it names
 * one key, permits one method, and expires in minutes. The session check happens
 * where the URL is issued — `createDownloadUrl` authorises the caller's
 * membership before it will sign anything — which is the only place that knows
 * whether this person may see this document.
 *
 * That is also what makes the design portable. Against S3 or R2 this endpoint
 * does not exist at all: the signed URL points at the bucket and the bytes never
 * touch this application. A session check here would be a check the hosted
 * drivers cannot perform, which means the security of the product would depend
 * on which driver it was configured with.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY EVERYTHING IS SERVED AS AN ATTACHMENT
 *
 * These are bytes somebody uploaded. Served inline from this origin, an uploaded
 * HTML file or SVG would run script with access to this application's cookies —
 * the whole of a founder's data room, readable by anybody who can persuade them
 * to upload a file. So: `Content-Disposition: attachment` always, `nosniff`
 * always, and a content type that is never taken from the uploader.
 *
 * Generated documents are a separate route (`/org/:org/artifacts/:id/view`),
 * because those this application wrote itself and can render under a policy that
 * lets the page draw and nothing else.
 */
async function serveObject({ req, res, url, headers, storage }) {
  const objectHeaders = {
    ...headers,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  };

  if (!storage?.verify) return send(res, 404, objectHeaders, '');
  if (req.method !== 'GET' && req.method !== 'PUT') return send(res, 405, objectHeaders, '');

  const key = decodeURIComponent(url.pathname.slice('/objects/'.length));
  const check = storage.verify({
    method: req.method,
    key,
    expires: url.searchParams.get('expires'),
    sig: url.searchParams.get('sig'),
  });

  if (!check.ok) {
    // "Expired" is safe to say and useful: somebody followed a link that was
    // valid an hour ago, and the fix is to reload the page it came from. A bad
    // signature says nothing more, because distinguishing "wrong signature" from
    // "no such object" would make this endpoint a way to ask what exists.
    const says = check.why === 'expired'
      ? 'That link has expired. Open the document from inside the app again and it will issue a new one.'
      : 'That link is not valid.';
    return send(res, check.why === 'expired' ? 410 : 403, objectHeaders, says, 'text/plain; charset=utf-8');
  }

  if (req.method === 'PUT') {
    const bytes = await readRawBody(req, MAX_OBJECT_BYTES);
    storage.put(key, bytes);
    res.writeHead(200, objectHeaders);
    return res.end();
  }

  const bytes = storage.get(key);
  if (!bytes) {
    return send(res, 404, objectHeaders,
      'Nothing is stored here. If this is a document you uploaded, the upload did not finish.',
      'text/plain; charset=utf-8');
  }

  // The filename comes from the signed URL, and the signature covers only the
  // key — so it is sanitised rather than trusted. A quote or a newline in here
  // is how a header gets split.
  const asked = url.searchParams.get('name');
  const filename = (asked ? String(asked) : key.split('/').pop())
    .replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'download';

  res.writeHead(200, {
    ...objectHeaders,
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  return res.end(bytes);
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ──────────────────────────────────────────────────────────── error pages ──

const notFoundPage = (user, wrongMethod) => layout({
  title: wrongMethod ? 'Wrong method' : 'Not found',
  user,
  body: banner({
    tone: 'error',
    says: wrongMethod
      ? 'That address exists, but not for this kind of request.'
      : 'There is nothing at that address.',
    detail: 'If you followed a link from inside the app, it is a bug worth reporting.',
  }) + '<p><a href="/">Back to your organisations</a></p>',
});

const errorPage = (user, says) => layout({
  title: 'Refused', user, body: banner({ tone: 'error', says }),
});

/**
 * An unexpected failure.
 *
 * The reference is logged and shown, so a support conversation can start with
 * "reference 4f2a" rather than "it broke". The message itself is not shown: an
 * exception from below could carry a path, a query or a value, and an error page
 * is the wrong place to find out.
 */
function failurePage(err) {
  const reference = randomUUID().slice(0, 8);
  // eslint-disable-next-line no-console
  console.error(`[${reference}]`, err);
  return layout({
    title: 'Something failed',
    body: banner({
      tone: 'error',
      says: 'Something failed on our side, and nothing was changed.',
      detail: `Reference ${reference}. Quote it if you get in touch.`,
    }) + '<p><a href="/">Back to your organisations</a></p>',
  });
}

// ───────────────────────────────────────────────────────────────── start ──

/**
 * Boot the application.
 *
 * Everything configurable is an argument with an environment default, so a test
 * constructs this without touching `process.env` and a deployment configures it
 * without touching the code.
 */
export function startServer({
  port = Number(process.env.PORT ?? 8080),
  host = process.env.HOST ?? '0.0.0.0',
  file = process.env.DATABASE_FILE ?? ':memory:',
  schemaPath,
  secure = process.env.NODE_ENV === 'production',
  storage = null,
  advisor = null,
  translator = null,
  payments = null,
  emailer = null,
  baseUrl = process.env.BASE_URL ?? '',
  legalDir = process.env.LEGAL_DIR,
  trustProxy = process.env.TRUST_PROXY === '1',
  storageOrigin = process.env.STORAGE_ORIGIN ?? null,
  seed = null,
  onListen = null,
} = {}) {
  const db = openDatabase({ file, schemaPath });
  if (seed) seed(db);

  const app = createApp({
    db, secure, storage, advisor, translator, payments, emailer, baseUrl, legalDir,
    trustProxy, storageOrigin,
  });
  const server = createServer((req, res) => { app(req, res); });

  // A request in flight is a request that has already been authorised and may
  // be halfway through a write. Killing the process on the first signal aborts
  // it; closing the server stops new connections and lets the current ones
  // finish, which is the difference between a deploy nobody notices and a
  // handful of half-written rows.
  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`${signal} — no longer accepting connections, finishing what is in flight.`);
    server.close(() => process.exit(0));
    // A client holding a keep-alive connection open would otherwise keep the
    // process alive indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(port, host, () => { if (onListen) onListen({ port, host }); });
  return { server, db, port, host, app };
}
