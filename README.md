# Longrun — GitHub Actions execution worker for Study AI

Longrun is a stateless, resumable **execution worker**. Study AI dispatches one execution ("hop") of a task to GitHub Actions. The worker runs model and tool-gateway iterations until it stops, then reports what happened. Study AI owns task state, planning, evidence, verification, leases, checkpoint storage, next-hop dispatch and completion.

| Lifetime | Controlled by |
| --- | --- |
| Logical task | Study AI. It can span any number of hops. |
| One execution / hop | GitHub's job limit (360 min) and `EXECUTION_DEADLINE_MS` (default 340 min) minus `CHECKPOINT_RESERVE_MS` (default 10 min). |
| Runaway protection | `EMERGENCY_*` guards only. Reaching one means **checkpoint + handoff, never completion**. |

There are no normal round or tool-call limits.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Lifecycle, stop reasons, deadline/cancellation, settings: [docs/EXECUTION_LIFECYCLE.md](docs/EXECUTION_LIFECYCLE.md)
- Study AI integration contract (dispatch, callbacks, checkpoint store, tool gateway, grant format): [docs/CALLBACK_PROTOCOL.md](docs/CALLBACK_PROTOCOL.md)
- Tests: `npm run test:worker`

## Setup

1. Push this repository to GitHub. The workflow `.github/workflows/ai-task.yml` listens for `repository_dispatch` type `run-ai-task`. It runs at most one job per `task_id` at a time.
2. Add these under **Settings → Secrets and variables → Actions**:

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | Secret | Chat-completions-compatible provider key |
| `AI_API_BASE_URL` | Variable | HTTPS base URL, normally ending in `/v1` |
| `AI_DEFAULT_MODEL` | Variable | Model used when the dispatch omits `model` |
| `CALLBACK_TOKEN` | Secret (optional) | Bearer token for callbacks and the checkpoint store |
| `CALLBACK_ALLOWED_HOSTS` | Variable | Exact allowed callback hostnames |
| `STUDYAI_CHECKPOINT_URL` | Variable (recommended) | Study AI checkpoint store. Without it, checkpoints go inline in the final callback. |
| `CHECKPOINT_ALLOWED_HOSTS` | Variable (optional) | Allowed checkpoint hosts. Defaults to `CALLBACK_ALLOWED_HOSTS`. |
| `TOOL_BROKER_URL` | Variable | Study AI tool gateway endpoint |
| `TOOL_BROKER_TOKEN` | Secret | Gateway bearer token and the key-derivation secret for grants |
| `TOOL_BROKER_ALLOWED_HOSTS` | Variable | Exact allowed gateway hostnames |
| `TASK_CONTAINER_IMAGES` | Variable (optional) | SHA-256-pinned images for optional commands |
| `TASK_STORAGE_MAX_BYTES` / `TASK_STORAGE_MAX_FILES` | Variable (optional) | Scratch defaults: 512 MiB / 1000 files. Caps: 5 GiB / 10,000. |
| `EXECUTION_DEADLINE_MS`, `CHECKPOINT_RESERVE_MS`, `MODEL_CALL_TIMEOUT_MS`, `TOOL_CALL_TIMEOUT_MS`, `CALLBACK_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_MS`, `CHECKPOINT_INTERVAL_MS` | Variable (optional) | Execution-safety settings. See the lifecycle doc. |

The `EMERGENCY_MAX_*` guards and `CALLBACK_MAX_ATTEMPTS` also read environment variables. They use their defaults unless you add them to the workflow.

All callback, checkpoint and gateway URLs must be HTTPS, host-allowlisted and free of credentials. Redirects are refused. Never put credentials in the dispatch payload except the encrypted, task- and user-bound grant.

## Behaviour summary

- **Model calls:** streamed. 429/5xx get at most 3 attempts. If they keep failing, or there is a network error or model timeout, the worker checkpoints and reports `handoff_pending`. Refusals and 4xx errors are terminal.
- **Tools:** Study AI publishes them per task. Optional `x-longrun` metadata (`application_id`, `capability`, `mutating`) is forwarded to the gateway with every call and is stripped before tools reach the model. Model arguments cannot change it. A tool without `mutating` metadata is treated as mutating.
- **Tool errors:** unknown tools, invalid arguments and gateway 4xx errors are returned to the model as tool errors. They do not end the execution.
- **Pauses:** authorization or confirmation codes put the execution in `paused_for_user`.
- **Unknown outcomes:** if a potentially mutating call has an unknown outcome (network loss, timeout, 5xx), it is never retried. The worker hands off with `requires_verification` and the call's `action_key`.
- **Deadline and cancellation:** at `deadline − reserve`, or on SIGINT/SIGTERM, no new model or tool work starts. A running tool call finishes, any remaining calls from that model turn are marked `not_executed`, then the worker checkpoints, reports `handoff_pending` and exits 0.
- **Final answer:** a final model answer reports `completed` with `completion_authority: "studyai"`. Study AI verifies it.
- **Scratch storage:** a temporary workspace per execution, deleted in `finally`. It is not task state. Traversal and symlinks are blocked, limits are checked before writing, and credential-like files (`.env`, `*.pem`, `*.key`, `id_rsa`, …) cannot be attached.
- **Optional commands:** disabled unless `commands.enabled` is set. They run in SHA-256-pinned, allowlisted images, without a shell, with no network by default, read-only, with no secrets and only scratch mounted. Shells and process launchers are always refused.
- **Legacy payloads:** a payload without `execution.execution_id` is still accepted. It is treated as hop 1, sends one final callback, and uses legacy status values: `completed`, `refused`, `failed`, or the new state name for handoff, pause or cancel.

## Security checklist

- Dispatch only from Study AI server code with a narrowly scoped GitHub token. The worker never sees that token.
- Validate every gateway request: shared token, grant (task, user, expiry), lease, `application_id`, `capability`, tool name and arguments. Dedupe by `action_key`.
- Dedupe callbacks by `Idempotency-Key` and fence stale leases with HTTP 409.
- Treat email, documents and tool output as untrusted input.
