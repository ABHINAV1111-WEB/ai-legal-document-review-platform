/**
 * WF6 - Audit Log & Dashboard
 * Node: Normalise Audit Event   (Code node, "Run Once for All Items")
 *
 * In  : items from "When Executed by Another Workflow"
 *       (workflow_name, event_type, document_id, payload, actor, execution_id)
 * Out : one item per input item, each carrying a 6-element `params` array
 *       for the "Append Audit Event" Postgres node.
 */

const out = [];

for (const item of $input.all()) {
  const src = item.json ?? {};

  // --- workflow_name : REQUIRED -------------------------------------
  const workflowName = String(src.workflow_name ?? '').trim();
  if (!workflowName) {
    throw new Error(
      'Audit event rejected: workflow_name is empty. ' +
      'Caller must send e.g. "WF1 - Ingestion & Storage".'
    );
  }

  // --- event_type : REQUIRED, forced to lower_snake_case -------------
  // Callers will not be consistent. Normalising here keeps the
  // WF6 weekly GROUP BY from splitting one event across three spellings.
  const eventType = String(src.event_type ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!eventType) {
    throw new Error(
      `Audit event rejected: event_type is empty (workflow_name="${workflowName}").`
    );
  }

  // --- document_id : optional, BIGINT or NULL ------------------------
  // Postgres hands BIGINT back as a string (bug #3), so a caller
  // forwarding a DB value sends "4", not 4. Accept both.
  let documentId = null;
  const rawId = src.document_id;
  if (rawId !== null && rawId !== undefined && rawId !== '') {
    const n = Number(rawId);
    documentId = Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : null;
  }

  // --- payload : always a JSON object, never null --------------------
  let payload = src.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = { raw: payload }; }
  }
  if (payload === null || payload === undefined) payload = {};
  if (Array.isArray(payload) || typeof payload !== 'object') payload = { value: payload };

  // Cap the size. A caller that accidentally forwards full contract text
  // would otherwise push megabytes into an append-only table.
  let payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 8000) {
    payloadJson = JSON.stringify({
      truncated: true,
      original_chars: payloadJson.length,
      preview: payloadJson.slice(0, 2000),
    });
  }

  // --- actor : schema default is 'system' ----------------------------
  const actor = String(src.actor ?? '').trim() || 'system';

  // --- execution_id : optional ---------------------------------------
  const executionId = String(src.execution_id ?? '').trim() || null;

  out.push({
    json: {
      // readable copies, for debugging the canvas
      workflow_name: workflowName,
      event_type: eventType,
      document_id: documentId,
      actor,
      execution_id: executionId,
      payload,

      // the only field the Postgres node reads
      params: [
        workflowName,
        executionId,
        documentId,
        eventType,
        payloadJson,
        actor,
      ],
    },
  });
}

return out;