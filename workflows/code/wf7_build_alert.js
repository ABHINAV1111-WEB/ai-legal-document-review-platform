// WF7 - Global Error Handler :: Build Alert
// Input : one item from either Set - Retryable Alert or Set - Fatal Alert
// Output: one item carrying subject, body_text and a ready-made params array
//         for the Postgres node (bug #2 - a Code-built array passes bare).

const e = $input.first().json || {};

const maxBody = Number(e.max_body_chars) || 6000;

const subject =
  `${e.subject_prefix} ${e.urgency_label} - ${e.workflow_name} / ${e.failed_node}`
  .slice(0, 500);

// Stack goes last: it is the least readable part and the first thing to lose
// if the body gets truncated.
const lines = [
  `${e.urgency_label} error in workflow: ${e.workflow_name}`,
  '',
  `Failed node   : ${e.failed_node}`,
  `Category      : ${e.category}`,
  `Severity      : ${e.severity}`,
  `HTTP code     : ${e.http_code === null ? 'n/a' : e.http_code}`,
  `Run mode      : ${e.run_mode}`,
  `Occurred at   : ${e.occurred_at}`,
  `Execution     : ${e.execution_id}`,
  `Execution URL : ${e.execution_url || 'n/a'}`,
  '',
  'MESSAGE',
  e.error_message,
  '',
  'WHAT THIS MEANS',
  e.guidance_text,
  '',
  'STACK',
  e.error_stack || '(none supplied)',
];

let bodyText = lines.join('\n');
if (bodyText.length > maxBody) {
  bodyText = bodyText.slice(0, maxBody - 20) + '\n...[truncated]';
}

// Dedup key: one alert per workflow+node+category per calendar day.
// A cron that fails every run would otherwise queue 24 identical emails.
const day = String(e.occurred_at || '').slice(0, 10);   // YYYY-MM-DD
const dedupKey = `${e.workflow_name}|${e.failed_node}|${e.category}|${day}`;

const toAddress = String(e.alert_email || '').trim();
if (!toAddress) {
  throw new Error('alert_email not resolved - check Config - Alert Settings');
}

return [{
  json: {
    subject,
    body_text: bodyText,
    to_address: toAddress,
    dedup_key: dedupKey,

    // carried through for the WF6 audit call
    workflow_name: e.workflow_name,
    failed_node:   e.failed_node,
    category:      e.category,
    severity:      e.severity,
    is_retryable:  e.is_retryable,
    execution_id:  e.execution_id,
    error_message: e.error_message,

    // purpose, to_address, subject, body_text - matches Queue Alert's $1..$4
    params: ['error_alert', toAddress, subject, bodyText],
  },
}];