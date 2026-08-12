/**
 * WF3 - AI Risk Analysis
 * Node: "Build Batches"  (Code node, Mode = Run Once for All Items)
 *
 * Repo copy: workflows/code/wf3_build_batches.js
 *
 * PURPOSE
 * Groups a document's segments into batches of roughly CHAR_BUDGET
 * characters and pre-renders the exact text the LLM will read, with
 * [SEG n] markers so the model can say which segment a clause came from.
 *
 * WHY BATCH AT ALL
 *   - One call per segment  = full coverage, but ~700 calls per run.
 *   - One call per document = 2 minutes, but long-context extraction
 *                             reliably misses clauses in the middle.
 *   - Batching              = full coverage, ~140 calls, markers keep
 *                             per-segment traceability.
 * Batching also repairs segmentation seams: a clause cut in half by the
 * 6000-char MAX_CHARS limit is invisible to either half alone, but
 * visible when both halves sit in the same batch.
 *
 * INPUT  (from "Fetch Segments"): one item per segment.
 * OUTPUT: one item per batch.
 */

// ---------------------------------------------------------------
// Config. Kept at the top, never buried in the logic below.
// CHAR_BUDGET is characters, not tokens. Roughly 4 chars per token,
// so 10000 chars is about 2500 tokens of contract per call - small
// enough that the model attends to all of it.
// ---------------------------------------------------------------
const CHAR_BUDGET = 10000;

const rows = items.map(i => i.json);

// ---------------------------------------------------------------
// Guard: "Always Output Data" is ON upstream, so a document with no
// segments arrives here as a single empty item rather than nothing.
// Detect it by absence of segment_text and return an explicit empty
// batch list instead of building a nonsense batch.
// ---------------------------------------------------------------
const realRows = rows.filter(r => r && r.segment_text);

if (realRows.length === 0) {
  return [{
    json: {
      document_id: $('When Executed by Another Workflow').first().json.document_id,
      filename: null,
      batch_no: 0,
      batch_count: 0,
      segment_count: 0,
      batch_chars: 0,
      segments: [],
      batch_text: '',
      is_empty: true,
    },
  }];
}

// document_id is not in the SELECT - the query filters on it rather
// than returning it - so read it back from the trigger.
const documentId = Number(
  $('When Executed by Another Workflow').first().json.document_id
);
const filename = realRows[0].filename || null;

// ---------------------------------------------------------------
// Group segments until adding the next one would exceed the budget.
//
// The `current.length > 0` guard matters: a single segment larger
// than CHAR_BUDGET must still go out, alone, in its own batch.
// Without that check it would be skipped forever and the clauses
// inside it would silently never be extracted - a missing-data bug
// that looks exactly like poor model recall.
// ---------------------------------------------------------------
const batches = [];
let current = [];
let currentChars = 0;

for (const row of realRows) {
  const len = (row.segment_text || '').length;

  if (current.length > 0 && currentChars + len > CHAR_BUDGET) {
    batches.push(current);
    current = [];
    currentChars = 0;
  }

  current.push(row);
  currentChars += len;
}

if (current.length > 0) {
  batches.push(current);
}

// ---------------------------------------------------------------
// Render each batch.
//
// The marker uses seq_no (1, 2, 3...) rather than the database
// segment_id (large numbers). Short integers are far less likely to
// be mis-transcribed by the model. The segments[] array carries the
// seq_no -> segment_id mapping so a later node can resolve the real
// foreign key without trusting the model with it.
// ---------------------------------------------------------------
return batches.map((batch, index) => {
  const parts = batch.map(row => {
    const heading = row.heading ? ` ${row.heading}` : '';
    return `[SEG ${row.seq_no}]${heading}\n${row.segment_text}`;
  });

  const segments = batch.map(row => ({
    seq_no: Number(row.seq_no),
    segment_id: Number(row.segment_id),   // BIGINT arrives as a string
    char_start: Number(row.char_start),
    char_end: Number(row.char_end),
  }));

  return {
    json: {
      document_id: documentId,
      filename,
      batch_no: index + 1,
      batch_count: batches.length,
      segment_count: batch.length,
      batch_chars: parts.join('\n\n').length,
      segments,
      batch_text: parts.join('\n\n'),
      is_empty: false,
    },
  };
});
