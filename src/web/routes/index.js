/**
 * Every route in the app, in one list.
 *
 * Order matters only where two patterns could match the same path. The server
 * picks the first match on method and path, so anything with a literal segment
 * where another route has a parameter goes first.
 */

import { authRoutes } from './auth.js';
import { orgRoutes } from './orgs.js';
import { workRoutes } from './work.js';
import { evidenceRoutes } from './evidence.js';
import { outputRoutes } from './output.js';
import { upkeepRoutes } from './upkeep.js';
import { counterpartyRoutes } from './counterparty.js';
import { languageRoutes } from './language.js';
import { planRoutes } from './plan.js';
import { documentRoutes } from './documents.js';
import { advancedRoutes } from './advanced.js';
import { legalRoutes } from './legal.js';
import { webhookRoutes } from './webhooks.js';

export const ROUTES = [
  ...authRoutes,

  // `/terms`, `/privacy`, `/dpa`, `/subprocessors`. Single literal segments, so
  // they cannot collide with anything below; first because they are the only
  // routes a reader may reach without an account and without a share token, and
  // reading them in that order makes that obvious.
  ...legalRoutes,

  // `/webhooks/billing` — the one route in the product that reads a raw body,
  // and the only caller that is a server rather than a browser.
  ...webhookRoutes,

  ...orgRoutes,
  ...workRoutes,

  // `/org/:org/documents/:document/review` and `/org/:org/transfer-sheet`.
  // Before `documentRoutes`, whose `/org/:org/documents/:document/download`
  // differs in its last segment, so neither can match the other's path.
  ...evidenceRoutes,

  ...outputRoutes,

  // `/org/:org/artifacts/:artifact/regenerate` and `/release`, which must be
  // matched before `documentRoutes` reaches for `/artifacts/:artifact` — a
  // two-segment pattern cannot match a three-segment path, but putting the more
  // specific routes first means that stays true if either list grows.
  ...upkeepRoutes,

  // The counterparty's own routes under `/s/:token`, plus the company's record
  // of what they saw. `/org/:org/sharing/updates` is a four-segment path and
  // `/org/:org/sharing/:share/revoke` in `outputRoutes` is five, so the order
  // of these two lists does not matter — but it is kept deliberate anyway,
  // because the day one of them grows a segment is the day it would.
  ...counterpartyRoutes,

  ...languageRoutes,
  ...planRoutes,

  // `/org/:org/artifacts/:artifact` is a document here and a list in
  // `outputRoutes`; the compiled patterns differ in segment count so neither
  // can match the other's path.
  ...documentRoutes,

  ...advancedRoutes,
];
