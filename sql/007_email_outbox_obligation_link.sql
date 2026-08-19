-- ===============================================================
-- 007 - link email_outbox rows to the obligation that caused them
--
-- WF5 dedup has two layers:
--   1. obligations.notified_at IS NULL  - the daily filter
--   2. this unique index                - the crash-safety net
--
-- Layer 1 fails if an execution dies between "Queue Reminder" and
-- "Mark Notified": the outbox row exists, notified_at is still
-- NULL, and the next cron run queues a duplicate. Layer 2 makes
-- that second INSERT a no-op instead.
--
-- Nullable + ON DELETE SET NULL: WF4 rows have no obligation, and
-- an outbox record must outlive the obligation it refers to.
-- Mirrors the existing review_request_id column.
--
-- SAFE TO RUN TWICE.
-- ===============================================================

ALTER TABLE email_outbox
    ADD COLUMN IF NOT EXISTS obligation_id BIGINT
        REFERENCES obligations(id) ON DELETE SET NULL;

-- Partial unique index: at most one reminder per obligation, ever.
-- Partial so WF4's rows (obligation_id NULL) are unaffected -
-- Postgres treats NULLs as distinct, so they never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_outbox_obligation
    ON email_outbox (obligation_id)
    WHERE obligation_id IS NOT NULL;