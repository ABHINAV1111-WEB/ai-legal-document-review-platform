-- ===============================================================
-- WF6 - Audit Log & Dashboard
-- Node: Aggregate Stats   (Postgres -> Execute Query)
--
-- Params:  $1 = lookback_days, from Config - Digest Settings.
--          ::int cast required - n8n sends parameters as text.
--
-- Returns EXACTLY ONE ROW, always, even on an empty database.
-- Each section is a JSON array so Build Digest can loop over it
-- without a second query. COALESCE(..., '[]') is what guarantees
-- the row survives when an aggregate matches nothing - json_agg
-- returns NULL, not an empty array, when it sees no input.
--
-- Windowed (events):  audit_log, email_outbox, documents ingested
-- Snapshot (state) :  clause review status, document status,
--                     open obligations
-- ===============================================================

SELECT
    $1::int                                   AS lookback_days,
    (NOW() - make_interval(days => $1::int))  AS window_start,
    NOW()                                     AS window_end,

    -- how much work each workflow did, split by event type
    COALESCE((
        SELECT json_agg(t ORDER BY t.workflow_name, t.event_type)
        FROM (
            SELECT workflow_name, event_type, COUNT(*)::int AS n
            FROM audit_log
            WHERE created_at >= NOW() - make_interval(days => $1::int)
            GROUP BY workflow_name, event_type
        ) t
    ), '[]'::json) AS audit_events,

    -- current state of the human-review queue
    COALESCE((
        SELECT json_agg(t ORDER BY t.review_status)
        FROM (
            SELECT review_status, COUNT(*)::int AS n
            FROM clauses
            GROUP BY review_status
        ) t
    ), '[]'::json) AS clause_review,

    -- current state of the document pipeline
    COALESCE((
        SELECT json_agg(t ORDER BY t.status)
        FROM (
            SELECT status, COUNT(*)::int AS n
            FROM documents
            GROUP BY status
        ) t
    ), '[]'::json) AS document_status,

    -- what the outbox tried to send this week
    COALESCE((
        SELECT json_agg(t ORDER BY t.purpose, t.status)
        FROM (
            SELECT purpose, status, COUNT(*)::int AS n
            FROM email_outbox
            WHERE created_at >= NOW() - make_interval(days => $1::int)
            GROUP BY purpose, status
        ) t
    ), '[]'::json) AS outbox_activity,

    -- headline numbers
    (SELECT COUNT(*)::int FROM audit_log
      WHERE created_at >= NOW() - make_interval(days => $1::int))     AS audit_rows_in_window,
    (SELECT COUNT(*)::int FROM documents
      WHERE uploaded_at >= NOW() - make_interval(days => $1::int))    AS documents_ingested,
    (SELECT COUNT(*)::int FROM clauses
      WHERE review_status = 'pending_review')                          AS clauses_awaiting_review,
    (SELECT COUNT(*)::int FROM obligations
      WHERE status = 'open' AND notified_at IS NULL)                   AS obligations_unnotified,
    (SELECT COUNT(*)::int FROM email_outbox
      WHERE status = 'queued')                                         AS outbox_queued_total;