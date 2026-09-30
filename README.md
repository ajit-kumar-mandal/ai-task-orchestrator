# Longrun — GitHub AI task relay

Run OpenAI-compatible AI requests inside GitHub Actions, up to the workflow's six-hour job limit, and POST each result to your app's callback URL. This repository is designed to be pushed to GitHub and dispatched by a separate project.

## 1. Add this project to GitHub

Push the repository to a GitHub repository. The included workflow listens for the `repository_dispatch` event type `run-ai-task`.

## 2. Configure repository settings

In **Settings → Secrets and variables → Actions**, add:

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | Secret | API key for your OpenAI-compatible provider |
| `AI_API_BASE_URL` | Variable | HTTPS provider base URL, usually ending in `/v1` (or the full `/chat/completions` URL) |
| `AI_DEFAULT_MODEL` | Variable | Default model when a dispatch does not specify one |
| `CALLBACK_TOKEN` | Secret, optional | Bearer token sent to your callback endpoint |
| `CALLBACK_ALLOWED_HOSTS` | Variable | Required: comma-separated callback hostnames allowed by the runner |

Never put provider keys in the dispatch payload. The runner sends the prompt as a streamed Chat Completions request and assembles its text answer before the callback. Provider `429` and transient `5xx` responses receive at most three attempts with a delay; other HTTP errors end the task. No arbitrary request timeout is imposed by the runner.

## 3. Dispatch from your other project

Give that project a GitHub token with permission to dispatch events in this repository, and store it in that project's own secret store. Then send:

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
    "input": "Summarize the report and return the key findings.",
    "system": "Be precise and cite the supplied material.",
    "model": "your-provider-model",
    "callback_url": "https://your-app.example.com/api/ai-complete"
  }
}
```

`task_id`, `input`, and `callback_url` are required for a callback. `system` and `model` are optional. If omitted, the runner uses `AI_DEFAULT_MODEL`. The callback must be HTTPS; configure `CALLBACK_ALLOWED_HOSTS` with the exact hostname(s) allowed to receive results. The runner refuses callback delivery until this allowlist is set.

A `fetch` request from your server can dispatch it like this:

```js
const response = await fetch(
  "https://api.github.com/repos/OWNER/REPOSITORY/dispatches",
  {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "run-ai-task", client_payload: task }),
  },
);
if (!response.ok) throw new Error(`GitHub dispatch failed: ${response.status}`);
```

GitHub accepts the event with HTTP `204`; the workflow then runs asynchronously. Your app should persist the task as queued before dispatching, match callbacks using `task_id`, and handle duplicate callbacks idempotently.

## 4. Callback contract

Completed requests send:

```json
{
  "task_id": "report-2026-10-01-001",
  "model": "your-provider-model",
  "status": "completed",
  "result": "The generated answer...",
  "usage": { "prompt_tokens": 30, "completion_tokens": 80 }
}
```

Refusals use `status: "refused"` and include the provider's refusal text in `result`. Failed requests send `status: "failed"` with a safe `error.message`. Token usage is included only when the provider returns it in its stream. Each callback includes `Idempotency-Key: <task_id>` and, when configured, `Authorization: Bearer <CALLBACK_TOKEN>`.

The callback must respond with a successful `2xx` status. A failed AI task reports its failure before the workflow exits unsuccessfully. If no callback URL is supplied, results are visible in the Actions job logs.

## Security notes

- Use a dedicated GitHub token with the narrowest available access; never expose it in browser code.
- Provider API keys and callback tokens are GitHub Actions secrets, not event data.
- Set `CALLBACK_ALLOWED_HOSTS` to your app's hostname to prevent callbacks to unexpected hosts; it is required before callback delivery.
- GitHub Actions jobs can run for up to 360 minutes; organization, repository, provider, and usage limits still apply.
