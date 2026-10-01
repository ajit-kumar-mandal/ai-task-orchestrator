import { sendJson } from "./http.mjs";

// Lifecycle callbacks to Study AI. Idempotency-Key is deterministic:
//   task_id:execution_id:event_type   (heartbeats append :<sequence>)
// The body is computed once and retried byte-for-byte, so receivers can
// safely dedupe duplicates. Responses may carry {"directive": "continue" |
// "cancel" | "checkpoint_and_handoff"}; HTTP 409 means the lease is lost.
export function createCallbackClient({ url, token, identity, fetchImpl, redactor, log, sleep, timeoutMs, maxAttempts }) {
  return {
    enabled: Boolean(url),
    keyFor(eventType, suffix) {
      return `${identity.task_id}:${identity.execution_id}:${eventType}${suffix !== undefined ? `:${suffix}` : ""}`;
    },
    async send(eventType, body, { suffix } = {}) {
      const idempotencyKey = this.keyFor(eventType, suffix);
      if (!url) {
        log.emit("callback_skipped", { event_type: eventType, idempotency_key: idempotencyKey, reason: "no callback_url" });
        return { directive: "continue" };
      }
      const serialized = JSON.stringify(redactor.value({ protocol: "longrun.callback.v2", event_type: eventType, idempotency_key: idempotencyKey, ...body }));
      const { json, attempts, status } = await sendJson({
        url, fetchImpl, sleep, timeoutMs, maxAttempts, label: "Callback",
        headers: { "Idempotency-Key": idempotencyKey, "X-Longrun-Execution-Id": identity.execution_id, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: serialized,
      });
      log.emit("callback_sent", { event_type: eventType, idempotency_key: idempotencyKey, attempts, http_status: status });
      const directive = ["cancel", "checkpoint_and_handoff"].includes(json?.directive) ? json.directive : "continue";
      return { directive };
    },
  };
}
