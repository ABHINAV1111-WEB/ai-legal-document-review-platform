-- ===============================================================
-- Assignment 11 - AI Legal Document Review & Compliance Platform
-- Migration 004: WF4 (Lawyer Review & Approval)
--
-- Save as: <project root>/sql/004_wf4_review.sql
-- Run in : Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- SAFE TO RUN TWICE.
-- Depends on: 001_schema.sql, 002_wf2_segments.sql, 003_wf3_extraction.sql
-- ===============================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1. review_requests
--
--    One row per clause sent to a lawyer. Separate from `clauses`
--    for three reasons:
--
--    a) A clause can be reviewed more than once - re-run WF3, get a
--       new extraction, ask again. One row per ASKING keeps that
--       history instead of overwriting it.
--    b) The resume token must be unique and revocable. Storing it on
--       `clauses` would mean the token dies when the clause is
--       re-extracted, breaking any email already sent.
--    c) WF6's dashboard reports review turnaround time. That needs
--       sent_at and decided_at as first-class columns.
--
--    token is the security boundary. The email contains a link with
--    this value; anyone holding it can decide the clause. It is a
--    UUID rather than the clause id precisely so it cannot be
--    guessed by incrementing a number.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_requests (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clause_id     BIGINT      NOT NULL REFERENCES clauses(id) ON DELETE CASCADE,
    document_id   BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    token         UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    reason        TEXT        NOT NULL,
    reviewer      TEXT,
    status        TEXT        NOT NULL DEFAULT 'pending',
    decision      TEXT,
    corrected_text TEXT,
    reviewer_note TEXT,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at    TIMESTAMPTZ,

    CONSTRAINT review_requests_status_valid CHECK (
        status IN ('pending', 'decided', 'expired', 'cancelled')
    ),
    CONSTRAINT review_requests_decision_valid CHECK (
        decision IS NULL OR decision IN ('approve', 'correct', 'reject')
    ),
    -- A correction with no corrected text is a bug, not a decision.
    CONSTRAINT review_requests_correction_has_text CHECK (
        decision IS DISTINCT FROM 'correct' OR corrected_text IS NOT NULL
    ),
    -- reason records WHY this went to a human. Kept as free text
    -- rather than an enum because the routing rule will change in
    -- Phase 2 once tau is set empirically, and old rows should stay
    -- readable rather than failing a tightened constraint.
    CONSTRAINT review_requests_reason_not_blank CHECK (length(trim(reason)) > 0)
);

-- WF4 looks up a pending request by token on every webhook hit.
-- UNIQUE on token already builds this index, so none is added here.

-- WF6 aggregates open reviews and turnaround time.
CREATE INDEX IF NOT EXISTS idx_review_requests_status
    ON review_requests (status, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_requests_clause
    ON review_requests (clause_id);


-- ---------------------------------------------------------------
-- 2. gold_labels gains a provenance column
--
--    Lawyer corrections are appended to gold_labels, so the system
--    grows its own test set. But a Phase 4 evaluation that scores
--    against labels the system itself produced is circular.
--
--    source separates the two. evaluate.py must filter to
--    source = 'cuad' for the headline number. Corrections are a
--    second, clearly-labelled dataset.
-- ---------------------------------------------------------------
ALTER TABLE gold_labels
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'cuad';

ALTER TABLE gold_labels DROP CONSTRAINT IF EXISTS gold_labels_source_valid;
ALTER TABLE gold_labels ADD CONSTRAINT gold_labels_source_valid
    CHECK (source IN ('cuad', 'lawyer_review'));

COMMIT;

-- ===============================================================
-- Verify:
--   SELECT COUNT(*) FROM review_requests;              -- expect 0
--   SELECT source, COUNT(*) FROM gold_labels GROUP BY 1;  -- expect cuad | 260
-- ===============================================================
