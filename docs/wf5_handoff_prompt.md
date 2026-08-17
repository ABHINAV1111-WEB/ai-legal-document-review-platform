# WF5 Handoff — Assignment 11

Continuing Assignment 11. WF1, WF2, WF3 and WF4 are COMPLETE, tested, published, and pushed to `dev`.

## WF4 — just finished (Lawyer Review & Approval)

14 nodes, all three decision branches tested end-to-end:

```
When Executed by Another Workflow (input: clause_id, Number)
  → Fetch Clause            (Postgres; clause + document JOIN, computes
                             needs_review and pending_requests in SQL)
  → Needs Review?           (IF; true → review, false → Skip - Not Eligible NoOp)
  → Create Review Request   (Postgres INSERT, RETURNING token)
  → Build Review Email      (Code; composes body, reads $execution.resumeFormUrl)
  → Queue Review Email      (Postgres INSERT into email_outbox)
  → Wait for Decision       (Wait, Resume On Form Submitted)
  → Normalise Decision      (Code; validates + reattaches context)
  → Route Decision          (Switch: approve / correct / reject, fallback None)
      ├─ approve → Approve Clause  (review_status='approved')
      ├─ correct → Correct Clause  (review_status='corrected', overwrites clause_text)
      │            → Apend Gold Label  (gold_labels, source='lawyer_review')
      └─ reject  → Reject Clause   (review_status='rejected')
  → Close Request           (all three converge; review_requests → 'decided')
```

Note: the gold-label node is spelled `Apend Gold Label` (one `p`) in the exported JSON. Cosmetic only; nothing references it by name.

**Key design decisions in WF4:**
- **Form-based resume, not three decision links.** A click-only link has nowhere to type corrected text, and migration 004 has a CHECK requiring `corrected_text` when `decision='correct'`. The form gives a dropdown + two textareas in one page. Form fields come back with SPACES in their names: `Decision`, `Corrected clause text`, `Review note` — bracket syntax required.
- **Routing on evidence, not confidence.** `attribution='not_found' OR (is_absent AND risk_score >= 0.60)`. Confidence clusters 0.84–0.92 so τ=0.70 routes nothing.
- **Idempotency guard in `Fetch Clause`**: a subquery counts `review_requests` rows with `status='pending'` for that clause. `Needs Review?` requires `pending_requests = 0` (String comparison — BIGINT returns as string). Prevents two live tokens for one decision.
- **`Close Request` has `AND status='pending'`** so a replayed form submit updates zero rows instead of overwriting a decision.
- **Reading env vars:** `$env.REVIEW_EMAIL` required setting `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` in docker-compose. Documented as a deliberate single-tenant trade-off.
- **`ON CONFLICT DO NOTHING`** on the gold-label insert; `answer_start = -1` marks "offset unknown"; `split` hardcoded to `'dev'` so holdout cannot be contaminated structurally.

## Migration 005 and 006 — both applied

- **005** created **`email_outbox`** (id, purpose, review_request_id FK, document_id FK, to_address, subject, body_text, status, provider, error, created_at, sent_at). Deliberately generic so WF5 reuses it. CHECKs on status ('queued','sent','failed'), non-blank purpose/to_address, and `status='sent'` requires `sent_at`. Partial index on queued rows.
  - **No Gmail credential is configured.** WF4 writes an outbox row instead of sending. Gmail later is a one-node change. WF5 must do the same.
- **006** added `obligations.date_source` (TEXT NOT NULL DEFAULT 'review_schedule') and seeded 24 `renewal_review` obligations.

## WF5 — the scope decision, READ THIS FIRST

**WF3 is NOT being modified.** It works, it was hard-won, and the time cost isn't worth it right now.

Consequence: **there are no contractual dates anywhere in the database.** WF3's JSON schema returns `clause_type`, `seq_no`, `clause_text`, `confidence`, `reasoning` — no `renewal_date`, no `notice_period_days`, no `term_end_date`. Renewal Term `extracted_fields` contain only reasoning text and attribution flags.

So the obligations seeded by migration 006 are **internal review deadlines**, not contract renewal dates. `obligation_type='renewal_review'`, `date_source='review_schedule'`. Each means "a human should re-examine this Renewal Term clause by date X".

**The honest claim for the README:** WF5 monitors obligations on a daily cron with real notification windows and deduplication. Automatic extraction of contractual dates is documented as future work (one extra field group in the WF3 schema, ~1.5 hr).

**Do not let WF5 imply it tracks real contract renewal deadlines.** That distinction is the difference between a defensible design and something that collapses under one question in the demo.

Seeded data, staggered so every branch has rows:

```
days_away | obligations
        7 | 8
       14 | 5
       30 | 7
       45 | 4     <- outside all windows; proves the filter excludes
```

## WF5 planned shape

```
Schedule Trigger (daily cron)
  → Find Due Obligations   (Postgres: 30/14/7-day windows,
                            notified_at IS NULL, status='open')
  → Loop Over Items        (Batch Size 1)
      → Build Reminder     (Code: compose subject/body + params array)
      → Queue Reminder     (Postgres INSERT into email_outbox,
                            purpose='renewal_reminder')
      → Mark Notified      (Postgres: notified_at=NOW(), status='notified')
```

Windows live in a config node or JSON, never hardcoded in a Code node (project convention).

## Database state

`sql/001_schema.sql` … `006_wf5_obligations_seed.sql` all applied.

Tables: `documents`, `document_versions`, `clauses`, `obligations`, `audit_log`, `gold_labels`, `review_requests`, `email_outbox`.

