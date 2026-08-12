/**
 * WF3 - AI Risk Analysis
 * Node: "Parse & Validate"  (Code node, Mode = Run Once for All Items)
 *
 * Repo copy: workflows/code/wf3_parse_validate.js
 * Version 2 - segment resolution is now evidence-based.
 *
 * WHAT CHANGED FROM v1
 * v1 trusted the model's [SEG n] marker to identify the source segment.
 * On the first real run, 2 of 5 clauses cited a seq_no that was not in
 * their own batch, so segment_id and both character offsets came back
 * null. Batching buys speed at the cost of the model having to count
 * markers correctly, and it does not always manage it.
 *
 * v2 searches the batch's segments for the quoted text and uses
 * whichever segment actually contains it. The model's seq_no is only a
 * fallback hint. Traceability no longer depends on the model counting.
 *
 * OUTPUT: one item per clause row, ready for INSERT.
 */

const PROMPT_VERSION = 'v1';   // the PROMPT is unchanged; only this node moved
const MODEL = 'gpt-4o-mini';

const CLAUSE_TYPES = [
  'Governing Law',
  'Termination For Convenience',
  'Cap On Liability',
  'Renewal Term',
  'Anti-Assignment',
];

/** Collapse whitespace so a line-wrap difference is not read as a mismatch. */
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------
// Lookup: segment_id -> text and absolute offset in full_text.
// Built from Fetch Segments, never from anything the model reported.
// ---------------------------------------------------------------
const segmentById = new Map();
for (const row of $('Fetch Segments').all()) {
  const s = row.json;
  if (!s || !s.segment_text) continue;
  segmentById.set(Number(s.segment_id), {
    text: s.segment_text,
    textNorm: norm(s.segment_text),
    char_start: Number(s.char_start),
    seq_no: Number(s.seq_no),
  });
}

const batches = $('Build Batches').all();
const documentId = Number(batches[0].json.document_id);

/**
 * Response shape is output[0].content[0].text.clauses, where .text is an
 * OBJECT because JSON Schema mode already parsed it. The fallbacks cover
 * the other shapes n8n returns under different Simplify settings, so a
 * settings change cannot silently produce zero clauses.
 */
function extractClauses(json) {
  const candidates = [
    json?.output?.[0]?.content?.[0]?.text,
    json?.message?.content,
    json?.content,
    json,
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c?.clauses)) return c.clauses;
    if (typeof c === 'string') {
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed?.clauses)) return parsed.clauses;
      } catch (e) { /* not JSON, try next candidate */ }
    }
  }
  return [];
}

/**
 * Find which segment of this batch actually contains the quoted text.
 *
 * Order matters:
 *   1. Exact substring in the segment the model named. Cheapest, and
 *      correct whenever the model counted right.
 *   2. Exact substring in any other segment of the batch. Catches
 *      mis-attribution while still proving the quote is verbatim.
 *   3. Whitespace-normalised match anywhere in the batch. Proves the
 *      words are right even if line wrapping differs - but offsets
 *      cannot be trusted, so they are left null rather than guessed.
 *
 * Returning offsets we are not sure of would be worse than returning
 * none: Phase 4 error analysis would follow them to the wrong place.
 */
function locate(clauseText, batchSegments, hintedSeqNo) {
  const hinted = batchSegments.find(s => Number(s.seq_no) === Number(hintedSeqNo));
  const ordered = hinted
    ? [hinted, ...batchSegments.filter(s => s !== hinted)]
    : batchSegments;

  // Passes 1 and 2: exact substring.
  for (const s of ordered) {
    const seg = segmentById.get(Number(s.segment_id));
    if (!seg) continue;
    const idx = seg.text.indexOf(clauseText);
    if (idx !== -1) {
      return {
        segment_id: Number(s.segment_id),
        char_start: seg.char_start + idx,
        char_end: seg.char_start + idx + clauseText.length,
        verbatim_ok: true,
        attribution: hinted && Number(s.segment_id) === Number(hinted.segment_id)
          ? 'model'          // model named the right segment
          : 'recovered',     // model was wrong, text search fixed it
      };
    }
  }

  // Pass 3: whitespace-tolerant.
  const needle = norm(clauseText);
  for (const s of ordered) {
    const seg = segmentById.get(Number(s.segment_id));
    if (!seg) continue;
    if (seg.textNorm.includes(needle)) {
      return {
        segment_id: Number(s.segment_id),
        char_start: null,
        char_end: null,
        verbatim_ok: true,
        attribution: 'normalised',
      };
    }
  }

  // Nowhere in the batch: the model paraphrased despite instruction.
  return {
    segment_id: null,
    char_start: null,
    char_end: null,
    verbatim_ok: false,
    attribution: 'not_found',
  };
}

const rows = [];
const seen = new Set();
const foundTypes = new Set();

items.forEach((item, index) => {
  const clauses = extractClauses(item.json);

  // n8n preserves item order, so position links an LLM result back to
  // the batch that produced it. The LLM output carries no batch_no.
  const batch = batches[index]?.json;
  if (!batch) return;

  const batchSegments = batch.segments || [];

  for (const c of clauses) {
    const clauseType = (c.clause_type || '').trim();
    const clauseText = (c.clause_text || '').trim();

    // The JSON Schema enum should make both impossible. Checked anyway:
    // a bad clause_type would fail the DB CHECK and abort the insert.
    if (!CLAUSE_TYPES.includes(clauseType) || !clauseText) continue;

    const key = `${clauseType}::${norm(clauseText)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const found = locate(clauseText, batchSegments, c.seq_no);

    let confidence = Number(c.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.min(1, Math.max(0, confidence));

    foundTypes.add(clauseType);

    rows.push({
      json: {
        document_id: documentId,
        segment_id: found.segment_id,
        clause_type: clauseType,
        clause_text: clauseText,
        char_start: found.char_start,
        char_end: found.char_end,
        confidence: Number(confidence.toFixed(3)),
        is_absent: false,
        reasoning: c.reasoning || null,
        verbatim_ok: found.verbatim_ok,
        attribution: found.attribution,   // model | recovered | normalised | not_found
        model: MODEL,
        prompt_version: PROMPT_VERSION,
        batch_no: Number(batch.batch_no),
      },
    });
  }
});

// ---------------------------------------------------------------
// Absence rows.
//
// Decided here because this node is the first point that has seen
// every batch, so it can tell "not in this batch" from "not in this
// document". Without these rows, "the model said no" and "WF3 crashed
// early" are indistinguishable in the database, which silently
// inflates false negatives in the Phase 4 recall figure.
// ---------------------------------------------------------------
for (const type of CLAUSE_TYPES) {
  if (foundTypes.has(type)) continue;
  rows.push({
    json: {
      document_id: documentId,
      segment_id: null,
      clause_type: type,
      clause_text: null,       // DB CHECK requires NULL when is_absent
      char_start: null,
      char_end: null,
      confidence: null,
      is_absent: true,
      reasoning: 'Not found in any batch of this document.',
      verbatim_ok: true,
      attribution: 'absent',
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      batch_no: null,
    },
  });
}

return rows;
