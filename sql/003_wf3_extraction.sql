-- ===============================================================
-- Assignment 11 - AI Legal Document Review & Compliance Platform
-- Migration 003: WF3 (AI Risk Analysis) schema
--
-- Save as: <project root>/sql/003_wf3_extraction.sql
-- Run in : Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- SAFE TO RUN TWICE. Every ADD COLUMN uses IF NOT EXISTS, and
-- every constraint is dropped before being re-added, so a second
-- run is a no-op instead of an error.
--
-- Depends on: 001_schema.sql, 002_wf2_segments.sql
-- ===============================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. segment_id  ->  traceability
--
--    WF3 sends ONE segment to the LLM at a time. Recording which
--    segment produced a clause is what makes Phase 4 error
--    analysis possible: when a clause is missed, you can open the
--    exact segment and see whether the segmenter cut it in half
--    or the prompt failed to recognise it.
--
--    ON DELETE SET NULL, not CASCADE: re-running WF2 deletes and
--    reinserts segments. If this cascaded, re-segmenting a
--    document would silently wipe its extracted clauses.
-- ---------------------------------------------------------------
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS segment_id BIGINT;

ALTER TABLE clauses DROP CONSTRAINT IF EXISTS clauses_segment_fk;
ALTER TABLE clauses ADD CONSTRAINT clauses_segment_fk
    FOREIGN KEY (segment_id) REFERENCES document_segments(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------
-- 2. is_absent  ->  "the model looked and found nothing"
--
--    gold_labels already has this column. The clauses table needs
--    the mirror image of it.
--
--    Without it, "we predicted absent" is indistinguishable from
--    "WF3 crashed before reaching this clause type" - both look
--    like a missing row. That difference silently inflates false
--    negatives and makes the headline recall number wrong in a
--    way nothing would flag.
-- ---------------------------------------------------------------
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS is_absent BOOLEAN NOT NULL DEFAULT FALSE;


-- ---------------------------------------------------------------
-- 3. risk_score / risk_level  ->  the judgment layer (Phase 2)
--
--    Kept as real columns rather than keys inside extracted_fields
--    because WF5 and WF6 aggregate on them ("show all high-risk
--    clauses this week"). Aggregating over JSONB works but is
--    slower and cannot be constrained.
--
--    NUMERIC(4,3), same as confidence: exact values 0.000-1.000.
--    FLOAT would drift on the threshold comparison that decides
--    whether a lawyer gets emailed.
-- ---------------------------------------------------------------
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS risk_score NUMERIC(4,3);
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS risk_level TEXT;


-- ---------------------------------------------------------------
-- 4. Provenance  ->  reproducibility of the Phase 4 number
--
--    "Precision 0.82" means nothing on its own. "Precision 0.82,
--    gpt-4o-mini, prompt v3" is a result someone else can
--    reproduce. Stored per row, so a mid-project prompt change
--    does not retroactively relabel older extractions.
-- ---------------------------------------------------------------
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS model          TEXT;
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE clauses ADD COLUMN IF NOT EXISTS extracted_at   TIMESTAMPTZ;


-- ---------------------------------------------------------------
-- 5. Guardrails
--
--    These exist to make bad data fail LOUDLY at insert time
--    instead of quietly corrupting the evaluation table.
--    A workflow that stops with a constraint error is a bug you
--    fix in ten minutes. A metric that is wrong by 6% because of
--    a stray lowercase clause type is a bug you never find.
-- ---------------------------------------------------------------

-- risk_score must sit in 0..1, matching confidence.
ALTER TABLE clauses DROP CONSTRAINT IF EXISTS clauses_risk_score_range;
ALTER TABLE clauses ADD CONSTRAINT clauses_risk_score_range
    CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 1));

-- risk_level is a fixed vocabulary.
ALTER TABLE clauses DROP CONSTRAINT IF EXISTS clauses_risk_level_valid;
ALTER TABLE clauses ADD CONSTRAINT clauses_risk_level_valid
    CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high', 'critical'));

-- A row cannot claim the clause is absent AND carry clause text.
-- This is the constraint that keeps raw segment text out of the
-- clauses table by accident.
ALTER TABLE clauses DROP CONSTRAINT IF EXISTS clauses_absent_has_no_text;
ALTER TABLE clauses ADD CONSTRAINT clauses_absent_has_no_text
    CHECK (is_absent = FALSE OR clause_text IS NULL);

-- Only the five locked clause types may ever enter this table.
-- If the LLM returns "governing law" in lowercase, the INSERT
-- fails instead of creating a sixth category that quietly scores
-- zero against every gold label.
ALTER TABLE clauses DROP CONSTRAINT IF EXISTS clauses_clause_type_valid;
ALTER TABLE clauses ADD CONSTRAINT clauses_clause_type_valid
    CHECK (clause_type IN (
        'Governing Law',
        'Termination For Convenience',
        'Cap On Liability',
        'Renewal Term',
        'Anti-Assignment'
    ));

COMMIT;

-- ===============================================================
-- No new indexes.
-- idx_clauses_document_id, idx_clauses_clause_type and
-- idx_clauses_review_status already exist from 001_schema.sql and
-- cover every query WF3, WF4 and the evaluator run.
-- ===============================================================
