import { fail } from "./errors.mjs";

// Hard protocol/resource caps. None of these is a logical task limit.
export const HARD = Object.freeze({
  MAX_DISPATCH_BYTES: 65_535,
  MAX_PROMPT_LENGTH: 200_000,
  MAX_TOOL_RESULT_BYTES: 1_000_000,
  MAX_TOOLS: 200,
  MAX_STORAGE_BYTES: 5 * 1024 * 1024 * 1024,
  MAX_STORAGE_FILES: 10_000,
  DEFAULT_STORAGE_BYTES: 512 * 1024 * 1024,
  DEFAULT_STORAGE_FILES: 1_000,
  MODEL_MAX_ATTEMPTS: 3,
  MAX_RETRY_DELAY_MS: 30_000,
});

// Execution-safety settings (per GitHub job / hop). They bound one execution,
// never the lifetime of the logical task. EMERGENCY_* guards exist only to stop
// runaway loops; reaching one causes checkpoint + handoff, never "completed".
export const EXECUTION_DEFAULTS = Object.freeze({
  EXECUTION_DEADLINE_MS: 340 * 60_000,
  CHECKPOINT_RESERVE_MS: 10 * 60_000,
  MODEL_CALL_TIMEOUT_MS: 30 * 60_000,
  TOOL_CALL_TIMEOUT_MS: 15 * 60_000,
  CALLBACK_TIMEOUT_MS: 30_000,
  CALLBACK_MAX_ATTEMPTS: 5,
  HEARTBEAT_INTERVAL_MS: 60_000,
  CHECKPOINT_INTERVAL_MS: 5 * 60_000,
  EMERGENCY_MAX_MODEL_ROUNDS_PER_HOP: 2_000,
  EMERGENCY_MAX_TOOL_CALLS_PER_HOP: 10_000,
  EMERGENCY_MAX_CONTEXT_BYTES: 16 * 1024 * 1024,
});

export function executionSettings(env, execution = {}) {
  const settings = {};
  for (const [name, fallback] of Object.entries(EXECUTION_DEFAULTS)) {
    const raw = env[name];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer.`);
    settings[name] = value;
  }
  if (execution?.deadline_ms !== undefined) {
    const requested = Number(execution.deadline_ms);
    if (!Number.isSafeInteger(requested) || requested < 1) fail("execution.deadline_ms must be a positive integer.");
    settings.EXECUTION_DEADLINE_MS = Math.min(settings.EXECUTION_DEADLINE_MS, requested);
  }
  if (settings.CALLBACK_MAX_ATTEMPTS < 1) settings.CALLBACK_MAX_ATTEMPTS = 1;
  if (settings.CHECKPOINT_RESERVE_MS >= settings.EXECUTION_DEADLINE_MS) fail("CHECKPOINT_RESERVE_MS must be smaller than EXECUTION_DEADLINE_MS.");
  return settings;
}

export const backoffMs = (attempt, cap = HARD.MAX_RETRY_DELAY_MS) =>
  Math.round(Math.min(1000 * 2 ** attempt, cap) * (0.75 + Math.random() * 0.5));