17 documents ingested (ids 4–21, all `dev` split; holdout confirmed uncontaminated). 700 segments. ~145 clause rows. 260 `gold_labels` rows with `source='cuad'`, plus a small number with `source='lawyer_review'` from WF4 testing.

**`evaluate.py` MUST filter to `source='cuad'`** for the Phase 4 headline number, or the evaluation becomes circular.

RLS is OFF on all tables — n8n is the sole DB client, single-tenant. Deliberate, documented.

## Environment

n8n 2.32.6, docker-compose, `localhost:5678`. Credentials: `Supabase Postgres - Assign11` (Ignore SSL Issues ON), `OpenAI - Assign11`. Supabase session pooler `aws-0-ap-south-1.pooler.supabase.com:5432`. `/data/prepared` read-only; writable mount `/files`. Project root `E:\Assign11`, Windows PowerShell 5.1, Cursor, all SQL pasted into the browser Supabase SQL Editor. Repo `ABHINAV1111-WEB/ai-legal-document-review-platform`, branch `dev`.

docker-compose env vars now include: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, `N8N_RESTRICT_FILE_ACCESS_TO=/data/prepared;/files`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `REVIEW_EMAIL`, `WEBHOOK_URL`, `GENERIC_TIMEZONE=Asia/Kolkata`.

## BUGS HIT SO FAR — please keep these in mind

1. Postgres nodes REPLACE their input. Reattach via `$('NodeName').first().json`.
2. Query Parameters splits a plain string on commas. Pass a JS array — `{{ [a, b] }}`. **Exception:** when a Code node already built the array, pass it bare — `{{ $json.params }}`.
3. BIGINT returns as a STRING from Postgres. Cast with `Number()`; IF nodes need String comparisons.
4. "Always Output Data" must be ON for any query that can return zero rows, or the branch dies silently.
5. PowerShell 5.1 cannot escape CUAD filenames. Post via `python scripts/post_contract.py --index N`, never curl.
6. Whitespace OUTSIDE `{{ }}` in an expression field is literal text. Cost 90 minutes once.
7. A workflow must be PUBLISHED before anything external runs it — a form submit, a parent workflow call, a webhook. Ctrl+S saves the draft only. Editing a node then re-running silently uses the OLD published version.
8. The Executions canvas is a snapshot at run time; nodes added later do not appear in earlier executions.
9. Execute Sub-workflow's "Run once for each item" mode is DEPRECATED. Use Loop Over Items (Batch Size 1) with "Run once with all items".
10. Pinned trigger data does not stick unless **Save** is clicked inside the OUTPUT panel. Unpin before any real run.
11. **Each execution has its own form/resume URL.** Delete the execution and that link 404s forever with `Cannot read properties of undefined (reading 'resumeToken')`. During testing, click the URL from the Wait node's OUTPUT panel, never from an old browser tab or an old email row.
12. **The idempotency guard blocks repeat testing.** After each test run the clause has a `pending` review request, so the next run routes to `false`. Reset with `UPDATE review_requests SET status='cancelled', decided_at=NOW() WHERE clause_id=<id> AND status='pending';`
13. n8n's Postgres node can choke on long `--` comment headers before a statement. Put bare SQL in the node; keep the commented copy in `workflows/sql/`.
14. Exported workflow JSON arrives with SPACES in the filename (`WF4 - Lawyer Review.json`). Rename to snake_case or `git add` silently matches nothing.
15. `$env` in expressions returns `[ERROR: not accessible via UI]` in the preview panel. That is the renderer, not a failure — it resolves at run time.

## Repo layout for workflow artefacts

```
sql/                     001–006 migrations
workflows/               exported workflow JSON (snake_case)
workflows/code/          Code node JS, one file per node
workflows/sql/           node queries, commented copies
scripts/                 post_contract.py, load_gold_labels.py,
                         prepare_dataset.py, inspect_eval_pairs.py
```

Note: `workflows/prompts/` does NOT exist. The WF3 extraction prompt lives only inside the n8n node and is not version-controlled. Worth fixing when WF3 is next touched.

## STILL TO DO — graded unless marked

- **WF5** Renewal Monitor (cron) — starting now, ~2 hr
- **WF6** Audit Log & Dashboard — ~2 hr
- **WF7** Global Error Handler — ~1.5 hr
- Contract summarisation — ~30 min
- Version history workflow (`document_versions` exists, nothing writes to it) — ~1 hr
- OCR-not-available detection branch in WF2 + README paragraph — ~20 min
- README — not started, ~2 hr
- Architecture + interaction diagrams — ~1.5 hr
- Workflow documentation — ~2 hr
- Demo video 5–10 min — ~2 hr
- Slides 10–12 — ~2 hr
- `evaluate.py` precision/recall — NOT required by the brief; the portfolio differentiator. `scripts/inspect_eval_pairs.py` exists as the diagnostic but has not been run. ~3 hr.

Also outstanding: WF3 lacks retry-with-backoff on the OpenAI node and does not update `documents.status` to `'analyzed'`.

## How to help

One step at a time, exact node names and field values, a "done when" test for each. Plain language, no lowered technical quality. Exact PowerShell (never Linux syntax). State full file paths and whether a file is new or edited before every code block. Downloadable files rather than inline code blocks where practical. Do not advise unnecessary verification commands — if the output is already confirmed correct, move to the next step. Defend the locked scope. Never help inspect the 10 holdout contracts before Phase 4. Remind me to export workflow JSON to `workflows/` after meaningful changes.

**Do not modify WF1–WF4 or any existing node.** They work and are committed.

Start with WF5 step 1: the Schedule Trigger and the due-obligations query.
