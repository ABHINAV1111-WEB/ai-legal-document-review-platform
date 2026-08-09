-- ===============================================================
-- Assignment 11 - AI Legal Document Review & Compliance Platform
-- Database schema (PostgreSQL 15+)
--
-- Save as: <project root>/sql/schema.sql
-- Run in : Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- SAFE TO RUN TWICE. Every statement uses IF NOT EXISTS, so
-- re-running changes nothing and destroys nothing.
-- ===============================================================


-- ---------------------------------------------------------------
-- 1. documents
--    One row per uploaded contract PDF.
--    file_hash is UNIQUE: this is the deduplication mechanism.
--    If the same PDF is uploaded twice, the second INSERT fails
--    and WF1 routes it to the "already seen" branch.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    filename     TEXT        NOT NULL,
    file_hash    TEXT        NOT NULL UNIQUE,
    drive_url    TEXT,
    doc_type     TEXT,
    page_count   INTEGER,
    status       TEXT        NOT NULL DEFAULT 'uploaded',
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT documents_status_valid CHECK (
        status IN ('uploaded', 'extracting', 'extracted',
                   'analyzing', 'analyzed', 'review', 'complete', 'failed')
    )
);


-- ---------------------------------------------------------------
-- 2. document_versions
--    Tracks re-uploads of the same contract over time.
--    ON DELETE CASCADE: deleting a document removes its versions,
--    so no orphan rows are left behind.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_versions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id  BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_no   INTEGER     NOT NULL,
    drive_url    TEXT,
    diff_summary TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT document_versions_unique UNIQUE (document_id, version_no)
);


-- ---------------------------------------------------------------
-- 3. clauses
--    One row per clause the LLM extracts. The core output table.
--
--    extracted_fields is JSONB because each clause type returns
--    different fields (Governing Law -> jurisdiction; Cap On
--    Liability -> amount + currency). JSONB lets that schema
--    evolve without a database migration, and unlike plain JSON
--    it can be indexed and queried:
--        WHERE extracted_fields->>'jurisdiction' = 'Delaware'
--
--    confidence is NUMERIC(4,3) -> values like 0.875, range 0..1.
--    NUMERIC is exact; FLOAT would introduce rounding drift in the
--    threshold comparison that decides whether a lawyer is emailed.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clauses (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id      BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    clause_type      TEXT        NOT NULL,
    clause_text      TEXT,
    page_no          INTEGER,
    char_start       INTEGER,
    char_end         INTEGER,
    extracted_fields JSONB       NOT NULL DEFAULT '{}'::JSONB,
    confidence       NUMERIC(4,3),
    review_status    TEXT        NOT NULL DEFAULT 'auto',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT clauses_confidence_range CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    CONSTRAINT clauses_review_status_valid CHECK (
        review_status IN ('auto', 'pending_review', 'approved',
                          'corrected', 'rejected')
    )
);


-- ---------------------------------------------------------------
-- 4. obligations
--    Dated commitments pulled out of clauses. Feeds WF5, the
--    daily renewal monitor.
--
--    notified_at stays NULL until a reminder is sent. WF5 filters
--    on "notified_at IS NULL" so the same person is never emailed
--    twice about the same deadline - this is what makes the cron
--    workflow safe to run every single day.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS obligations (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id        BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    clause_id          BIGINT      REFERENCES clauses(id) ON DELETE SET NULL,
    obligation_type    TEXT        NOT NULL,
    due_date           DATE,
    notify_days_before INTEGER     NOT NULL DEFAULT 30,
    notified_at        TIMESTAMPTZ,
    status             TEXT        NOT NULL DEFAULT 'open',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT obligations_status_valid CHECK (
        status IN ('open', 'notified', 'actioned', 'expired', 'cancelled')
    )
);


-- ---------------------------------------------------------------
-- 5. audit_log
--    Append-only. Every workflow writes here via WF6.
--    document_id is intentionally NOT a foreign key: audit records
--    must survive even if the document row is later deleted.
--    An audit trail that can be erased is not an audit trail.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_name TEXT        NOT NULL,
    execution_id  TEXT,
    document_id   BIGINT,
    event_type    TEXT        NOT NULL,
    payload       JSONB       NOT NULL DEFAULT '{}'::JSONB,
    actor         TEXT        NOT NULL DEFAULT 'system',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------
-- 6. gold_labels
--    Expert answers from CUAD. The yardstick for Phase 4.
--
--    is_absent = TRUE means CUAD's lawyers confirmed this clause
--    type is genuinely NOT in this contract. Those rows are how
--    false positives get measured - without them you could only
--    measure recall.
--
--    answer_start is NOT NULL and uses -1 for absent clauses.
--    Reason: PostgreSQL treats NULLs as distinct in UNIQUE
--    constraints, so NULL rows would never collide and
--    load_gold_labels.py could not be safely re-run.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gold_labels (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_title TEXT        NOT NULL,
    pdf_filename   TEXT        NOT NULL,
    split          TEXT        NOT NULL,
    clause_type    TEXT        NOT NULL,
    expected_text  TEXT,
    answer_start   INTEGER     NOT NULL DEFAULT -1,
    is_absent      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT gold_labels_split_valid CHECK (split IN ('dev', 'holdout')),

    -- Makes load_gold_labels.py idempotent: re-running uses
    -- ON CONFLICT DO NOTHING instead of duplicating ~150 rows.
    CONSTRAINT gold_labels_unique UNIQUE (pdf_filename, clause_type, answer_start)
);


-- ===============================================================
-- Indexes
-- An index is a lookup shortcut. Without one, Postgres reads every
-- row. These cover the queries the workflows actually run.
-- ===============================================================

-- WF1 dedup check runs on every upload.
-- (file_hash UNIQUE already creates an index, so none needed here.)

-- WF3/WF4 fetch all clauses for one document.
CREATE INDEX IF NOT EXISTS idx_clauses_document_id
    ON clauses (document_id);

-- Evaluation groups results by clause type.
CREATE INDEX IF NOT EXISTS idx_clauses_clause_type
    ON clauses (clause_type);

-- WF4 finds everything waiting on a lawyer.
CREATE INDEX IF NOT EXISTS idx_clauses_review_status
    ON clauses (review_status);

-- WF5's core query: deadlines inside the notification window that
-- have not been notified yet. Partial index - only indexes the rows
-- WF5 cares about, so it stays small as the table grows.
CREATE INDEX IF NOT EXISTS idx_obligations_due_pending
    ON obligations (due_date)
    WHERE notified_at IS NULL;

-- WF6 dashboard aggregates by document and by time.
CREATE INDEX IF NOT EXISTS idx_audit_log_document_id
    ON audit_log (document_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);

-- Phase 4 evaluation reads dev and holdout separately.
CREATE INDEX IF NOT EXISTS idx_gold_labels_split_type
    ON gold_labels (split, clause_type);
