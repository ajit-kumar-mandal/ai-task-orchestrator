const MAX_ATTEMPTS = 3;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_RETRY_DELAY_MS = 30_000;

function fail(message) {
  throw new Error(message);
}

function safeMessage(message, secret) {
  const cleaned = String(message || "The AI request failed.")
    .replaceAll(secret || "\u0000", "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
  return cleaned || "The AI request failed.";
}

function parsePayload() {
  let payload;
  try {
    payload = JSON.parse(process.env.TASK_PAYLOAD || "{}");
  } catch {
    fail("The dispatch payload is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("The dispatch payload must be a JSON object.");
  }
  if (typeof payload.task_id !== "string" || !/^[\w.:/-]{1,180}$/.test(payload.task_id)) {
    fail("A task_id containing 1–180 letters, numbers, or . _ : / - is required.");
  }
  if (typeof payload.input !== "string" || payload.input.trim().length === 0) {
    fail("A non-empty input prompt is required.");
  }
  if (payload.input.length > MAX_PROMPT_LENGTH) {
    fail(`The input prompt must be no longer than ${MAX_PROMPT_LENGTH} characters.`);
  }
  if (payload.callback_url && typeof payload.callback_url !== "string") {
    fail("callback_url must be a string.");
  }
  return payload;
}

function getEndpoints() {
  const raw = process.env.AI_API_BASE_URL?.trim();
  if (!raw) fail("Configure the AI_API_BASE_URL repository variable.");
  let base;
  try {
    base = new URL(raw);
  } catch {
    fail("AI_API_BASE_URL must be a valid HTTPS URL ending in /v1.");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    fail("AI_API_BASE_URL must be an HTTPS URL without embedded credentials or query parameters.");
  }
  const path = base.pathname.replace(/\/+$/, "");
  const chatUrl = /\/chat\/completions$/.test(path)
    ? base.toString()
    : `${base.origin}${path}/chat/completions`;
  return { base, chatUrl };
}

function validateCallback(payload) {
  if (!payload.callback_url) return null;
  let callback;
  try {
    callback = new URL(payload.callback_url);
  } catch {
    fail("callback_url must be a valid HTTPS URL.");
  }
  if (callback.protocol !== "https:" || callback.username || callback.password) {
    fail("callback_url must use HTTPS and must not contain embedded credentials.");
  }
  const allowlist = (process.env.CALLBACK_ALLOWED_HOSTS || "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length === 0) {
    fail("Configure CALLBACK_ALLOWED_HOSTS with the hostname allowed to receive results.");
  }
  if (!allowlist.includes(callback.hostname.toLowerCase())) {
    fail("callback_url host is not included in CALLBACK_ALLOWED_HOSTS.");
  }
  return callback;
}

function retryAfterMs(response, attempt) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const dateMs = Date.parse(header) - Date.now();
    const delay = Number.isFinite(seconds) ? seconds * 1000 : dateMs;
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, MAX_RETRY_DELAY_MS);
  }
  const exponential = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

async function responseError(response, apiKey) {
  let message = `AI API returned HTTP ${response.status}.`;
  try {
    const body = await response.json();
    message = body?.error?.message || body?.message || message;
  } catch {
    // Keep the status-based message when the provider did not return JSON.
  }
  return { message: safeMessage(message, apiKey), status: response.status };
}

function buildMessages(payload) {
  const messages = [];
  if (typeof payload.system === "string" && payload.system.trim()) {
    messages.push({ role: "system", content: payload.system });
  }
  messages.push({ role: "user", content: payload.input });
  return messages;
}

