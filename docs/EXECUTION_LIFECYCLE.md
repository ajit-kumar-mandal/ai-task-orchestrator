# Execution lifecycle

## States

| State | Meaning | Final? |
| --- | --- | --- |
| `queued` | Study AI dispatched; GitHub has not started the job (Study AI-side state) | no |
| `starting` | Worker is validating payload, grant and checkpoint | no |
| `running` | Model/tool iterations in progress | no |
| `checkpointing` | Saving continuation state | no |
| `handoff_pending` | Execution ended at a boundary; checkpoint saved; Study AI should dispatch the next hop | yes (for this execution) |
| `completed` | Model returned a final answer. Study AI verifies and decides task completion | yes |
| `paused_for_user` | Authorization or confirmation is needed from the user | yes |
| `failed_terminal` | Non-recoverable failure for this execution | yes |
| `cancelled` | Cancelled by Study AI directive or lease fencing | yes |

**Execution finished is not logical task finished.** Reaching the GitHub job deadline always produces `handoff_pending`, never `completed`.

```text
queued -> starting -> running --final answer--------------------> completed
                         |---needs_user / grant expired---------> checkpointing -> paused_for_user
                         |---deadline / SIGTERM / emergency guard
                         |   provider timeout / provider 5xx
                         |   unknown mutation outcome
                         |   controller "checkpoint_and_handoff"-> checkpointing -> handoff_pending
                         |---409 lease / "cancel" directive-----> cancelled
                         |---terminal provider/config error-----> failed_terminal
```

## Execution identity

Every callback and checkpoint includes: `task_id`, `execution_id`, `hop_number`, `provider` (`github_actions`), `provider_job_id` (`GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT`), `lease_version`, `started_at`, `heartbeat_at`, `finished_at`, `stop_reason`, `checkpoint_version`, `next_hop_at`.

Legacy payloads without an `execution` block are treated as hop 1 with `execution_id = gha-<provider_job_id>` and `lease_version = 0`.

## Stop reasons

| stop_reason | State | Notes |
| --- | --- | --- |
| `model_final_answer` | completed | Study AI verifies |
| `execution_deadline` | handoff_pending | `now >= deadline - CHECKPOINT_RESERVE_MS` |
| `provider_job_cancelled` | handoff_pending | SIGINT/SIGTERM from GitHub |
| `provider_timeout` | handoff_pending | `MODEL_CALL_TIMEOUT_MS` reached |
| `provider_unavailable` | handoff_pending | network error or 429/5xx after 3 attempts; `next_hop_at` honours Retry-After |
| `unknown_mutation_outcome` | handoff_pending | `requires_verification: true`, see `unknown_outcomes` |
| `emergency_guard_tool_calls` / `emergency_guard_model_rounds` / `emergency_guard_context_size` | handoff_pending | runaway guard, not a task limit |
| `controller_requested_handoff` | handoff_pending | Study AI directive on `execution_started` (immediate, no new checkpoint) or on a heartbeat (with checkpoint) |
| `checkpoint_failed` | handoff_pending | `intended_stop_reason` shows why it was stopping; resume from the last good checkpoint |
| `authorization_required` / `user_confirmation_required` / `authorization_expired` | paused_for_user | |
| `cancelled_by_controller` / `lease_lost` | cancelled | |
| `model_refusal`, `model_provider_rejected`, `grant_invalid`, `invalid_dispatch`, `callback_not_allowed`, `terminal_failure` | failed_terminal | |

## Deadline and draining

- `EXECUTION_DEADLINE_MS` (default 340 min) measured from worker start; a payload `execution.deadline_ms` can only lower it.
- `CHECKPOINT_RESERVE_MS` (default 10 min) is held back for checkpoint + callback.
- No model call or tool call starts after `deadline - reserve`.
- A model call's timeout is `min(MODEL_CALL_TIMEOUT_MS, time until reserve)`; model calls are non-mutating so aborting them is safe.
- A tool call already running is allowed to drain; its timeout is `min(TOOL_CALL_TIMEOUT_MS, time until deadline - reserve/2)`.
- On SIGTERM the in-flight model call is aborted, any in-flight tool call drains, then the worker checkpoints and hands off.

## Checkpoint protocol

1. Stop starting new work. 2. Let the current tool call drain. 3. Fill any un-run tool calls from the same model turn with `not_executed` results so the conversation stays valid. 4. Build the checkpoint (schema `longrun.checkpoint.v1`: messages, totals, usage, unknown outcomes; never secrets or file bytes). 5. Persist to `STUDYAI_CHECKPOINT_URL` (idempotency key `task_id:execution_id:checkpoint:<version>`, retried on 429/5xx/network) or, without a store, include it inline in the final callback. 6. Emit `handoff_requested` and send the `execution_handoff` callback. 7. Exit 0.

Periodic checkpoints are also saved after a complete tool round when `CHECKPOINT_INTERVAL_MS` has elapsed (only with a checkpoint store), so a crashed job can be resumed.

## Crash recovery (Study AI side)

If heartbeats stop and no final callback arrives, Study AI should: increment `lease_version`, and dispatch a new hop with a new `execution_id`, `hop_number + 1`, and `resume.checkpoint_ref` of the latest stored checkpoint. Any 409 then fences a zombie worker. Unknown outcomes in that checkpoint must be verified before resuming; pass the verification result as `resume.instructions`. A crash during a tool call leaves no worker-side record of that call, because the latest checkpoint predates it. The gateway has already received its `action_key` (`task_id:execution_id:tool_call_id`), so Study AI must also verify every `action_key` the gateway saw for the crashed `execution_id` that is not answered in the checkpoint.

## Execution-safety settings (repository variables)

| Variable | Default |
| --- | --- |
| `EXECUTION_DEADLINE_MS` | 20400000 (340 min) |
| `CHECKPOINT_RESERVE_MS` | 600000 |
| `MODEL_CALL_TIMEOUT_MS` | 1800000 |
| `TOOL_CALL_TIMEOUT_MS` | 900000 |
| `CALLBACK_TIMEOUT_MS` | 30000 |
| `CALLBACK_MAX_ATTEMPTS` | 5 |
| `HEARTBEAT_INTERVAL_MS` | 60000 |
| `CHECKPOINT_INTERVAL_MS` | 300000 |
| `EMERGENCY_MAX_MODEL_ROUNDS_PER_HOP` | 2000 |
| `EMERGENCY_MAX_TOOL_CALLS_PER_HOP` | 10000 |
| `EMERGENCY_MAX_CONTEXT_BYTES` | 16777216 |

The workflow passes the first seven settings as repository variables. `CALLBACK_MAX_ATTEMPTS` and the `EMERGENCY_*` guards use their defaults unless you add them to the workflow `env`.

None of these limits a logical task.
