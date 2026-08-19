-- WF5 demo reset. NOT a migration - do not number it.
-- Clears the notification state so the workflow can be
-- demonstrated end-to-end again.

DELETE FROM email_outbox
WHERE purpose = 'renewal_reminder';

UPDATE obligations
SET notified_at = NULL,
    status      = 'open'
WHERE obligation_type = 'renewal_review';