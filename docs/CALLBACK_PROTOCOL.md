# Callback, checkpoint and gateway protocol

This is the exact contract Study AI must implement. The worker does not ship these endpoints.

## 1. Dispatch (Study AI -> GitHub)

`POST https://api.github.com/repos/OWNER/REPO/dispatches` with `event_type: "run-ai-task"` and `client_payload` (< 65,535 bytes):

```json
{
  "task_id": "task_123",
  "input": "User request (omit when resuming)",
  "model": "provider/model-id",
  "system": "optional system instructions from Study AI's planner",
  "callback_url": "https://studyai.example.com/api/longrun/callback",
  "execution": {
    "execution_id": "exec_9f2c",
    "hop_number": 3,
    "lease_version": 7,
    "checkpoint_version": 12,
    "deadline_ms": 18000000
  },
  "resume": {
    "checkpoint_ref": "task_123:12",
    "instructions": "Verification: message m1 WAS sent. Continue without re-sending."
  },
  "tool_broker": {
    "app_user_id": "user_abc",
    "grant_expires_at": "2026-10-01T06:00:00Z",
    "authorization_grant_encrypted": "v1.<iv>.<tag>.<ciphertext>"
  },
  "tools": [
    {
      "type": "function",
      "x-longrun": { "application_id": "conn_42", "capability": "mail.send", "mutating": true },
      "function": { "name": "send_message", "description": "…", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } }
    }
  ],
  "storage": { "max_bytes": 1073741824, "max_files": 2500 },
  "commands": { "enabled": false }
}
```

- `execution` present (with `execution_id`) = v2 protocol: lifecycle callbacks + heartbeats. Absent = legacy: one final callback with legacy `status` values (`completed`, `refused`, `failed`, or the new state name for handoff/pause/cancel).
- `resume.checkpoint` (inline object) is also accepted for small checkpoints.
- Legacy command policy under `execution.enabled/allowed_commands/container_image` is still accepted; prefer `commands`.

## 2. Lifecycle callbacks (worker -> Study AI)

`POST callback_url` — headers: `Content-Type: application/json`, `Idempotency-Key`, `X-Longrun-Execution-Id`, optional `Authorization: Bearer <CALLBACK_TOKEN>`.

Idempotency keys are deterministic:

| event_type | Idempotency-Key | When |
| --- | --- | --- |
| `execution_started` | `task_id:execution_id:execution_started` | v2 only, before work |
| `heartbeat` | `task_id:execution_id:heartbeat:<seq>` | v2 only, at step boundaries every `HEARTBEAT_INTERVAL_MS` |
| `execution_completed` / `execution_paused` / `execution_handoff` / `execution_failed` / `execution_cancelled` | `task_id:execution_id:<event_type>` | exactly one per execution |

Retries (429/5xx/network, up to `CALLBACK_MAX_ATTEMPTS`) resend the byte-identical body with the same key.

Final callback body:

```json
{
  "protocol": "longrun.callback.v2",
  "event_type": "execution_handoff",
  "idempotency_key": "task_123:exec_9f2c:execution_handoff",
  "task_id": "task_123",
  "execution_id": "exec_9f2c",
  "hop_number": 3,
  "provider": "github_actions",
  "provider_job_id": "1234567890-1",
  "lease_version": 7,
  "started_at": "…", "heartbeat_at": "…", "finished_at": "…",
  "status": "handoff_pending",
  "execution_state": "handoff_pending",
  "stop_reason": "unknown_mutation_outcome",
  "failure_category": "tool_failure",
  "checkpoint_version": 13,
  "checkpoint_ref": "task_123:13",
  "next_hop_at": "…",
  "model": "provider/model-id",
  "result": "final text (completed only)",
  "pause": { "message": "…" },
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 },
  "tool_calls": 41, "tool_calls_total": 388, "model_rounds": 30,
  "unknown_outcomes": [{ "action_key": "task_123:exec_9f2c:call_7", "tool_call_id": "call_7", "tool": "send_message", "application_id": "conn_42", "capability": "mail.send", "detail": "request_outcome_unknown", "observed_at": "…" }],
  "requires_verification": true,
  "completion_authority": "studyai",
  "error": { "message": "safe text", "upstream_http_status": 503 },
  "storage": { "persistence": "temporary", "retained": false }
}
```

`checkpoint` (inline object) is included instead of `checkpoint_ref` when no checkpoint store is configured.

**Receiver requirements**

