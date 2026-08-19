// ===============================================================
// WF5 - Renewal & Deadline Monitor
// Node: "Build Reminder"  (Code -> Run Once for Each Item)
//
// Repo copy: workflows/code/wf5_build_reminder.js
//
// Input : one row from "Find Due Obligations", via Loop Over Items
// Output: one item shaped for the "Queue Reminder" Postgres INSERT
//         into email_outbox, plus obligation_id for "Mark Notified".
//
// SCOPE HONESTY: the body text says out loud that this is an
// INTERNAL review deadline, not a contractual renewal date. WF3's
// extraction schema returns no dates, so none exist in the DB.
// The email must not imply otherwise.
// ===============================================================

const o = $json;

// ---------------------------------------------------------------
// Recipient. Never hardcoded here. Resolution order:
//   1. n8n Variable REVIEW_EMAIL  (Settings -> Variables; Enterprise
//      tier only, so unavailable on this instance)
//   2. review_email on the "Config - Notification Windows" node
//
// $env is deliberately NOT used: n8n Cloud blocks environment
// access at the platform level and it cannot be re-enabled without
// a docker-compose file. Keeping the $vars branch means this
// workflow runs unchanged on a self-hosted or paid instance.
//
// Fail loudly on a blank address: a reminder with no recipient is
// worse than an error, because it lands in email_outbox looking
// like it worked.
// ---------------------------------------------------------------
const varsEmail =
  typeof $vars !== 'undefined' && $vars ? $vars.REVIEW_EMAIL : null;
const configEmail = $('Config - Notification Windows').first().json.review_email;

const toAddress = String(varsEmail || configEmail || '').trim();
if (!toAddress) {
  throw new Error(
    'REVIEW_EMAIL not resolved. Set the n8n Variable REVIEW_EMAIL, ' +
      'or set review_email on the "Config - Notification Windows" node.'
  );
}

// ---------------------------------------------------------------
// Policy windows, pulled from the config node so the email can
// state the policy it is operating under. Not re-derived here.
// ---------------------------------------------------------------
const windows = $('Config - Notification Windows').first().json.windows;

// ---------------------------------------------------------------
// Postgres returns BIGINT as a STRING (known bug #3). Cast the
// values used in arithmetic or comparison; leave the id values as
// strings, Postgres casts them back on INSERT.
// ---------------------------------------------------------------
const daysUntil = Number(o.days_until_due);
const urgency = String(o.urgency || 'upcoming');

const LABEL = {
  urgent: 'URGENT',
  soon: 'Action needed',
  upcoming: 'Upcoming',
};
const label = LABEL[urgency] || 'Upcoming';

// CUAD filenames are extremely long. Keep the subject line readable
// but keep the FULL filename in the body so the document is
// unambiguous.
const fullName = String(o.filename || 'unknown document');
const shortName =
  fullName.length > 60 ? fullName.slice(0, 57) + '...' : fullName;

const dayWord = daysUntil === 1 ? 'day' : 'days';
const subject = `[${label}] Review due in ${daysUntil} ${dayWord} - ${shortName}`;

// clause_id is ON DELETE SET NULL, so the LEFT JOIN can yield nulls.
const clauseLine =
  o.clause_id === null || o.clause_id === undefined
    ? 'not linked (clause row removed)'
    : `${o.clause_type || 'unknown type'} (clause id ${o.clause_id})`;

const bodyText = [
  'Automated reminder - AI Legal Document Review & Compliance Platform',
  '',
  'A scheduled review deadline is approaching.',
  '',
  `  Document        : ${fullName}`,
  `  Document ID     : ${o.document_id}`,
  `  Clause          : ${clauseLine}`,
  `  Obligation      : ${o.obligation_type} (id ${o.obligation_id})`,
  `  Due date        : ${o.due_date}`,
  `  Days remaining  : ${daysUntil}`,
  `  Urgency         : ${urgency}`,
  '',
  'WHAT THIS IS',
  '  An INTERNAL review deadline generated on a fixed schedule',
  `  (date_source = ${o.date_source}). It is NOT a contractual renewal`,
  '  or notice date read out of the contract text - the extraction',
  '  pipeline does not currently capture contractual dates.',
  '',
  'WHAT TO DO',
  '  Re-read the Renewal Term clause for this document and confirm',
  '  the renewal and notice position before the due date above.',
  '',
  'POLICY',
  `  Notification windows: ${windows.upcoming} / ${windows.soon} / ${windows.urgent} days before due date.`,
  '  Each obligation is notified exactly once.',
  '',
  '-- WF5 - Renewal & Deadline Monitor',
].join('\n');

// ---------------------------------------------------------------
// params[] is consumed directly by "Queue Reminder" as
//   {{ $json.params }}   (bare - known bug #2 exception)
// Order must match the INSERT column order exactly:
//   purpose, obligation_id, document_id, to_address, subject, body_text
// obligation_id backs the partial unique index added in migration
// 007, which is what makes ON CONFLICT DO NOTHING able to swallow
// a duplicate queue attempt after a mid-loop crash.
// ---------------------------------------------------------------
return {
  json: {
    obligation_id: o.obligation_id,
    document_id: o.document_id,
    purpose: 'renewal_reminder',
    to_address: toAddress,
    subject,
    body_text: bodyText,
    urgency,
    days_until_due: daysUntil,
    params: [
      'renewal_reminder',
      o.obligation_id,
      o.document_id,
      toAddress,
      subject,
      bodyText,
    ],
  },
};
