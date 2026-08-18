-- ===============================================================
-- WF5 - Renewal & Deadline Monitor
-- Node: "Find Due Obligations" (Postgres -> Execute Query)
--
-- This is the COMMENTED reference copy. The n8n node holds the
-- bare statement only: the Postgres node can choke on a long
-- "--" comment header placed before the statement.
--
-- Query Parameters (n8n -> Options -> Query Parameters):
--     {{ [$json.windows.upcoming, $json.windows.soon, $json.windows.urgent] }}
--   $1 = upcoming window, default 30 days
--   $2 = soon window,     default 14 days
--   $3 = urgent window,   default  7 days
--
-- Values come from the "Config - Notification Windows" Set node,
-- never hardcoded here (project convention, instructions s.11).
--
-- SCOPE NOTE - read before demoing:
--   These obligations are INTERNAL REVIEW DEADLINES, not
--   contractual renewal dates. obligation_type = 'renewal_review',
--   date_source = 'review_schedule'. WF3's extraction schema does
--   not return renewal_date / notice_period_days / term_end_date,
--   so no contractual date exists anywhere in the database.
--   Automatic extraction of contractual dates is documented as
--   future work. Do not claim WF5 tracks real renewal deadlines.
-- ===============================================================

SELECT
    o.id                        AS obligation_id,
    o.document_id,
    o.clause_id,
    o.obligation_type,
    o.date_source,
    o.due_date,
    o.notify_days_before,

    -- Postgres DATE minus DATE returns an integer number of days.
    (o.due_date - CURRENT_DATE) AS days_until_due,

    -- Urgency tier. Because "notified_at IS NULL" is in the WHERE
    -- clause, each obligation is emitted exactly once - at the
    -- first window it crosses. The tier therefore changes the
    -- WORDING of the reminder, not how many reminders are sent.
    CASE
        WHEN (o.due_date - CURRENT_DATE) <= $3::int THEN 'urgent'
        WHEN (o.due_date - CURRENT_DATE) <= $2::int THEN 'soon'
        ELSE 'upcoming'
    END                         AS urgency,

    d.filename,
    c.clause_type

FROM obligations o

-- INNER JOIN: an obligation without a parent document is corrupt
-- data and must not silently generate an email.
JOIN documents d  ON d.id = o.document_id

-- LEFT JOIN: clause_id is ON DELETE SET NULL in the schema, so an
-- obligation can legitimately outlive its clause.
LEFT JOIN clauses c ON c.id = o.clause_id

WHERE o.status  = 'open'

  -- The deduplication mechanism. This is what makes a DAILY cron
  -- safe to run: once a reminder is queued, "Mark Notified" stamps
  -- notified_at and the row never matches again.
  AND o.notified_at IS NULL

  AND o.due_date IS NOT NULL

  -- Already-overdue obligations are excluded. They are a different
  -- problem (escalation) and would otherwise be re-sent forever.
  AND o.due_date >= CURRENT_DATE

  -- The config window is a CEILING. A row carrying a tighter
  -- notify_days_before gets the shorter lead time instead.
  -- ::int casts are required - n8n passes query parameters as text.
  AND (o.due_date - CURRENT_DATE) <= LEAST($1::int, o.notify_days_before)

ORDER BY o.due_date ASC, o.id ASC;
