/**
 * WF6 - Audit Log & Dashboard
 * Node: Build Digest   (Code node, "Run Once for All Items")
 *
 * In  : one item from "Aggregate Stats"
 * Out : one item carrying subject, body_text and a 5-element
 *       `params` array for the "Queue Digest" Postgres node.
 *
 * Address resolution keeps the $vars branch first so this workflow
 * runs unchanged on a self-hosted instance, where $vars exists.
 * On n8n Cloud $vars is Enterprise-only, so the config node wins.
 */

const stats = $input.first().json;
const cfg = $('Config - Digest Settings').first().json;

// --- recipient ------------------------------------------------------
const varsEmail =
  typeof $vars !== 'undefined' && $vars ? $vars.REVIEW_EMAIL : null;
const toAddress = String(varsEmail || cfg.review_email || '').trim();
if (!toAddress) {
  throw new Error(
    'REVIEW_EMAIL not resolved. Set review_email in "Config - Digest Settings", ' +
    'or REVIEW_EMAIL as an n8n Variable on a self-hosted instance.'
  );
}

// --- helpers --------------------------------------------------------
const n = (v) => Number(v ?? 0);
const asArray = (v) => (Array.isArray(v) ? v : []);
const dateOnly = (iso) => String(iso ?? '').slice(0, 10);

// Renders [{a:'x', n:3}] as "  x .......... 3"
const table = (rows, keys, emptyText) => {
  if (!rows.length) return `  (${emptyText})`;
  const label = (r) => keys.map((k) => r[k]).join(' / ');
  const width = Math.max(...rows.map((r) => label(r).length));
  return rows
    .map((r) => `  ${label(r).padEnd(width, ' ')}   ${String(n(r.n)).padStart(5, ' ')}`)
    .join('\n');
};

// --- pull the sections ----------------------------------------------
const auditEvents = asArray(stats.audit_events);
const clauseReview = asArray(stats.clause_review);
const documentStatus = asArray(stats.document_status);
const outboxActivity = asArray(stats.outbox_activity);

const lookbackDays = n(stats.lookback_days);
const windowStart = dateOnly(stats.window_start);
const windowEnd = dateOnly(stats.window_end);

const auditRows = n(stats.audit_rows_in_window);
const docsIngested = n(stats.documents_ingested);
const awaitingReview = n(stats.clauses_awaiting_review);
const unnotified = n(stats.obligations_unnotified);
const outboxQueued = n(stats.outbox_queued_total);

// --- things a human should act on -----------------------------------
const attention = [];
if (awaitingReview > 0) {
  attention.push(
    `${awaitingReview} clause(s) are sitting in pending_review and are blocking WF4.`
  );
}
if (outboxQueued > 0) {
  attention.push(
    `${outboxQueued} email(s) are queued but unsent. No mail provider is configured ` +
    `yet, so this is expected until a Gmail credential is added.`
  );
}
if (auditRows === 0) {
  attention.push(
    `No audit events were recorded in the last ${lookbackDays} day(s). ` +
    `Either the pipeline was idle, or a workflow is not calling WF6.`
  );
}
if (unnotified > 0) {
  attention.push(
    `${unnotified} open obligation(s) have not been notified. ` +
    `Expected if their due dates are outside the notification window.`
  );
}

const attentionBlock = attention.length
  ? attention.map((line, i) => `  ${i + 1}. ${line}`).join('\n')
  : '  Nothing requires attention.';

// --- subject --------------------------------------------------------
const prefix = String(cfg.digest_subject_prefix || '[Assign11] Weekly audit digest').trim();
const subject = `${prefix} - ${windowEnd} - ${auditRows} events, ${awaitingReview} awaiting review`;

// --- body -----------------------------------------------------------
const bodyText = [
  'AI Legal Document Review & Compliance Platform',
  'Weekly operations digest',
  '',
  `Window: ${windowStart} to ${windowEnd} (${lookbackDays} days)`,
  '',
  '--------------------------------------------------------',
  'HEADLINE',
  '--------------------------------------------------------',
  `  Audit events recorded        ${auditRows}`,
  `  Documents ingested           ${docsIngested}`,
  `  Clauses awaiting review      ${awaitingReview}`,
  `  Obligations not yet notified ${unnotified}`,
  `  Emails queued, unsent        ${outboxQueued}`,
  '',
  '--------------------------------------------------------',
  'NEEDS ATTENTION',
  '--------------------------------------------------------',
  attentionBlock,
  '',
  '--------------------------------------------------------',
  `WORKFLOW ACTIVITY (last ${lookbackDays} days)`,
  '--------------------------------------------------------',
  table(auditEvents, ['workflow_name', 'event_type'], 'no audit events in this window'),
  '',
  '--------------------------------------------------------',
  'CLAUSE REVIEW STATE (all time)',
  '--------------------------------------------------------',
  table(clauseReview, ['review_status'], 'no clauses extracted yet'),
  '',
  '--------------------------------------------------------',
  'DOCUMENT PIPELINE STATE (all time)',
  '--------------------------------------------------------',
  table(documentStatus, ['status'], 'no documents ingested yet'),
  '',
  '--------------------------------------------------------',
  `OUTBOX ACTIVITY (last ${lookbackDays} days)`,
  '--------------------------------------------------------',
  table(outboxActivity, ['purpose', 'status'], 'no outbound mail queued in this window'),
  '',
  '--------------------------------------------------------',
  'NOTES',
  '--------------------------------------------------------',
  '  Review and pipeline states are point-in-time snapshots of the',
  '  whole database. Event counts are windowed.',
  '',
  '  No mail provider is configured. This digest is written to the',
  '  email_outbox table rather than sent. Adding a Gmail credential',
  '  and one send node is the only change required.',
  '',
  '  Generated automatically by WF6 - Audit Log & Dashboard.',
].join('\n');

// --- output ---------------------------------------------------------
return [
  {
    json: {
      to_address: toAddress,
      subject,
      body_text: bodyText,
      audit_rows_in_window: auditRows,
      clauses_awaiting_review: awaitingReview,

      // the only field the Postgres node reads
      // $1 purpose, $2 to_address, $3 subject, $4 body_text, $5 status
      params: ['weekly_digest', toAddress, subject, bodyText, 'queued'],
    },
  },
];