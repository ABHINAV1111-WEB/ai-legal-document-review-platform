-- ===============================================================
-- WF6 - Audit Log & Dashboard
-- Node: Queue Digest   (Postgres -> Execute Query)
--
-- Params from Build Digest as $json.params:
--   $1 purpose     'weekly_digest'
--   $2 to_address
--   $3 subject
--   $4 body_text
--   $5 status      'queued'
--
-- INSERT ... SELECT ... WHERE NOT EXISTS is the idempotency guard:
-- at most one weekly_digest row per calendar day. A retried or
-- manually re-run execution becomes a no-op instead of a second
-- identical email.
--
-- Deliberately NOT ON CONFLICT: email_outbox has no unique
-- constraint covering this case. The partial unique index from
-- migration 007 only covers obligation_id IS NOT NULL, and a
-- digest row leaves obligation_id NULL, so it never collides.
--
-- review_request_id, obligation_id and document_id are all left
-- NULL: a digest is about the whole system, not one record.
--
-- Returns zero rows when the guard blocks, so the node needs
-- "Always Output Data" ON.
--
-- To re-run a demo on the same day:
--   DELETE FROM email_outbox
--    WHERE purpose = 'weekly_digest'
--      AND created_at >= date_trunc('day', NOW());
-- ===============================================================

INSERT INTO email_outbox (purpose, to_address, subject, body_text, status)
SELECT $1, $2, $3, $4, $5
WHERE NOT EXISTS (
    SELECT 1
    FROM email_outbox
    WHERE purpose = $1
      AND created_at >= date_trunc('day', NOW())
)
RETURNING id, purpose, to_address, subject, status, created_at;