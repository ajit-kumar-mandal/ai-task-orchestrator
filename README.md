# Longrun — long-running AI and tool tasks

Longrun dispatches streamed OpenAI-compatible AI work from your app into a GitHub Actions job (up to six hours). It supports bounded multi-step function/tool calling through a tool broker in your own app, task-scoped temporary files, and an HTTPS callback when work finishes.

The broker design keeps Composio and end-user OAuth in your app: GitHub Actions does not store a shared Composio API key or impersonate a user. Each task carries the authenticated user's stable app ID plus a short-lived, task-scoped credential that your app validates before executing any action.

## 1. Add this project to GitHub

Push the repository to GitHub. The workflow listens for `repository_dispatch` event type `run-ai-task`.

## 2. Configure Actions secrets and variables

Open **Settings → Secrets and variables → Actions** in the GitHub repository.

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | Secret | API key for the OpenAI-compatible model provider |
| `AI_API_BASE_URL` | Variable | HTTPS API base URL, normally ending in `/v1` |
| `AI_DEFAULT_MODEL` | Variable | Default model for tasks without an override |
| `CALLBACK_TOKEN` | Secret, optional | Bearer token for your task-result callback |
| `CALLBACK_ALLOWED_HOSTS` | Variable | Comma-separated exact HTTPS callback hostnames |
| `TOOL_BROKER_URL` | Variable | Your app's HTTPS endpoint for executing authorized tools |
| `TOOL_BROKER_TOKEN` | Secret, recommended | Optional app-wide broker credential in addition to per-task credentials |
| `TOOL_BROKER_ALLOWED_HOSTS` | Variable | Exact HTTPS hostnames permitted for the app broker |
| `TASK_STORAGE_MAX_BYTES` | Variable, optional | Default task scratch limit in bytes; default `536870912` (512 MiB), cap `5368709120` (5 GiB) |
| `TASK_STORAGE_MAX_FILES` | Variable, optional | Default scratch file-count limit; default `1000`, cap `10000` |

The AI API key and callback token must never be sent in dispatch data. Provider `429` and transient `5xx` responses get at most three status-aware attempts with backoff; other HTTP statuses are terminal. Network errors, tool calls, and AI refusals are not automatically replayed. The runner does not add an arbitrary request timeout.

## 3. Dispatch from your app

Store a narrowly scoped GitHub dispatch token as a secret in the dispatching app's server-side secret store. Dispatch from server code, never browser code:

```http
POST https://api.github.com/repos/OWNER/REPOSITORY/dispatches
Accept: application/vnd.github+json
Authorization: Bearer YOUR_GITHUB_TOKEN
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json

{
  "event_type": "run-ai-task",
  "client_payload": {
    "task_id": "report-2026-10-01-001",
    "input": "Read today's email, find the message about the documents, create the requested file, upload it, and confirm when finished.",
    "model": "your-provider-model",
    "callback_url": "https://your-app.example.com/api/ai-complete",
    "storage": {
      "max_bytes": 1073741824,
      "max_files": 2500
    },
    "tool_broker": {
      "app_user_id": "AUTHENTICATED_USER_STABLE_ID",
      "auth_token": "SHORT_LIVED_TASK_SCOPED_TOKEN"
    },
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "search_email",
          "description": "Search this user's authorized email account.",
          "parameters": {
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"],
            "additionalProperties": false
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "upload_drive_file",
          "description": "Upload a file to this user's authorized drive. Provide file data using the files attachment field.",
          "parameters": {
            "type": "object",
            "properties": {
              "filename": { "type": "string" },
              "files": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "path": { "type": "string", "description": "Path inside the task scratch workspace." },
                    "name": { "type": "string" },
                    "content_type": { "type": "string" }
                  },
                  "required": ["path"],
                  "additionalProperties": false
                }
              }
            },
            "required": ["filename", "files"],
            "additionalProperties": false
          }
        }
      }
    ]
  }
}
```

The model name stays exactly as supplied; `AI_DEFAULT_MODEL` is used when omitted. Tool schemas are passed to the selected OpenAI-compatible API. The runner retains the complete assistant tool-call message and each matching tool result in context, then asks the model to continue, up to 12 tool rounds and 60 total tool calls per task.

The payload must be under 900,000 bytes. For larger prompts or documents, have the app store the content and let an authorized app tool fetch it, or split it into bounded chunks.

## 4. App tool broker protocol

Implement `TOOL_BROKER_URL` in your app as a server-side endpoint. The runner sends one `POST application/json` per model-requested tool call:

```json
{
  "protocol": "longrun.tool-broker.v1",
  "task_id": "report-2026-10-01-001",
  "app_user_id": "AUTHENTICATED_USER_STABLE_ID",
  "tool_call_id": "call_abc123",
  "name": "search_email",
  "arguments": { "query": "documents" },
  "files": []
}
```

