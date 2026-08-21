// WF7 - Global Error Handler :: Classify Error
// Input : one item from the Error Trigger
// Output: one flat item describing the failure + a retryable/fatal verdict
//
// Why classify at all: a timeout and a bad API key both "fail", but one is
// worth retrying and one needs a human. Everything downstream branches on
// is_retryable, so the decision is made once, here, and never re-derived.

const input = $input.first().json || {};

const execution = input.execution || {};
const trigger   = input.trigger   || {};   // set instead of `execution` when a TRIGGER fails
const workflow  = input.workflow  || {};

const errObj = execution.error || trigger.error || {};

// ---- raw facts -------------------------------------------------------
const message = String(
  errObj.message || 'Unknown error - n8n supplied no message'
).slice(0, 2000);

const stack = String(errObj.stack || '').slice(0, 4000);

const failedNode = String(
  execution.lastNodeExecuted || (errObj.node && errObj.node.name) || 'unknown'
);

// httpCode arrives as a number OR a string depending on the node that threw.
const httpCodeRaw = errObj.httpCode !== undefined ? errObj.httpCode : null;
const httpCode = httpCodeRaw === null ? null : Number(httpCodeRaw);

// ---- classification --------------------------------------------------
// Match on the message AND the stack: n8n often puts the useful token
// (ETIMEDOUT, 429) in the stack while the message stays generic.
const haystack = (message + ' ' + stack).toLowerCase();

const has = (...needles) => needles.some((n) => haystack.includes(n));

let category = 'unknown';

if (has('etimedout', 'econnreset', 'econnrefused', 'enotfound', 'eai_again',
        'socket hang up', 'network', 'timeout', 'timed out')) {
  category = 'network';
} else if (has('rate limit', 'rate_limit', 'too many requests', '429', 'overloaded')) {
  category = 'rate_limit';
} else if (has('unauthorized', 'forbidden', '401', '403', 'invalid api key',
               'authentication', 'credentials')) {
  category = 'auth';
} else if (has('duplicate key', 'violates', 'constraint', 'relation ', 'syntax error at or near')) {
  category = 'database';
} else if (has('service unavailable', 'bad gateway', 'gateway timeout',
               'internal server error', '500', '502', '503', '504')) {
  category = 'server_error';
} else if (has('is not valid json', 'cannot read propert', 'undefined',
               'expects a', 'required')) {
  category = 'validation';
}

// httpCode is stronger evidence than text matching - let it override.
if (httpCode === 429) category = 'rate_limit';
else if (httpCode === 401 || httpCode === 403) category = 'auth';
else if (httpCode !== null && httpCode >= 500) category = 'server_error';

// Retryable = the same call, unchanged, might succeed in five minutes.
// Auth, database and validation failures will fail identically forever.
const RETRYABLE = ['network', 'rate_limit', 'server_error'];
const isRetryable = RETRYABLE.includes(category);

// ---- output ----------------------------------------------------------
return [{
  json: {
    workflow_name:  String(workflow.name || 'unknown workflow'),
    workflow_id:    String(workflow.id || ''),
    execution_id:   String(execution.id || trigger.id || ''),   // number on cloud -> force string
    execution_url:  String(execution.url || ''),
    run_mode:       String(execution.mode || trigger.mode || 'unknown'),

    failed_node:    failedNode,
    error_message:  message,
    error_stack:    stack,
    http_code:      httpCode,

    category:       category,
    is_retryable:   isRetryable,
    severity:       isRetryable ? 'warning' : 'critical',

    // WF7 usually has no document context. WF6's Normalise Audit Event
    // turns 0 into NULL, and audit_log.document_id is deliberately not a FK.
    document_id:    0,

    occurred_at:    new Date().toISOString(),
  },
}];