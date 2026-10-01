# Architecture

This repository is an **execution worker**. It is not an AI brain and it does not own task state.

```text
Study AI Postgres  (task state, plan, subtask ledger, evidence, verification, action identity)
      |
Study AI execution provider  (leases, dispatch, checkpoint store, callback receiver)
      |  repository_dispatch: run-ai-task
GitHub Actions worker  (this repo: one hop of execution)
      |  longrun.tool-broker.v1 (contract_version 2)
Tool gateway / broker in Study AI  (capability discovery, grants, Composio/MCP, app boundaries)
      |
Applications / MCP servers / external services
```

## Responsibilities

| Study AI (authoritative) | Worker (this repo) |
| --- | --- |
| Logical task ownership, state, planning, replanning | Run one long-lived execution ("hop") |
| Subtask ledger, evidence, verification (D3/D4) | Call the model and the generic tool gateway |
| Action identity, idempotency, completion authority | Keep the in-memory conversation for this hop |
| Cancellation semantics, user-facing status | Retry transient provider errors within bounds |
| Leases, dispatching the next hop | Report lifecycle callbacks and persist checkpoints |
| Checkpoint storage (Postgres/Redis) | Stop cleanly before GitHub's execution boundary |

The worker never decides that a logical task is complete. `completed` means "this execution observed a final model answer"; every callback carries `completion_authority: "studyai"`.

## Code layout

```text
.github/workflows/ai-task.yml     repository_dispatch entry, concurrency per task, 360-min job
.github/scripts/runner.mjs        process entry; wires SIGINT/SIGTERM to cancellation
.github/scripts/prepare-images.mjs  pulls SHA-256 pinned images (optional commands)
.github/scripts/worker/
  worker.mjs      execution state machine (runExecution)
  config.mjs      hard caps + execution-safety settings + EMERGENCY_* guards
  payload.mjs     dispatch parsing, execution identity, URL allowlists
  ai.mjs          streaming chat-completions client, bounded retry, timeouts
  tools.mjs       application-agnostic tool registry + argument validation
  broker.mjs      invokeTool(): generic gateway call, unknown-outcome classification
  grant.mjs       AES-256-GCM task/user-bound grant encryption/decryption
  checkpoint.mjs  checkpoint build/persist/load/validate
  callback.mjs    idempotent lifecycle callbacks
  http.mjs        retrying JSON client for idempotent Study AI endpoints
  scratch.mjs     temporary workspace (limits, traversal/symlink/sensitive-file guards)
  commands.mjs    OPTIONAL pinned-container command execution
  redact.mjs      secret redaction for logs, callbacks, checkpoints, tool results
  events.mjs      structured JSON-line lifecycle events
.github/scripts/tests/            node:test suite (no dependencies)
src/                              unrelated landing page (TanStack Start); not imported by the worker
```

The worker is dependency-free Node 22 and shares no code with `src/`.

## Logical task vs execution

A logical task spans any number of executions. Each execution is identified by `task_id + execution_id + hop_number`, holds a Study AI lease (`lease_version`), and ends in exactly one terminal execution state (see `EXECUTION_LIFECYCLE.md`). The only per-hop guards are execution-safety settings and clearly named `EMERGENCY_*` runaway guards; reaching either causes checkpoint + handoff.

## Tool gateway

Tools are published per task by Study AI in the dispatch payload. Each tool may carry `x-longrun` metadata (`application_id`, `capability`, `mutating`) that the worker forwards on every gateway request and strips before sending tools to the model. The model cannot change a request's application or capability. The worker has no application-specific code.

## Security boundaries

- Long-lived credentials (AI key, broker shared secret, callback token) exist only in GitHub Actions secrets.
- The app-user grant arrives AES-256-GCM encrypted with AAD `task_id:app_user_id`; it is decrypted in memory and sent only to the allowlisted gateway.
- All outbound URLs (callback, checkpoint store, gateway) are HTTPS and host-allowlisted; redirects are refused.
- All logs, callbacks, checkpoints, and model-visible tool results pass through the redactor.
- Scratch storage is temporary and deleted in a `finally` block.
- Optional commands run in pinned, read-only, network-less containers with no worker secrets.
