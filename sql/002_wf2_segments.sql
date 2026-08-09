-- ===============================================================
-- Assignment 11 - AI Legal Document Review & Compliance Platform
-- Migration 002 - WF2 (OCR & Segmentation) storage
--
-- Save as: <project root>/sql/002_wf2_segments.sql
-- Run in : Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Depends on: 001_schema.sql (the `documents` table must exist)
--
-- SAFE TO RUN TWICE. Every statement uses IF NOT EXISTS, so
-- re-running changes nothing and destroys nothing.
-- ===============================================================


-- ---------------------------------------------------------------
-- 1. documents - extraction results
--
--    full_text is the ONE canonical text for a contract. Every
--    char_start / char_end anywhere in this system is an offset
--    into this exact string. If the text were re-extracted later
--    with different settings, every stored offset would silently
--    become wrong - so WF2 writes it once and WF3 only reads it.
--
--    Why store it at all instead of re-reading the PDF? Because
--    n8n prunes execution history after 7 days (see
--    EXECUTIONS_DATA_MAX_AGE in docker-compose.yml). Text that
--    lives only inside an execution is gone before Phase 4
--    evaluation needs it. ~100 KB per contract, ~3 MB for all 30.
--
--    text_char_count and segment_count are denormalised summaries.
--    They could be derived with LENGTH() and COUNT(), but storing
--    them lets the WF6 dashboard aggregate without scanning the
--    full_text column, which is the largest thing in the database.
-- ---------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS full_text       TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS text_char_count INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS segment_count   INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extracted_at    TIMESTAMPTZ;


-- ---------------------------------------------------------------
-- 2. document_segments
--    One row per chunk of the contract.
--
--    NOT the same thing as `clauses`. A segment is "text region 14
--    of this PDF" - a mechanical split, no interpretation. A clause
--    is "the Governing Law clause the LLM found" - a judgement,
--    with a confidence score. WF3 reads segments and writes clauses.
--
--    Keeping them apart matters for Phase 4: `clauses` is what
--    precision/recall is measured against. If raw segments also
--    lived there, the evaluation query would need a filter to
--    exclude them, and a bug in that filter would corrupt the
--    headline number without any visible error.
--
--    char_start / char_end are offsets into documents.full_text,
--    so a clause found inside a segment can always be located in
--    the original contract and compared against a CUAD gold span.
--
--    UNIQUE (document_id, seq_no) does NOT by itself make WF2
--    re-runnable - a second insert would FAIL, not overwrite.
--    Re-runnability comes from WF2's own sequence:
--        DELETE all segments for this document, then INSERT.
--    The INSERT also carries ON CONFLICT (document_id, seq_no)
--    DO UPDATE as a guard against a duplicate execution landing
--    between the DELETE and the INSERT.
--
--    Delete-then-insert rather than upsert alone because a re-run
--    can produce FEWER segments than before (say 60 instead of 80).
--    Upsert would leave segments 61-80 from the old run behind as
--    stale rows that WF3 would happily analyse.
--
--    No separate CREATE INDEX here: a UNIQUE constraint already
--    builds a B-tree index on (document_id, seq_no), which is
--    exactly the column order WF3 reads in.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_segments (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id  BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq_no       INTEGER     NOT NULL,
    heading      TEXT,
    segment_text TEXT        NOT NULL,
    char_start   INTEGER     NOT NULL,
    char_end     INTEGER     NOT NULL,
    page_no      INTEGER,
    char_count   INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT document_segments_unique UNIQUE (document_id, seq_no),
    CONSTRAINT document_segments_span_valid CHECK (char_end >= char_start)
);


-- ===============================================================
-- Verification - run these SEPARATELY after the migration.
-- The Supabase SQL editor shows only the LAST statement's result,
-- so running both at once hides the first one.
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'documents' ORDER BY ordinal_position;
--   -- expect 12 rows, ending: full_text, text_char_count,
--   --                         segment_count, extracted_at
--
--   SELECT COUNT(*) AS segment_rows FROM document_segments;
--   -- expect 0
-- ===============================================================
