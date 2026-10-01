import { HARD } from "./config.mjs";
import { FailureCategory, WorkerError } from "./errors.mjs";

// Streaming chat-completions client. Model calls are non-mutating, so an
// aborted/timed-out call is safely redone by the next execution.
export function retryDelayMs(headers, attempt) {
  const header = headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, HARD.MAX_RETRY_DELAY_MS);
  }
  return Math.round(Math.min(1000 * 2 ** attempt, HARD.MAX_RETRY_DELAY_MS) * (0.75 + Math.random() * 0.5));
}

const transient = (message, extra = {}) => new WorkerError(message, { category: FailureCategory.TRANSIENT, stopReason: "provider_unavailable", ...extra });

export async function readEventStream(body, redactor) {
  if (!body) throw new WorkerError("The AI API returned an empty response stream.", { category: FailureCategory.MODEL_PROVIDER_FAILURE, terminal: true, stopReason: "model_invalid_response" });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out = { text: "", refusal: "", wasRefused: false, usage: null };
  let toolCalls = new Map();
  let streamError = null;
  let streamStatus;
  const consume = (frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { streamError = "The AI API returned an invalid streaming response."; return; }
    if (event.error) {
      streamError = redactor.text(event.error.message || "The AI stream ended with an error.");
      const status = Number(event.error.upstream_http_status || event.error.http_status || event.error.status);
      if (Number.isInteger(status) && status >= 100 && status <= 599) streamStatus = status;
      return;
    }
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === "string") out.text += delta.content;
    if (Array.isArray(delta?.content)) for (const part of delta.content) if (typeof part?.text === "string") out.text += part.text;
    if (typeof delta?.refusal === "string") out.refusal += delta.refusal;
    if (typeof choice?.message?.refusal === "string") out.refusal += choice.message.refusal;
    if (choice?.finish_reason === "refusal") out.wasRefused = true;
    for (const part of delta?.tool_calls || []) {
      const index = part.index ?? 0;
      const existing = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (part.id) existing.id = part.id;
      if (part.function?.name) existing.function.name += part.function.name;
      if (part.function?.arguments) existing.function.arguments += part.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice?.message?.tool_calls?.length) toolCalls = new Map(choice.message.tool_calls.map((part, index) => [index, part]));
    if (event.usage) out.usage = event.usage;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) consume(frame);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (streamError) {
    if (streamStatus === 429 || streamStatus >= 500) throw transient(streamError, { httpStatus: streamStatus });
    throw new WorkerError(streamError, { category: FailureCategory.MODEL_PROVIDER_FAILURE, terminal: true, httpStatus: streamStatus, stopReason: "model_provider_rejected" });
  }
  out.toolCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ id: call.id, type: "function", function: { name: call.function?.name ?? "", arguments: call.function?.arguments ?? "" } }));
  return out;
}

async function responseMessage(response, redactor) {
  let message = `AI API returned HTTP ${response.status}.`;
  try { const body = await response.json(); message = body?.error?.message || body?.message || message; } catch { /* keep status */ }
  return redactor.text(message);
}

export async function requestModel({ chatUrl, apiKey, model, messages, tools, fetchImpl, sleep, redactor, timeoutMs, cancelSignal }) {
  for (let attempt = 0; attempt < HARD.MODEL_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let abortReason = null;
    const timer = setTimeout(() => { abortReason = "timeout"; controller.abort(); }, Math.max(1, timeoutMs));
    const onCancel = () => { abortReason = "cancel"; controller.abort(); };
    if (cancelSignal.aborted) onCancel(); else cancelSignal.addEventListener("abort", onCancel, { once: true });
    const abortError = () => abortReason === "cancel"
      ? new WorkerError("The execution provider is cancelling this job.", { category: FailureCategory.TRANSIENT, stopReason: "provider_job_cancelled" })
      : new WorkerError("The model call reached its execution-safety timeout.", { category: FailureCategory.TRANSIENT, stopReason: "model_call_timeout" });
    try {
      let response;
      try {
        response = await fetchImpl(chatUrl, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools, tool_choice: "auto" } : {}) }),
        });
      } catch (error) {
        if (abortReason) throw abortError();
        throw transient(redactor.text(`Could not reach the AI API: ${error?.message || "network error"}`));
      }
      if (!response.ok) {
        const message = await responseMessage(response, redactor);
        const blocked = /account|billing|configuration|misconfigured|invalid api key|suspended|disabled/i.test(message);
        const retryable = response.status === 429 || (response.status >= 500 && !blocked);
        if (!retryable) throw new WorkerError(message, { category: FailureCategory.MODEL_PROVIDER_FAILURE, terminal: true, httpStatus: response.status, stopReason: "model_provider_rejected" });
        const delay = retryDelayMs(response.headers, attempt);
        if (attempt === HARD.MODEL_MAX_ATTEMPTS - 1) throw transient(message, { httpStatus: response.status, retryAfterMs: delay });
        clearTimeout(timer);
        await sleep(delay);
        continue;
      }
      try { return await readEventStream(response.body, redactor); }
      catch (error) { if (abortReason) throw abortError(); throw error; }
    } finally {
      clearTimeout(timer);
      cancelSignal.removeEventListener("abort", onCancel);
    }
  }
  throw transient("The AI request could not be completed.");
}
