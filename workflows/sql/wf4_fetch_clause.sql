-- ===============================================================
-- WF4 - Lawyer Review & Approval
-- Node: "Fetch Clause"  (Postgres -> Execute Query)
--
-- Repo copy of the query that lives in the n8n node. Kept here so
-- the SQL is reviewable in git instead of buried in exported JSON.
--
-- Parameter $1 = clause_id, passed from the trigger as:
--     {{ [ $json.clause_id ] }}
-- ===============================================================

SELECT
    c.id                AS clause_id,
    c.document_id,
    c.clause_type,
    c.clause_text,
    c.page_no,
    c.confidence,
    c.risk_score,
    c.risk_level,
    c.is_absent,
    c.review_status,

    -- attribution is the WF3 provenance flag and lives inside the
    -- JSONB blob, not as a column. COALESCE so a missing key reads
    -- as 'unknown' instead of NULL and silently failing comparisons.
    COALESCE(c.extracted_fields->>'attribution', 'unknown') AS attribution,

    d.filename,

    -- The routing rule, evaluated in SQL rather than in a Code node.
    -- Putting it here means the database is the single place the
    -- policy is written, and the same predicate can be reused by the
    -- WF3-side query that decides which clauses to send at all.
    --
    -- Evidence-based, not confidence-based: nothing in this dataset
    -- scores below 0.84 confidence, so a confidence threshold routes
    -- nothing. "We could not find this text in the source document"
    -- is a defensible reason to involve a human; "it scored 0.69"
    -- is not.
    (
        COALESCE(c.extracted_fields->>'attribution', '') = 'not_found'
        OR (c.is_absent AND COALESCE(c.risk_score, 0) >= 0.60)
    )                   AS needs_review,

    -- Idempotency guard. If this clause already has an open review
    -- request, a second email would put two live tokens for the same
    -- decision into a lawyer's inbox. Counting here lets a later IF
    -- node short-circuit instead of creating the duplicate.
    --
    -- This is the "what if the webhook fires twice" case, handled
    -- rather than assumed away.
    (
        SELECT COUNT(*)
        FROM review_requests rr
        WHERE rr.clause_id = c.id
          AND rr.status = 'pending'
    )                   AS pending_requests

FROM clauses c
JOIN documents d ON d.id = c.document_id
WHERE c.id = $1;