The request includes `Authorization: Bearer <short-lived task token>`. The workflow may also add `Authorization: Bearer <TOOL_BROKER_TOKEN>` when `TOOL_BROKER_TOKEN` is configured; in that case the per-task credential is sent in `X-Longrun-Task-Token` instead. Your broker must validate the configured credential, task ID, user ID, granted tools, arguments, and expiry; resolve that user's already-authorized Composio connection; enforce its own confirmation rules for sensitive actions; and execute only the named, allowed tool. Never trust the user ID or granted tools just because they appeared in the task payload. Do not pass provider OAuth tokens, Composio keys, or user connection secrets back to the model or into Actions secrets.

Successful response:

```json
{
  "ok": true,
  "result": { "messages": [{ "subject": "Documents", "body": "..." }] }
}
```

Return an error as `{"ok":false,"error":{"message":"Safe explanation"}}` and an appropriate non-2xx status when execution fails. The runner relays the safe response text and status to the task callback. One ordinary tool result is limited to 1,000,000 bytes.

Tool arguments can include a `files` array. Each `{ "path": "report.pdf", "name": "report.pdf", "content_type": "application/pdf" }` path refers to a task scratch file; the broker receives its bytes in `content_base64`. The broker may return `files: [{"path":"output.docx","content_base64":"..."}]`; returned files are saved in scratch and can be attached to later tool calls. Each file is limited to 1,000,000 decoded bytes; task-wide file/byte caps still apply. For larger PDFs, Office documents, or outputs, have the broker stream them directly to your app-owned storage and return an app-controlled file ID or URL rather than moving a large file through the dispatch payload.

The runner can call the broker but cannot implement your app's Composio sign-in, per-user connection storage, or OAuth consent screen. Build and secure that broker in your app; it is the only layer that should map `app_user_id` to the user's authorized Composio connection.

## 5. Task scratch files and larger storage

Each job gets a new, isolated temporary directory. It is deleted after success or failure; it is not a durable file store and will not survive a task. Temporary disk available to GitHub-hosted runners depends on the runner image and repository plan. Longrun's configurable per-task cap is therefore an upper bound, not a promise that GitHub will provision that much free disk. Set `TASK_STORAGE_MAX_BYTES` and `TASK_STORAGE_MAX_FILES` for repository defaults, or override `storage.max_bytes` and `storage.max_files` for a particular request. Overrides are capped at 5 GiB and 10,000 files. Use conservative values and leave headroom for the checkout, tools, and runner operating system.

The model can use these built-in scratch tools:

- `scratch_list({"path":"."})`
- `scratch_read({"path":"notes.txt"})`
- `scratch_write({"path":"notes.txt","content":"..."})` or binary data with `content_base64`
- `scratch_mkdir({"path":"exports"})`
- `scratch_stat({"path":"notes.txt"})`

All paths are confined to that task's directory; symlink trees are rejected when enforcing storage limits. Use the broker to transfer files to email, Drive, or your app's durable storage. The runner deliberately does not keep or publish a GitHub Actions artifact by default.

## 6. Callback contract

Completed tasks send:

```json
{
  "task_id": "report-2026-10-01-001",
  "model": "your-provider-model",
  "status": "completed",
  "result": "The task is complete.",
  "usage": { "prompt_tokens": 30, "completion_tokens": 80 },
  "tool_calls": 3,
  "storage": { "persistence": "temporary", "retained": false }
}
```

Refusals use `status: "refused"`; terminal errors use `status: "failed"` with a safe `error.message` and, when available, `upstream_http_status`. Refusal ends the run and does not trigger automatic further work. Usage is included only if the provider returns it. Callbacks include `Idempotency-Key: <task_id>` and optional `Authorization: Bearer <CALLBACK_TOKEN>`. The HTTPS callback hostname must exactly match `CALLBACK_ALLOWED_HOSTS`, and the endpoint must return `2xx`.

GitHub accepts a repository dispatch with HTTP `204`; the task runs asynchronously. Persist its queued state in your app before dispatch, treat callbacks idempotently by `task_id`, and require the callback token in your app endpoint.

## Security checklist

- Dispatch only from server-side code with a narrowly scoped repository token.
- Never send AI, GitHub, Composio, or provider credentials in event payloads.
- Pass an opaque, stable ID for the already authenticated app user and a short-lived task credential; authorize every tool again at the broker.
- Allowlist exact HTTPS callback and broker hostnames; redirects are rejected.
- Publish only the tools a task is allowed to use; require user confirmation for sensitive or irreversible actions.
- Treat email, PDF and tool output as untrusted input; validate schemas, size limits, and safe output behavior at the broker.
- Keep scratch files temporary; transfer durable outputs to storage you control.
- GitHub job limits are up to 360 minutes; GitHub plan/usage limits, disk capacity, AI provider limits, and Composio quotas still apply.