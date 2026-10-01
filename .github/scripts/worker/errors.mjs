// Failure taxonomy shared by every worker module. Study AI receives the
// category in callbacks and decides recovery; the worker never decides that a
// logical task is finished or abandoned.
export const FailureCategory = Object.freeze({
  TRANSIENT: "transient",
  RETRYABLE: "retryable",
  AUTHORIZATION_REQUIRED: "authorization_required",
  TOOL_FAILURE: "tool_failure",
  MODEL_PROVIDER_FAILURE: "model_provider_failure",
  CHECKPOINT_FAILURE: "checkpoint_failure",
  LEASE_FENCING_FAILURE: "lease_fencing_failure",
  TERMINAL: "terminal",
});

export class WorkerError extends Error {
  constructor(message, { category = FailureCategory.TERMINAL, terminal, stopReason, httpStatus, retryAfterMs, code } = {}) {
    super(message);
    this.name = "WorkerError";
    this.category = category;
    this.terminal = terminal ?? category === FailureCategory.TERMINAL;
    this.stopReason = stopReason;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

export const fail = (message, options) => { throw new WorkerError(message, options); };

export const leaseLost = (message = "Study AI rejected this execution's lease; another execution owns the task.") =>
  new WorkerError(message, { category: FailureCategory.LEASE_FENCING_FAILURE, stopReason: "lease_lost" });
