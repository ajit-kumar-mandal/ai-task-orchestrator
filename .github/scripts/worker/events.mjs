// Structured JSON-line lifecycle events written to the job log. Metadata is
// always passed through the redactor; tool arguments are never included.
export const LIFECYCLE_EVENTS = Object.freeze([
  "execution_started", "model_started", "model_finished", "tool_started", "tool_finished",
  "checkpoint_started", "checkpoint_saved", "handoff_requested", "callback_sent",
  "execution_completed", "execution_paused", "execution_failed",
]);

export function createEventLog({ identity, redactor, sink, now }) {
  return {
    emit(eventType, metadata = {}) {
      const line = {
        longrun_event: eventType,
        task_id: identity.task_id ?? null,
        execution_id: identity.execution_id ?? null,
        hop_number: identity.hop_number ?? null,
        timestamp: new Date(now()).toISOString(),
        ...redactor.value(metadata),
      };
      sink(JSON.stringify(line));
    },
  };
}
