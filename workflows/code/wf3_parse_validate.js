/**
 * WF3 - AI Risk Analysis
 * Node: "Parse & Validate"  (Code node, Mode = Run Once for All Items)
 *
 * Repo copy: workflows/code/wf3_parse_validate.js
 * Version 3 - character-tolerant matching with offset recovery.
 *
 * HISTORY
 * v1 trusted the model's [SEG n] marker to identify the source segment.
 *    2 of 5 clauses cited a seq_no not in their own batch, so segment_id
 *    and both offsets came back null.
 * v2 searched the batch's segments for the quoted text instead, using
 *    the marker only as a hint. That fixed attribution, but on 108 real
 *    extractions 20 clauses (18%) still could not be located at all.
 * v3 diagnoses those 20. The v2 whitespace-tolerant pass fired ZERO
 *    times, which proves the mismatches were never whitespace alone.
 *    The surviving cause is character-level: the model reproduces the
 *    typography it read in the PDF (U+2019 apostrophes, U+201C/D
 *    quotes, en-dashes) while WF2's Clean Text already rewrote the
 *    stored copy to ASCII. The two strings are semantically identical
 *    and render identically in any console or CSV, which is why three
 *    rounds of eyeballing the text found nothing.
 *
 *    v3 normalises every class of difference at once and keeps an index
 *    map so true character offsets survive tolerant matching. It also
 *    adds a pass for clauses split across a segment boundary by WF2's
 *    6000-char MAX_CHARS cut - those exist in neither half alone.
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

/** Whitespace only. Used for the dedup key, where offsets do not matter. */
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Aggressive normalisation for MATCHING.
 *
 * Returns { text, idx } where idx[i] is the position in the ORIGINAL
 * string of normalised character i. That map is the whole point: without
 * it, tolerant matching would mean giving up character offsets, and
 * Phase 4 error analysis needs them to jump to the source text.
 */
function canonical(src) {
  const s = src || '';
  let out = '';
  const idx = [];
  let lastWasSpace = false;

  for (let i = 0; i < s.length; i++) {
    let ch = s[i];

    // Typographic -> ASCII. Neither side is wrong; they just disagree.
    if (ch === '\u2018' || ch === '\u2019' || ch === '\u02BC') ch = "'";
    else if (ch === '\u201C' || ch === '\u201D') ch = '"';
    else if (ch === '\u2013' || ch === '\u2014' || ch === '\u2212') ch = '-';
    else if (ch === '\u00A0') ch = ' ';

    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;          // collapse runs of whitespace
      ch = ' ';
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }

    out += ch;
    idx.push(i);
  }

  // Trim, keeping idx aligned. A stray leading space would shift every
  // reported offset by one.
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === ' ') start++;
  while (end > start && out[end - 1] === ' ') end--;

  return { text: out.slice(start, end), idx: idx.slice(start, end) };
}

// ---------------------------------------------------------------
// Lookup: segment_id -> text, canonical form, and absolute offset in
// full_text. Built from Fetch Segments, never from anything the model
// reported. Canonical forms are computed once here rather than per
// clause - otherwise every clause would redo the same work.
// ---------------------------------------------------------------
const segmentById = new Map();
for (const row of $('Fetch Segments').all()) {
  const s = row.json;
  if (!s || !s.segment_text) continue;

  const c = canonical(s.segment_text);
  segmentById.set(Number(s.segment_id), {
    text: s.segment_text,
    canon: c.text,
    canonIdx: c.idx,
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
 * Find which segment actually contains the quoted text.
 *
 * Pass 1 - canonical match inside a single segment. Covers quote, dash
 *          and whitespace differences, and still yields true offsets
 *          through the index map. The segment the model named is tried
 *          first, so a correct marker stays cheap.
 * Pass 2 - canonical match across two ADJACENT segments joined
 *          together. A clause cut in half by MAX_CHARS is invisible to
 *          either half alone; this is the only way to find it. char_end
 *          is left null because a single span across a boundary is not
 *          meaningful.
 *
 * Anything still unfound is a genuine paraphrase, and is reported as
 * such rather than guessed at. Returning offsets we are not sure of
 * would be worse than returning none: Phase 4 error analysis would
 * follow them to the wrong place.
 */
function locate(clauseText, batchSegments, hintedSeqNo) {
  const needle = canonical(clauseText).text;
  if (!needle) {
    return { segment_id: null, char_start: null, char_end: null,
             verbatim_ok: false, attribution: 'not_found' };
  }

  const hinted = batchSegments.find(s => Number(s.seq_no) === Number(hintedSeqNo));
  const ordered = hinted
    ? [hinted, ...batchSegments.filter(s => s !== hinted)]
    : batchSegments.slice();

  // ---- Pass 1: within a single segment ----
  for (const s of ordered) {
    const seg = segmentById.get(Number(s.segment_id));
    if (!seg || !seg.canon) continue;

    const at = seg.canon.indexOf(needle);
    if (at === -1) continue;

    const origStart = seg.canonIdx[at];
    const origEnd = seg.canonIdx[at + needle.length - 1] + 1;

    return {
      segment_id: Number(s.segment_id),
      char_start: seg.char_start + origStart,
      char_end: seg.char_start + origEnd,
      verbatim_ok: true,
      attribution: (hinted && Number(s.segment_id) === Number(hinted.segment_id))
        ? 'model'          // model named the right segment
        : 'recovered',     // model was wrong, text search fixed it
    };
  }

  // ---- Pass 2: spanning a segment boundary ----
  const bySeq = batchSegments
    .slice()
    .sort((a, b) => Number(a.seq_no) - Number(b.seq_no));

  for (let i = 0; i < bySeq.length - 1; i++) {
    const a = segmentById.get(Number(bySeq[i].segment_id));
    const b = segmentById.get(Number(bySeq[i + 1].segment_id));
    if (!a || !b) continue;

    // Joined with one space: the real gap between consecutive segments
    // is whitespace, which canonical() would collapse anyway.
    const joined = canonical(a.text + ' ' + b.text);
    const at = joined.text.indexOf(needle);
    if (at === -1) continue;

    const origStart = joined.idx[at];
    const inFirst = origStart < a.text.length;

    return {
      segment_id: Number(inFirst ? bySeq[i].segment_id : bySeq[i + 1].segment_id),
      char_start: inFirst ? a.char_start + origStart : null,
      char_end: null,
      verbatim_ok: true,
      attribution: 'spanning',
    };
  }

  return { segment_id: null, char_start: null, char_end: null,
           verbatim_ok: false, attribution: 'not_found' };
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
        // model | recovered | spanning | not_found
        attribution: found.attribution,
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
