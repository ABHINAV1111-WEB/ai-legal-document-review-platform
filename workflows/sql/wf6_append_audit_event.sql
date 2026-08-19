-- ===============================================================
-- WF6 - Audit Log & Dashboard
-- Node: Append Audit Event   (Postgres -> Execute Query)
--
-- Params come from Normalise Audit Event as $json.params:
--   $1 workflow_name  TEXT   required
--   $2 execution_id   TEXT   nullable
--   $3 document_id    BIGINT nullable  (NOT a foreign key - audit
--                                       rows must outlive the document)
--   $4 event_type     TEXT   required, lower_snake_case
--   $5 payload        JSONB  always an object, never null
--   $6 actor          TEXT   defaults to 'system'
--
-- Casts are required because n8n passes all query parameters as
-- text. Without ::bigint the insert fails; without ::jsonb the
-- payload is stored as a quoted string and stops being queryable.
--
-- No ON CONFLICT: audit_log is append-only by design. A duplicate
-- audit row is honest history (the caller really did fire twice),
-- whereas a swallowed row is a hole in the trail.
-- ===============================================================

INSERT INTO audit_log (
    workflow_name,
    execution_id,
    document_id,
    event_type,
    payload,
    actor
)
VALUES ($1, $2, $3::bigint, $4, $5::jsonb, $6)
RETURNING id, workflow_name, event_type, document_id, created_at;