// ===============================================================
// WF2 - OCR & Segmentation
// Node: "Segment Text"  (Code node, Mode: Run Once for All Items)
//
// Repo copy: <project root>/workflows/code/wf2_segment_text.js
// Paste into: n8n -> WF2 -> Segment Text -> JavaScript field
//             (replace the ENTIRE contents of the field)
//
// Splits full_text into numbered segments at contract section
// headings, e.g. "1.", "1.1", "ARTICLE V", "SECTION 3".
//
// Why heading-based and not fixed-size chunks: WF3 asks an LLM
// "is there a Governing Law clause in this text?". A clause cut in
// half by an arbitrary character boundary gets missed, and a missed
// clause is a recall failure that lands directly in the Phase 4
// number. Contract numbering is the document's own structure -
// splitting on it keeps clauses intact.
//
// char_start / char_end are offsets into full_text, so any clause
// WF3 finds can be located back in the original contract and
// compared against a CUAD gold span.
// ===============================================================

const item = $input.first().json;
const text = item.full_text || '';

// ---------------------------------------------------------------
// Heading pattern
//
// IMPORTANT: headings do NOT sit at line starts here. The upstream
// "Clean Text" node deliberately joins wrapped lines, so by this
// point "2. LICENSED PROGRAMS" sits mid-paragraph. Anchoring with
// a bare ^ therefore matches almost nothing - that bug produced 7
// giant paragraph-fallback segments instead of real sections.
//
// So: match either start-of-text/line OR a position immediately
// after sentence-ending punctuation.
//
// The trailing lookahead is what rejects false positives. A date
// like "as of July 1. The parties agree" has a number and a period,
// but "The" is not a section title. Real contract headings are
// ALL CAPS ("2. LICENSED PROGRAMS"), or introduce a lettered
// sub-clause "(a)", or a further number. Requiring one of those
// three shapes filters prose out.
//
// Flags are `gm`, NOT `gim`. Case-insensitive would let the
// [A-Z]{2} lookahead match ordinary lowercase words and the filter
// would collapse.
// ---------------------------------------------------------------
const HEADING = /(?:^|(?<=[.;:!?]\s))[ \t]*((?:\d+\.)+\d*|(?:ARTICLE|SECTION|EXHIBIT|SCHEDULE|APPENDIX)\s+[IVXLC\d]+)[.:) ]+(?=[A-Z]{2}|\(?[a-z]\)|\d)/gm;

// Collect every heading position first, then slice between them.
const marks = [];
let m;
while ((m = HEADING.exec(text)) !== null) {
  marks.push({ index: m.index, label: m[1].trim() });
}

const MIN_CHARS = 120;    // shorter than this is a stray number, not a section
const MAX_CHARS = 6000;   // guard: an unnumbered contract must not become one giant segment

const segments = [];

if (marks.length === 0) {
  // No numbering found at all. Fall back to paragraph blocks so the
  // document still gets processed instead of silently yielding zero.
  let cursor = 0;
  const paras = text.split(/\n{2,}/);
  for (const p of paras) {
    const start = text.indexOf(p, cursor);
    if (p.trim().length >= MIN_CHARS) {
      segments.push({ heading: null, start, end: start + p.length });
    }
    cursor = start + p.length;
  }
} else {
  // Preamble before the first heading (parties, recitals) matters -
  // Governing Law and Anti-Assignment sometimes live in recitals.
  if (marks[0].index >= MIN_CHARS) {
    segments.push({ heading: null, start: 0, end: marks[0].index });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    if (end - start >= MIN_CHARS) {
      segments.push({ heading: marks[i].label, start, end });
    }
  }
}

// Split any oversized segment on paragraph boundaries, so a single
// unnumbered wall of text does not blow up the WF3 token budget.
const sized = [];
for (const s of segments) {
  if (s.end - s.start <= MAX_CHARS) {
    sized.push(s);
    continue;
  }
  let cur = s.start;
  while (cur < s.end) {
    let cut = Math.min(cur + MAX_CHARS, s.end);
    if (cut < s.end) {
      const brk = text.lastIndexOf('\n\n', cut);
      if (brk > cur + MIN_CHARS) cut = brk;
    }
    sized.push({ heading: s.heading, start: cur, end: cut });
    cur = cut;
  }
}

const out = sized.map((s, i) => ({
  seq_no: i + 1,
  heading: s.heading,
  segment_text: text.slice(s.start, s.end).trim(),
  char_start: s.start,
  char_end: s.end,
  char_count: s.end - s.start,
}));

// Everything stays in ONE item rather than fanning out to many.
// The next node must DELETE this document's old segments before
// inserting, and that delete has to happen exactly once per
// document - not once per segment.
return [{
  json: {
    document_id: item.document_id,
    storage_path: item.storage_path,
    page_count: item.page_count,
    full_text: item.full_text,
    text_char_count: item.text_char_count,
    segment_count: out.length,
    segments: out,
  },
}];