- Authenticate `CALLBACK_TOKEN`; dedupe on `Idempotency-Key` (store key -> first response; replay it).
- Check `lease_version` against the task's current lease. Stale -> respond **409**; the worker stops immediately.
- Respond 2xx with optional `{"directive": "continue" | "cancel" | "checkpoint_and_handoff"}`.
- Treat `completed` as a claim to verify, not as task completion.
- On `handoff_pending`, dispatch the next hop at/after `next_hop_at` with a new `execution_id`, `hop_number + 1`, incremented `lease_version`, and `resume.checkpoint_ref`.
- If `requires_verification`, run D3/D4 verification of each `action_key` before dispatching; never blindly replay.
- Missing final callback + stale heartbeat => crash; resume from the latest checkpoint.

## 3. Checkpoint store (worker <-> Study AI) — `STUDYAI_CHECKPOINT_URL`

**Save** `POST STUDYAI_CHECKPOINT_URL` (headers as callbacks; key `task_id:execution_id:checkpoint:<version>`):

```json
{ "protocol": "longrun.checkpoint-store.v1", "idempotency_key": "…", "task_id": "…", "execution_id": "…", "hop_number": 3, "lease_version": 7, "checkpoint_version": 13, "checkpoint": { "schema": "longrun.checkpoint.v1", "…": "…" } }
```

Respond `200 {"checkpoint_ref": "opaque"}` (default ref `task_id:version`), `409` on stale lease. Must be idempotent.

**Load** `GET STUDYAI_CHECKPOINT_URL?task_id=…&checkpoint_ref=…` -> `200 {"checkpoint": {…}}`.

Checkpoint fields: `schema, task_id, execution_id, hop_number, lease_version, checkpoint_version, reason, model, messages, tool_calls_total, model_rounds_total, usage_total, unknown_outcomes, created_at`. No secrets, grants, or file contents. A checkpoint whose `hop_number` is >= the resuming hop is rejected as stale.

## 4. Tool gateway (worker -> Study AI broker) — `TOOL_BROKER_URL`

`POST` per tool call. Headers: `Authorization: Bearer <TOOL_BROKER_TOKEN>`, `X-Longrun-Task-Token: <decrypted grant>`, `Idempotency-Key: <action_key>`, `X-Longrun-Execution-Id`.

```json
{
  "protocol": "longrun.tool-broker.v1", "contract_version": 2,
  "task_id": "…", "execution_id": "…", "hop_number": 3, "lease_version": 7,
  "app_user_id": "user_abc", "tool_call_id": "call_7", "action_key": "task_123:exec_9f2c:call_7",
  "name": "send_message", "application_id": "conn_42", "capability": "mail.send", "mutating": true,
  "grant_expires_at": "…", "arguments": {}, "files": [{ "path": "out.pdf", "name": "out.pdf", "content_type": "application/pdf", "content_base64": "…" }]
}
```

The gateway must validate: shared token, grant (task, user, expiry, single-use policy), lease, that `name` + `application_id` + `capability` are within the grant, the argument schema; then execute and dedupe by `action_key`.

Responses:

| Response | Worker behaviour |
| --- | --- |
| `2xx {"ok":true,"result":…,"files":[…]}` | result to model (redacted) |
| `{"ok":false,"error":{"code":"needs_user"\|"authorization_required"\|"grant_expired"\|"reauthorization_required"\|"confirmation_required"}}` or bare 401/403 | `paused_for_user` |
| `{"ok":false,"error":{"code":"unknown_outcome"}}` | unknown outcome, handoff with verification |
| `409` | lease lost, `cancelled` |
| `429`, or 5xx with `error.executed: false` | known not executed; retried up to 3 times |
| other 5xx / network error / timeout / unreadable 2xx on a **mutating** tool | `unknown_mutation_outcome`, never retried |
| same on a read-only tool | retried up to 3 times, then tool error to model |
| other 4xx (`capability_mismatch`, `tool_not_allowed`, `invalid_arguments`, …) | tool error returned to the model |

## 5. Grant encryption (Study AI side)

Key = HMAC-SHA256(key=`TOOL_BROKER_TOKEN`, message=`longrun-tool-grant-v1`); AES-256-GCM; random 12-byte IV; AAD = `${task_id}:${app_user_id}`; format `v1.<iv>.<tag>.<ciphertext>` (base64url, unpadded). Reference implementation: `.github/scripts/worker/grant.mjs` (`encryptGrant`).
