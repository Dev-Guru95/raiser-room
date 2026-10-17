/**
 * What a refusal says to a person.
 *
 * The service layer throws `AccessError(code, status, { detail })`. The code is
 * for machines — an API client switches on it, a log line groups by it — and
 * where a refusal carries a `detail`, that sentence was written by the person
 * who wrote the rule and is the right thing to show.
 *
 * Plenty of refusals carry no detail, because for an API client the code is
 * enough. Showing `reason_required` on a page is not enough. So every code gets
 * a sentence here, and `test/web.test.js` asserts that the set of codes thrown
 * anywhere in `src/` is exactly the set covered below. A new refusal with no
 * wording fails the suite rather than reaching a page as an identifier.
 *
 * Three rules for the sentences, from the house style:
 *
 *   1. Say what happened, then what to do about it. Never apologise, never be
 *      vague about which thing was wrong.
 *   2. The interface's voice, not a person's. "A reason is needed", not "Sorry,
 *      we need a reason".
 *   3. Never blame the reader for the product's shape. "A figure has to be
 *      recorded before a sentence can cite it" explains the rule; "you forgot
 *      to record the figure" does not.
 */

export const REFUSAL_SENTENCES = {
  // ── access and identity ────────────────────────────────────────────────
  // not_found is deliberately bland. It is what a non-member sees instead of a
  // 403, and a helpful sentence here would confirm the organisation exists.
  not_found: 'That page is not here.',
  forbidden: 'Your role in this organisation does not include that. An owner can change it in Settings.',
  invalid_role: 'That is not one of the roles. Pick viewer, editor or owner.',
  invalid_email: 'That does not look like an email address.',
  invalid_name: 'A name is needed, and it cannot be only spaces.',
  name_required: 'A name is needed.',
  name_too_long: 'That name is too long for the places it has to fit.',
  invalid_path: 'Pick what you are preparing for: raising, selling, or not decided yet.',
  already_a_member: 'That person is already in this organisation.',
  owner_not_a_member: 'An owner has to be someone already in the organisation.',
  unknown_permission: 'That is not a permission this product has.',

  // ── the data room ──────────────────────────────────────────────────────
  already_built: 'This room has already been built. Changing the path updates it rather than rebuilding it.',
  duplicate_folder: 'A folder with that name is already in the room.',
  invalid_category: 'That is not one of the room categories.',
  reason_required: 'Not applicable needs a written reason of at least a few words. Without one it is '
                 + 'missing with better manners, and a counterparty will read it that way.',
  slot_required: 'Choose which room item this document answers.',
  sort_key_required: 'A sort position is needed to place this in the index.',
  filename_required: 'A file name is needed.',
  file_too_large: 'That file is larger than this product accepts. Split it, or upload the signed pages only.',
  invalid_size: 'The file size did not arrive with the upload. Start the upload again.',
  upload_incomplete: 'The upload did not finish, so nothing was filed. Start it again.',
  done_when_required: 'A required item cannot be marked done while nothing is filed against it.',

  // ── the assessment and the gap register ────────────────────────────────
  already_completed: 'This assessment has already been scored. Start a new one to re-answer it.',
  unknown_criterion: 'That is not one of the assessment criteria.',
  gap_closed: 'That gap is already closed. Reopen it if it has come back.',
  note_required: 'A note is needed, so the next person reading this knows what changed.',
  nothing_to_update: 'Nothing in that form changed anything.',

  // ── figures, documents and extraction ──────────────────────────────────
  no_fact: 'No figure is recorded under that key yet. Record it, and this will cite it.',
  nothing_to_repair: 'Every figure this text cites is recorded and current. Nothing needed repairing.',
  already_superseded: 'A newer value has already replaced that one.',
  already_resolved: 'That conflict has already been settled.',
  invalid_worksheet_value: 'That value cannot be read as a number.',
  invalid_target_amount: 'A raise target has to be a positive amount.',

  // ── writing with figures ───────────────────────────────────────────────
  empty_prose: 'There is nothing written yet.',
  invalid_prose_source: 'A block of writing has to say where it is going — which document, which section.',
  numeral_not_in_text: 'That figure is cited but does not appear in the text. Write the number into the '
                     + 'sentence, or drop the citation.',
  prose_rejected: 'A number in this text is not recorded as a figure. Record it first and the sentence '
                + 'will cite it — that is what makes the document traceable.',

  // ── generated documents ────────────────────────────────────────────────
  not_generated: 'That document has not been generated yet, so there is nothing to show.',
  invalid_title: 'A title is needed.',
  invalid_stage: 'That is not one of the stages a document can be at.',
  invalid_scope: 'That is not a scope this document supports.',

  // ── sharing and the portfolio ──────────────────────────────────────────
  thread_closed: 'That thread is closed. Open a new one to carry on.',
  already_revoked: 'That access has already been withdrawn.',
  already_linked: 'That holder is already linked to this organisation.',
  cannot_hold_self: 'An organisation cannot hold itself in a portfolio.',
  holder_required: 'Choose which holder this link is for.',

  // ── the workbook credit ────────────────────────────────────────────────
  receipt_required: 'The receipt reference from the workbook purchase is needed.',
  receipt_already_redeemed: 'That receipt has already been applied to an organisation.',
  organisation_already_redeemed: 'A credit has already been applied to this organisation.',

  // ── translation ────────────────────────────────────────────────────────
  empty_translation: 'The translation came back empty, so nothing was saved.',

  // ── seeding ────────────────────────────────────────────────────────────
  already_seeded: 'The worked example is already in this organisation.',
};

/**
 * The sentence to show for a refusal.
 *
 * In order of preference:
 *
 *   1. A `detail` written at the throw site.
 *   2. The error's own `message`, when it is a sentence rather than a code.
 *   3. The wording above, keyed on the code.
 *   4. The plainest true thing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE MESSAGE BEATS THE TABLE
 *
 * Both are "what the author wrote", so the order between them looked arbitrary
 * and was, originally, the other way round. It is not arbitrary. The table is
 * keyed on a code, and a code is not unique to a rule: `note_required` is
 * thrown by the gap register and by marking a document as sent, and those two
 * rules exist for different reasons and want different sentences. The table
 * entry can only be the generic one, and with the table first the generic one
 * won — so the page said "A note is needed, so the next person reading this
 * knows what changed" where the rule actually wanted "Say who this went to.
 * When a figure in it changes later, the first question is who is holding the
 * old copy, and that is a bad moment to be reconstructing it from memory."
 *
 * The specific sentence is the better one every time it exists, so it goes
 * first and the table becomes what it is useful as: the fallback for the codes
 * thrown with no sentence at all.
 *
 * The guard that makes this safe is the shape of `AccessError`, which does
 * `super(code)` — so its message IS the machine code, with no spaces in it.
 * Requiring whitespace is what keeps `invalid_credentials` off a login form
 * while letting a real sentence through.
 */
export function sentenceFor(err) {
  if (err?.detail) return err.detail;

  const code = err?.code ?? null;
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  if (message && message !== code && /\s/.test(message)) return message;

  if (code && REFUSAL_SENTENCES[code]) return REFUSAL_SENTENCES[code];

  return 'That did not go through, and the reason was not recorded.';
}
