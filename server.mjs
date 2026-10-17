/**
 * The production entry point, and the one file a deployment has to edit.
 *
 *   node --experimental-sqlite server.mjs
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS SEPARATELY FROM boot.js
 *
 * `src/web/boot.js` reads configuration, checks it, opens the database and
 * listens. It knows nothing about which model provider, which email provider or
 * which payment provider a deployment uses, and it should not: every one of
 * those is a decision about a vendor, and a vendor name compiled into the
 * application is a vendor nobody can change without a code review.
 *
 * So the three sockets are here, in one file, at the top, each with the contract
 * it has to satisfy written next to it. A deployment fills them in and changes
 * nothing else.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT HAPPENS IF THEY ARE LEFT EMPTY
 *
 * The product runs. The advisor pages say the advisor is not configured, the
 * translation pages say the same, and the plan page says checkout is not
 * available — each in a sentence, on the page, rather than as a broken button.
 * Everything else works: the fact store, the data room, extraction, conflicts,
 * generation, sharing, the cadence, the export.
 *
 * That is deliberate. A product that will not start without three vendor
 * accounts is a product nobody can evaluate.
 */

import { boot } from './src/web/boot.js';

// The adapters. Written against the contracts and tested in
// `test/vendors.test.js` with the HTTP call injected; none has ever spoken to
// a vendor. Each is imported here and nowhere else, which is what keeps every
// vendor name out of the rest of `src/`.
//
// Uncomment an import and its block below once you have the credentials. A
// socket left null is a capability the product says it does not have, on the
// page concerned, in a sentence.
// import { whopProvider } from './src/billing/whop.js';
// import { anthropicAdvisor, anthropicTranslator } from './src/advisor/anthropic.js';

// ───────────────────────────────────────────────────────────── 1 · advisor ──
//
// The contract is `src/advisor/interface.js`. An implementation is an object
// with `answer({ question, passages })` returning `{ text }`.
//
// WHAT THE CALLER GUARANTEES, SO AN IMPLEMENTATION DOES NOT HAVE TO:
//   · The question has already been screened. A question asking for a
//     benchmark, a valuation or an introduction never reaches here.
//   · The passages are the only material it may use. They come from the
//     corpus in `src/knowledge/`, which is in git and versioned.
//   · The answer is validated after it returns, and a claim that is not
//     supported by a passage is rejected and retried once. An implementation
//     cannot talk its way past that by being confident.
//
// WHAT AN IMPLEMENTATION MUST NOT DO:
//   · Receive the organisation's facts, documents or data room. It is sent the
//     question text and the corpus passages, and that is all the privacy policy
//     says it is sent.
//
// To wire one: write the HTTP call to the provider in a file under
// `src/advisor/`, export a factory, import it here, and pass it below.
const advisor = null;
// const advisor = anthropicAdvisor({
//   apiKey: process.env.MODEL_API_KEY,
//   // Pin the model. "Whichever is newest" means an answer that passed the
//   // validator last week can start failing it on a Tuesday for no reason
//   // anybody can see, and every stored answer records which model produced
//   // it so that it stays explicable after the model is replaced.
//   model: 'claude-sonnet-5-5',
// });

// ──────────────────────────────────────────────────────── 2 · translator ──
//
// The contract is `src/translate/interface.js`.
//
// THE RULE THAT MATTERS: every figure is removed from a passage before it is
// sent and put back after it returns. A translation that comes back with a
// number in it is rejected. That is enforced in `src/api/localisation.js`, not
// here, and it is the reason the privacy policy can say a translation provider
// never holds a figure from a customer's accounts.
const translator = null;
// const translator = anthropicTranslator({
//   apiKey: process.env.MODEL_API_KEY,
//   model: 'claude-sonnet-5-5',
// });

// ────────────────────────────────────────────────────────── 3 · payments ──
//
// The contract is `src/billing/interface.js`. Whop is the intended provider.
//
// FOUR THINGS IT HAS TO GET RIGHT:
//   · `checkoutUrl({ planKey, term, orgId })` — where to send somebody.
//   · `portalUrl({ providerRef })` — where somebody manages or cancels. Without
//     it the plan page says cancellation is not available here rather than
//     offering a link to nothing.
//   · `verify({ rawBody, signature, headers })` — the webhook signature, checked
//     before the body is parsed. An unverified webhook is a way for anybody to
//     grant themselves a plan.
//   · The plan ids. The product's plan keys are FREE, RAISEROOM and FIRM; the
//     provider's product ids are its own, and the mapping belongs in the
//     implementation rather than in the domain.
//
// The webhook endpoint already exists and is tested against a fake provider,
// including replay and out-of-order delivery. What is missing is the signature
// check against a real one.
const payments = null;
// const payments = whopProvider({
//   apiKey: process.env.BILLING_API_KEY,
//   webhookSecret: process.env.BILLING_WEBHOOK_SECRET,
//   // The product's plan keys on the left, the provider's product ids on the
//   // right. FREE needs no entry: nobody is sent to a checkout to pay nothing.
//   plans: {
//     RAISEROOM: process.env.BILLING_PLAN_RAISEROOM,
//     FIRM: process.env.BILLING_PLAN_FIRM,
//   },
//   // Which of the two key derivations the provider uses is the one detail
//   // the adapter could not confirm from the documentation. Send one real
//   // webhook from the dashboard; if it is refused, change this to 'standard'.
//   keyFrom: 'literal',
// });
//
// The endpoint to register with the provider is POST /webhooks/billing.

// ────────────────────────────────────────────────────────────── 4 · email ──
//
// The contract is `src/email/interface.js`. An implementation is an object with
// `send({ to, subject, text, html, tag })` returning `{ id }`.
//
// THIS ONE IS DIFFERENT FROM THE OTHER THREE. Leave the advisor out and a
// feature is absent. Leave this out and somebody who forgets their password
// cannot get back into their own account: the reset page says so plainly rather
// than accepting a request it cannot act on, which is the only honest thing it
// can do, but it is still a locked-out customer.
//
// WHAT THE CALLER ALREADY GUARANTEES, SO AN IMPLEMENTATION DOES NOT HAVE TO:
//   · Every message is composed from the catalogue in `src/email/messages.js`,
//     which is in git and tested. A subject line is never written at a call
//     site, so a figure from a customer's accounts cannot reach a provider.
//   · The shape is checked before you are called — one address, a subject, a
//     plain-text body, and no newline in a header.
//   · A failure on the password-reset path is swallowed on purpose. That form
//     must answer identically whether or not the address has an account, and a
//     502 from here would fire only for addresses that do.
//
// WHAT IT MUST NOT DO:
//   · Hold a figure, a fact, a document name or a counterparty's name. The
//     privacy policy names an email provider as a sub-processor and says what
//     it receives; `test/email.test.js` holds the catalogue to it.
//
// Vendor-side, and the reason to start it early: domain verification, SPF,
// DKIM and DMARC records, and sender warm-up. None of it is hard and none of
// it is fast.
//
// To wire one: write the HTTP call to the provider in a file under
// `src/email/`, export a factory, import it here, and pass it below.
const emailer = null;

// ───────────────────────────────────────────────────────────────────────────

boot({ advisor, translator, payments, emailer });