async function readEventStream(body) {
  if (!body) fail("The AI API returned an empty response stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let refusal = "";
  let wasRefused = false;
  let usage = null;
  let streamError = null;
  let streamErrorStatus;

  const consumeFrame = (frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      streamError = "The AI API returned an invalid streaming response.";
      return;
    }
    if (event.error) {
      streamError = safeMessage(event.error.message || "The AI stream ended with an error.", process.env.AI_API_KEY);
      const upstreamStatus = Number(event.error.upstream_http_status || event.error.http_status || event.error.status);
      if (Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599) streamErrorStatus = upstreamStatus;
      return;
    }
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === "string") text += choice.delta.content;
    if (Array.isArray(choice?.delta?.content)) {
      for (const part of choice.delta.content) if (typeof part?.text === "string") text += part.text;
    }
    if (typeof choice?.delta?.refusal === "string") refusal += choice.delta.refusal;
    if (typeof choice?.message?.refusal === "string") refusal += choice.message.refusal;
    if (choice?.finish_reason === "refusal") wasRefused = true;
    if (event.usage) usage = event.usage;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (streamError) throw Object.assign(new Error(streamError), { httpStatus: streamErrorStatus });
  return { text, refusal, wasRefused, usage };
}

async function callAi(payload, apiKey, chatUrl) {
  const model = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : process.env.AI_DEFAULT_MODEL?.trim();
  if (!model) fail("Provide a model in the dispatch payload or configure AI_DEFAULT_MODEL.");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(chatUrl, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model, messages: buildMessages(payload), stream: true, stream_options: { include_usage: true } }),
      });
    } catch (error) {
      // Network errors have no confirmed retryable HTTP status; do not replay the request.
      throw new Error(safeMessage(error?.message || "Could not reach the AI API.", apiKey));
    }

    if (!response.ok) {
      const upstream = await responseError(response, apiKey);
      const accountOrConfigurationBlock = /account|billing|configuration|misconfigured|invalid api key|suspended|disabled/i.test(upstream.message);
      if (!(response.status === 429 || (response.status >= 500 && !accountOrConfigurationBlock)) || attempt === MAX_ATTEMPTS - 1) {
        throw Object.assign(new Error(upstream.message), { httpStatus: upstream.status });
      }
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs(response, attempt)));
      continue;
    }

    const result = await readEventStream(response.body);
    if (result.refusal || result.wasRefused) {
      return { model, status: "refused", result: result.refusal || "The AI provider refused this request.", usage: result.usage };
    }
    if (!result.text.trim()) fail("The AI API completed without returning a text answer.");
    return { model, status: "completed", result: result.text, usage: result.usage };
  }
  fail("The AI request could not be completed.");
}

async function postCallback(callback, payload, result, apiKey) {
  if (!callback) return;
  const response = await fetch(callback, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": payload.task_id,
      ...(process.env.CALLBACK_TOKEN ? { Authorization: `Bearer ${process.env.CALLBACK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ task_id: payload.task_id, ...result }),
  });
  if (!response.ok) throw new Error(`Callback returned HTTP ${response.status}.`);
  console.log(`Callback accepted task ${payload.task_id}.`);
  void apiKey;
}

async function main() {
  const payload = parsePayload();
  const callback = validateCallback(payload);
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) fail("Configure the AI_API_KEY repository secret.");
  const { chatUrl } = getEndpoints();
  console.log(`Starting task ${payload.task_id}.`);
  try {
    const result = await callAi(payload, apiKey, chatUrl);
    await postCallback(callback, payload, result, apiKey);
    console.log(`Task ${payload.task_id} finished with status ${result.status}.`);
  } catch (error) {
    const message = safeMessage(error?.message, apiKey);
    try {
      await postCallback(callback, payload, {
        status: "failed",
        error: {
          message,
          ...(Number.isInteger(error?.httpStatus) ? { upstream_http_status: error.httpStatus } : {}),
        },
      }, apiKey);
    } catch (callbackError) {
      console.error(safeMessage(callbackError?.message, process.env.CALLBACK_TOKEN));
    }
    console.error(message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(safeMessage(error?.message, process.env.AI_API_KEY));
  process.exitCode = 1;
});
