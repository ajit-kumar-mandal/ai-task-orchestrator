# Production Execution Worker Upgrade

Turn the existing runner into a stateless, resumable execution worker for Study AI. Study AI stays the source of truth; the worker runs one "hop", checkpoints, and hands off.

## Inventory of existing components

Retained (unchanged behavior, backward compatible):
- `.github/workflows/ai-task.yml` — `repository_dispatch` / `run-ai-task`, 360 min timeout. Only adds new optional env vars and `provider_job_id` (`github.run_id`/`run_attempt`).
- Encrypted broker grant (AES-256-GCM, HMAC-derived key, AAD `task_id:app_user_id`), allowed-host checks, redaction.
- Scratch tools (`scratch_list/read/write/mkdir/stat`), symlink + traversal protection, size/file caps.
- `prepare-images.mjs` and pinned-container `run_command` (still opt-in per task).
- Streaming chat-completions call, 429/5xx bounded retry, refusal = terminal.
- Old payloads (no `execution` block) still work: treated as hop 1 with a generated-deterministic execution id.

Changed:
- `runner.mjs` split into modules under `.github/scripts/worker/` (config, lifecycle, events/redaction, ai, broker, scratch, commands, checkpoint, callback). `runner.mjs` stays as the entrypoint.
- `MAX_TOOL_ROUNDS=12` / `MAX_TOOL_CALLS=60` removed as task limits. Replaced by `EMERGENCY_MAX_TOOL_CALLS_PER_HOP` / `EMERGENCY_MAX_MODEL_ROUNDS_PER_HOP` (high defaults, configurable); hitting one causes checkpoint + handoff with `stop_reason: emergency_guard`, never "completed".
- Callback: single final POST becomes lifecycle callbacks with deterministic `Idempotency-Key = task_id:execution_id:event_type`, bounded retry on 429/5xx/network for callbacks only (callbacks are idempotent by design). Legacy top-level fields (`task_id`, `status`, `result`, `usage`) kept.
- Broker request: adds `execution_id`, `hop_number`, `lease_version`, `application_id`, `capability`, `mutation` flag, and an `action_key` (`task_id:execution_id:tool_call_id`). Tool definitions can carry `x-longrun: {application_id, capability, mutating}` metadata; worker stays app-agnostic.

Removed:
- Nothing user-facing. Hardcoded email/Drive examples move from code-level docs into README examples only (the worker never had app-specific branches; we keep it that way).

## Lifecycle

States: `queued, starting, running, checkpointing, handoff_pending, completed, paused_for_user, failed_terminal, cancelled`.

```text
starting -> running -> (deadline - reserve | emergency guard | transient provider failure)
                        -> checkpointing -> handoff_pending -> exit 0
running -> model final answer          -> completed (execution-level; Study AI decides task completion)
running -> broker says needs_user      -> paused_for_user
running -> lease rejected / cancelled  -> cancelled (no further work)
running -> terminal error / refusal    -> failed_terminal
```

- Deadline: `EXECUTION_DEADLINE_MS` (default ~5h40m from job start), `CHECKPOINT_RESERVE_MS` (default 10 min). No new model/tool call starts once `now >= deadline - reserve`; in-flight op drains.
- Per-call safety timeouts `MODEL_CALL_TIMEOUT_MS`, `TOOL_CALL_TIMEOUT_MS`, `CALLBACK_TIMEOUT_MS` (generous defaults). A model timeout -> checkpoint + handoff (`provider_timeout`), not completion.
- Heartbeat: periodic `heartbeat` callback with `lease_version`; a `409` lease response fences the worker (stop immediately, `lease_mismatch`).

## Checkpoint / handoff

- Checkpoint = `{schema, task_id, execution_id, hop_number, checkpoint_version, messages, tool_calls_total, pending_unknown_outcomes, model, created_at}` — no secrets, grants, tokens or scratch file bytes.
- Persisted by POSTing to Study AI's checkpoint endpoint (`STUDYAI_CHECKPOINT_URL`, allowlisted host) with idempotency key `task_id:execution_id:checkpoint:<version>`; retried on transient failure; failure -> `checkpoint_failed` classification.
- Next hop: worker reports `handoff_pending` with `next_hop_at`; Study AI (not the worker) dispatches hop N+1 with a fresh `execution_id`, incremented `lease_version`, and `resume.checkpoint_ref`. Worker fetches checkpoint by ref (or accepts inline when small). This keeps Study AI authoritative and avoids the worker holding a GitHub token.

## Failure classification

`transient, retryable, authorization_required, tool_failure, model_provider_failure, checkpoint_failure, lease_fencing_failure, terminal`.
- Mutating tool call with lost response / network error / timeout -> `unknown_outcome`: never retried; recorded in checkpoint and callback with `action_key`; hop pauses for Study AI verification (`stop_reason: unknown_mutation_outcome`).
- Read-only tool transient errors may be retried (bounded).

## Observability

JSON-line events to stdout: `execution_started, model_started, model_finished, tool_started, tool_finished, checkpoint_started, checkpoint_saved, handoff_requested, callback_sent, execution_completed, execution_paused, execution_failed` with ids, timestamp, duration, safe metadata. Arguments are never logged; a central redactor scrubs registered secrets plus token-like patterns (Bearer, `sk-`, JWTs, `v1.` grants, cookies).

## Security additions

- Capability isolation: broker call carries `application_id` + `capability` from the tool definition; worker refuses a tool call whose name is not in that hop's published tool list, and never reuses one tool's context for another.
- Sensitive-file guard on broker attachments (`.env`, keys, `*.pem`, `id_rsa`, credentials files) rejected.
- Command policy: no shell interpreters, reject args containing shell metacharacters only when executable is in a denylist; path args resolved inside `/workspace`.

## Tests (`node --test`, no deps) under `.github/scripts/tests/`

Local mock HTTPS servers for AI, broker, callback, checkpoint. Covers every case in section 17: start/resume/checkpoint/handoff, duplicate callback & execution, stale execution, lease mismatch, cancellation, terminal failure; >12 rounds and >60 calls continue; emergency guard; deadline checkpoint; dynamic tool, wrong capability, unauthorized/expired grant, malformed args, unknown tool; secret leakage in logs and callbacks, host allowlist, cross-task/cross-user grant reuse, traversal, injection; lost/duplicate callback, crash resume, cancellation signal (SIGTERM -> checkpoint), provider timeout, unknown outcome, checkpoint retry. Docker-dependent cases test policy validation without running Docker.

Add `package.json` script `test:worker`.

## Docs

- `docs/ARCHITECTURE.md`, `docs/CALLBACK_PROTOCOL.md`, `docs/EXECUTION_LIFECYCLE.md`.
- README updated: new env vars, payload `execution` block, integration contract.
- AGENTS.md: replace architecture rules (worker is stateless hop executor; Study AI authoritative).

## Study AI integration contract (defined, not implemented here)

- Dispatch payload adds `execution: {execution_id, hop_number, lease_version, deadline_ms?}` and optional `resume: {checkpoint_ref}`.
- `POST callback_url` — lifecycle events (must dedupe on `Idempotency-Key`, return 2xx; `409` = lease stale -> worker stops).
- `POST/GET STUDYAI_CHECKPOINT_URL` — store/fetch checkpoint by `task_id`, `execution_id`, `checkpoint_version`.
- Broker contract v2 (backward compatible with v1) with `needs_user` / `unknown_outcome` result types.

## Not changed

The landing page UI stays as is (only copy for new env vars if needed). No Study AI UI changes.
