import { backoffMs, HARD } from "./config.mjs";
import { leaseLost } from "./errors.mjs";
import { saveReturnedFile } from "./scratch.mjs";

// Generic tool-gateway invocation: invokeTool({applicationId, capability, tool, args}).
// The gateway resolves the user's connection, validates the grant/scope and
// executes. The worker never branches on a specific application.
//
// Returns one of:
//   { kind: "result", content }
//   { kind: "tool_error", code, message }          -> fed back to the model
//   { kind: "needs_user", code, message }          -> execution pauses for the user
//   { kind: "unknown_outcome", actionKey, detail } -> never retried; Study AI verifies
const USER_ACTION_CODES = new Set(["needs_user", "authorization_required", "grant_expired", "reauthorization_required", "confirmation_required"]);

export async function invokeTool({ broker, identity, name, meta, callId, args, files, scratch, fetchImpl, sleep, redactor, timeoutMs }) {
  const actionKey = `${identity.task_id}:${identity.execution_id}:${callId}`;
  const body = JSON.stringify({
    protocol: "longrun.tool-broker.v1",
    contract_version: 2,
    task_id: identity.task_id,
    execution_id: identity.execution_id,
    hop_number: identity.hop_number,
    lease_version: identity.lease_version,
    app_user_id: broker.appUserId,
    tool_call_id: callId,
    action_key: actionKey,
    name,
    application_id: meta.application_id,
    capability: meta.capability,
    mutating: meta.mutating,
    grant_expires_at: broker.expiresAt,
    arguments: args,
    files,
  });
  const headers = {
    Authorization: `Bearer ${broker.sharedToken}`,
    "X-Longrun-Task-Token": broker.authorizationGrant,
    "Idempotency-Key": actionKey,
    "X-Longrun-Execution-Id": identity.execution_id,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const unknown = (detail) => ({ kind: "unknown_outcome", actionKey, detail });
  const toolError = (code, message) => ({ kind: "tool_error", code, message: redactor.text(message) });
  const readOnlyAttempts = 3;

  for (let attempt = 0; attempt < readOnlyAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    let response;
    let text;
    try {
      response = await fetchImpl(broker.url.toString(), { method: "POST", redirect: "error", headers, body, signal: controller.signal });
      text = await response.text();
    } catch {
      clearTimeout(timer);
      // Request may have reached the gateway: a mutation's outcome is unknown.
      if (meta.mutating) return unknown(response ? "response_lost" : "request_outcome_unknown");
      if (attempt < readOnlyAttempts - 1) { await sleep(backoffMs(attempt)); continue; }
      return toolError("gateway_unreachable", "The tool gateway could not be reached.");
    }
    clearTimeout(timer);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const code = typeof json?.error?.code === "string" ? json.error.code : null;
    const message = json?.error?.message || (json ? `Tool gateway returned HTTP ${response.status}.` : text.slice(0, 500)) || `Tool gateway returned HTTP ${response.status}.`;

    if (response.status === 409) throw leaseLost("The tool gateway rejected this execution's lease.");
    if (response.ok && json && json.ok !== false) {
      const fileErrors = [];
      for (const file of Array.isArray(json.files) ? json.files : []) {
        try { await saveReturnedFile(scratch, file); } catch (error) { fileErrors.push(redactor.text(error.message)); }
      }
      let content = redactor.text(JSON.stringify(json.result ?? json));
      if (Buffer.byteLength(content) > HARD.MAX_TOOL_RESULT_BYTES) content = JSON.stringify({ ok: true, result_omitted: true, reason: "The tool executed but its result exceeds the tool-result size limit." });
      if (fileErrors.length) content = JSON.stringify({ ok: true, result: JSON.parse(content), file_errors: fileErrors });
      return { kind: "result", content };
    }
    if (response.ok && !json) return meta.mutating ? unknown("unparseable_response") : toolError("invalid_gateway_response", "The tool gateway returned an unreadable response.");
    if (code === "unknown_outcome") return unknown("reported_by_gateway");
    if ((code && USER_ACTION_CODES.has(code)) || ((response.status === 401 || response.status === 403) && !code)) {
      return { kind: "needs_user", code: code || "authorization_required", message: redactor.text(message) };
    }
    const knownNotExecuted = response.status === 429 || json?.error?.executed === false;
    if (response.status === 429 || response.status >= 500) {
      if (!knownNotExecuted && meta.mutating) return unknown("gateway_error_after_dispatch");
      if (attempt < readOnlyAttempts - 1) { await sleep(backoffMs(attempt)); continue; }
      return toolError(code || "gateway_unavailable", message);
    }
    return toolError(code || `http_${response.status}`, message);
  }
  return toolError("gateway_unavailable", "The tool gateway was unavailable.");
}
