// ===============================================================
// WF4 - Lawyer Review & Approval
// Node: "Normalise Decision"  (Code -> Run Once for All Items)
//
// Runs immediately after the execution resumes from the review
// form. Three jobs:
//
//   1. Reattach context. The Wait node emits ONLY the submitted
//      form fields - clause_id, review_request_id and the rest are
//      gone from $json, same failure mode as bug #1 with Postgres
//      nodes. We reach back to the nodes that still hold them.
//
//   2. Rename fields. Form labels contain spaces ("Corrected clause
//      text"), which are clumsy in Switch conditions and in SQL
//      parameter arrays. Everything becomes snake_case here, once.
//
//   3. Validate. A 'correct' decision with no replacement text
//      violates a CHECK constraint in migration 004. Catching it
//      here produces a readable error instead of a raw Postgres
//      constraint violation three nodes later.
// ===============================================================

const form = $input.first().json;

// Context carried forward from before the wait. These nodes ran in
// the same execution, so their data survived the pause-and-resume.
const email = $('Build Review Email').first().json;
const clause = $('Fetch Clause').first().json;

// Form labels -> snake_case. Bracket syntax is required because the
// label literally contains spaces.
const decision = (form['Decision'] || '').trim().toLowerCase();
const correctedTextRaw = form['Corrected clause text'] || '';
const reviewerNoteRaw = form['Review note'] || '';

const correctedText = correctedTextRaw.trim();
const reviewerNote = reviewerNoteRaw.trim();

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

// Defence in depth. The dropdown only offers three values, but a
// form POST can be crafted by hand, and a typo in the node config
// would otherwise route silently into the Switch's fallback.
const allowed = ['approve', 'correct', 'reject'];
if (!allowed.includes(decision)) {
  throw new Error(
    'Invalid decision "' + decision + '". Expected one of: ' +
    allowed.join(', ')
  );
}

// Migration 004 enforces this at the database level. Enforcing it
// here too means the reviewer gets a meaningful message rather than
// a constraint violation, and no half-finished update is attempted.
if (decision === 'correct' && correctedText.length === 0) {
  throw new Error(
    'Decision "correct" requires text in the "Corrected clause text" ' +
    'field. Nothing was submitted, so there is no wording to record.'
  );
}

// A correction that matches the original is not a correction. This
// matters beyond tidiness: corrected clauses are appended to
// gold_labels as new evaluation targets, and an identical row would
// quietly duplicate an existing label.
if (
  decision === 'correct' &&
  correctedText === (clause.clause_text || '').trim()
) {
  throw new Error(
    'The corrected text is identical to the original extraction. ' +
    'Use "approve" if the extraction was already correct.'
  );
}

// ---------------------------------------------------------------
// Output
// ---------------------------------------------------------------

return [
  {
    json: {
      // Decision data
      decision: decision,
      corrected_text: correctedText.length > 0 ? correctedText : null,
      reviewer_note: reviewerNote.length > 0 ? reviewerNote : null,
      submitted_at: form.submittedAt || null,

      // Context needed by every downstream branch
      review_request_id: Number(email.review_request_id),
      clause_id: Number(email.clause_id),
      document_id: Number(email.document_id),
      token: email.token,

      // Clause detail needed by the 'correct' branch when it writes
      // a new gold_labels row
      clause_type: clause.clause_type,
      filename: clause.filename,
      original_text: clause.clause_text,
      is_absent: clause.is_absent,
    },
  },
];
