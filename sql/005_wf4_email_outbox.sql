-- ===============================================================
-- Assignment 11 - Migration 005
-- email_outbox : queued outbound email
--
-- Save as: <project root>/sql/005_wf4_email_outbox.sql
-- Run in : Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- SAFE TO RUN TWICE. Every statement uses IF NOT EXISTS.
-- ===============================================================


-- ---------------------------------------------------------------
-- Why this table exists
--
-- No Gmail credential is configured, so WF4 cannot send mail
-- directly. Instead every workflow that needs to notify a human
-- INSERTs a row here. The row IS the email: recipient, subject,
-- body, and status.
--
-- This is not a workaround - it is the standard outbox pattern.
-- Real systems write the message to durable storage first and let
-- a separate sender deliver it, so a mail-provider outage cannot
-- lose a notification. Adding Gmail later means adding one node
-- that reads status='queued' rows and flips them to 'sent'.
-- Nothing else in WF4 changes.
--
-- The table is deliberately generic (not review-only) because WF5,
-- the daily renewal monitor, sends email too and will reuse it.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_outbox (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- What this message is about. Lets WF5 share the table without
    -- colliding with WF4, and makes the demo query easy to filter.
    purpose           TEXT        NOT NULL,

    -- Optional links back to the thing that caused the email.
    -- NULLable because WF5's renewal reminders have no review_request,
    -- and a future digest email may have no single document.
    -- CASCADE: if the review request is deleted the email is moot.
    review_request_id BIGINT      REFERENCES review_requests(id) ON DELETE CASCADE,
    document_id       BIGINT      REFERENCES documents(id)       ON DELETE CASCADE,

    to_address        TEXT        NOT NULL,
    subject           TEXT        NOT NULL,
    body_text         TEXT        NOT NULL,

    -- Lifecycle of the message itself, separate from the lifecycle
    -- of the review decision. An email can be 'sent' while the
    -- review is still 'pending'.
    status            TEXT        NOT NULL DEFAULT 'queued',

    -- Which transport handled it. 'outbox' means nothing actually
    -- left the building - it sat in this table and was read by a
    -- human. 'gmail' would be set by the future sender node.
    provider          TEXT        NOT NULL DEFAULT 'outbox',

    -- Populated only when a real send fails, so failures are
    -- diagnosable instead of silent.
    error             TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at           TIMESTAMPTZ,

    CONSTRAINT email_outbox_status_valid CHECK (
        status IN ('queued', 'sent', 'failed')
    ),

    CONSTRAINT email_outbox_purpose_not_blank CHECK (
        length(btrim(purpose)) > 0
    ),

    CONSTRAINT email_outbox_to_not_blank CHECK (
        length(btrim(to_address)) > 0
    ),

    -- A row claiming to be sent must say when. Prevents a half-
    -- written update from looking like a successful delivery.
    CONSTRAINT email_outbox_sent_has_timestamp CHECK (
        status <> 'sent' OR sent_at IS NOT NULL
    )
);


-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------

-- The future sender node's query: "give me everything still queued,
-- oldest first". Partial index - only queued rows are stored, so it
-- stays tiny no matter how many emails have already been sent.
CREATE INDEX IF NOT EXISTS idx_email_outbox_queued
    ON email_outbox (created_at)
    WHERE status = 'queued';

-- The demo query: find the email belonging to a given review request.
CREATE INDEX IF NOT EXISTS idx_email_outbox_review_request
    ON email_outbox (review_request_id);


-- ---------------------------------------------------------------
-- Verification
-- Should return one row: 0
-- ---------------------------------------------------------------
SELECT COUNT(*) AS email_outbox_rows FROM email_outbox;
