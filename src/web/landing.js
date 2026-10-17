/**
 * The landing page.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A WHOLE FILE AND NOT A PAGE IN `layout()`
 *
 * Every other page in this product is rendered by `layout()`, which puts an
 * index rail, a sign-out form and a footer around it. The landing page has
 * none of those: it is read by somebody who has no account, is deciding whether
 * to want one, and is reading on a phone from a link somebody sent them.
 *
 * It is also typography that the application's stylesheet does not have — a
 * serif at display size, the source line under every claim set in the same
 * monospace the product uses for provenance. Folding that into `stylesheet()`
 * would mean every signed-in page carries the marketing page's fonts and rules,
 * which is both slower and the kind of coupling that makes a redesign of one
 * break the other.
 *
 * So it is served as what it is: one self-contained document, with its own
 * styles inline and no script at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT LOAD
 *
 * Nothing from anywhere else. It previously pulled four font families from
 * Google; all four are in this repository and served at `/assets/fonts/`, so
 * the links went and nothing else changed. A font CDN on this page would hand a
 * visitor's address to a third party nobody named in the privacy policy — on
 * the first page of a product whose argument is that a company's information
 * stays where they put it.
 *
 * That is also what keeps it servable under the application's own
 * content-security policy, which is `default-src 'self'` with no exceptions
 * worth making for a marketing page.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS READ FROM DISK PER REQUEST
 *
 * Same reason as the legal pages: the alternative is a deployment where
 * somebody fixes a line of copy, sees the old page, and restarts the
 * application to publish a typo fix. One file read on the way to the home page
 * is the cheaper of the two mistakes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Shipped with the application, unlike the legal documents. */
export const LANDING_FILE = join(here, '..', '..', 'docs', 'landing', 'index.html');

export const landingAvailable = () => existsSync(LANDING_FILE);

/**
 * The landing page, or null when the file is not there.
 *
 * Null rather than a throw: a deployment that trimmed `docs/` is not broken,
 * and the caller's answer to a missing landing page is the sign-in page — which
 * is exactly where `/` used to go for everybody.
 */
export function landingPage() {
  if (!landingAvailable()) return null;
  try {
    return readFileSync(LANDING_FILE, 'utf8');
  } catch {
    return null;
  }
}
