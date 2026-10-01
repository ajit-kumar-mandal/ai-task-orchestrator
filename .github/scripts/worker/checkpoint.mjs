import { FailureCategory, WorkerError, leaseLost } from "./errors.mjs";
import { sendJson } from "./http.mjs";

// A checkpoint is the complete continuation state for the next execution.
// It never contains API keys, grants, tokens or scratch file bytes, and it is
// persisted only in Study AI (via STUDYAI_CHECKPOINT_URL or the callback).
export const CHECKPOINT_SCHEMA = "longrun.checkpoint.v1";

export function buildCheckpoint({ identity, run, version, reason, createdAt, redactor }) {
  return redactor.value({
    schema: CHECKPOINT_SCHEMA,
    task_id: identity.task_id,
    execution_id: identity.execution_id,
    hop_number: identity.hop_number,
    lease_version: identity.lease_version,
    checkpoint_version: version,
    reason,
    model: run.model,
    messages: run.messages,
    tool_calls_total: run.toolCallsTotal,
    model_rounds_total: run.roundsTotal,
    usage_total: run.usage,
    unknown_outcomes: run.unknownOutcomes,
    created_at: createdAt,
  });
}

export async function persistCheckpoint({ url, token, identity, checkpoint, fetchImpl, sleep, timeoutMs, maxAttempts }) {
  const idempotencyKey = `${identity.task_id}:${identity.execution_id}:checkpoint:${checkpoint.checkpoint_version}`;
  try {
    const { json } = await sendJson({
      url, fetchImpl, sleep, timeoutMs, maxAttempts, label: "Checkpoint store",
      headers: { "Idempotency-Key": idempotencyKey, "X-Longrun-Execution-Id": identity.execution_id, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ protocol: "longrun.checkpoint-store.v1", idempotency_key: idempotencyKey, task_id: identity.task_id, execution_id: identity.execution_id, hop_number: identity.hop_number, lease_version: identity.lease_version, checkpoint_version: checkpoint.checkpoint_version, checkpoint }),
    });
    return { checkpointRef: typeof json?.checkpoint_ref === "string" ? json.checkpoint_ref : `${identity.task_id}:${checkpoint.checkpoint_version}` };
  } catch (error) {
    if (error.category === FailureCategory.LEASE_FENCING_FAILURE) throw error;
    throw new WorkerError(`Checkpoint could not be persisted: ${error.message}`, { category: FailureCategory.CHECKPOINT_FAILURE, stopReason: "checkpoint_failed" });
  }
}

export function validateCheckpoint(checkpoint, identity) {
  if (!checkpoint || checkpoint.schema !== CHECKPOINT_SCHEMA || !Array.isArray(checkpoint.messages)) {
    throw new WorkerError("The resume checkpoint is missing or has an unsupported schema.", { category: FailureCategory.CHECKPOINT_FAILURE, terminal: true, stopReason: "checkpoint_invalid" });
  }
  if (checkpoint.task_id !== identity.task_id) throw new WorkerError("The resume checkpoint belongs to another task.", { category: FailureCategory.CHECKPOINT_FAILURE, terminal: true, stopReason: "checkpoint_invalid" });
  if (identity.protocol === "v2" && Number.isSafeInteger(checkpoint.hop_number) && checkpoint.hop_number >= identity.hop_number) {
    throw leaseLost("The resume checkpoint is from this or a later hop; this execution is stale.");
  }
  return checkpoint;
}

export async function loadCheckpoint({ payload, url, token, identity, fetchImpl, sleep, timeoutMs, maxAttempts }) {
  const resume = payload.resume;
  if (!resume) return null;
  if (resume.checkpoint) return validateCheckpoint(resume.checkpoint, identity);
  if (typeof resume.checkpoint_ref !== "string" || !resume.checkpoint_ref) throw new WorkerError("resume requires checkpoint_ref or an inline checkpoint.", { category: FailureCategory.TERMINAL, stopReason: "checkpoint_invalid" });
  if (!url) throw new WorkerError("Configure STUDYAI_CHECKPOINT_URL to resume from a checkpoint_ref.", { category: FailureCategory.TERMINAL, stopReason: "checkpoint_invalid" });
  const target = new URL(url.toString());
  target.searchParams.set("task_id", identity.task_id);
  target.searchParams.set("checkpoint_ref", resume.checkpoint_ref);
  try {
    const { json } = await sendJson({ method: "GET", url: target, fetchImpl, sleep, timeoutMs, maxAttempts, label: "Checkpoint store", headers: { "X-Longrun-Execution-Id": identity.execution_id, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    return validateCheckpoint(json?.checkpoint ?? json, identity);
  } catch (error) {
    if (error instanceof WorkerError && (error.category === FailureCategory.LEASE_FENCING_FAILURE || error.stopReason === "checkpoint_invalid")) throw error;
    throw new WorkerError(`Checkpoint could not be loaded: ${error.message}`, { category: FailureCategory.CHECKPOINT_FAILURE, stopReason: "checkpoint_load_failed" });
  }
}
