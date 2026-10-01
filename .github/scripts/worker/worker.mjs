import { executionSettings } from "./config.mjs";
import { FailureCategory, WorkerError } from "./errors.mjs";
import { Redactor } from "./redact.mjs";
import { createEventLog } from "./events.mjs";
import { decryptGrant } from "./grant.mjs";
import { parsePayload, resolveIdentity, resolveModelEndpoint, validateBroker, validateCallbackUrl, validateCheckpointUrl } from "./payload.mjs";
import { cleanupScratch, createScratchSpace, readAttachment, scratchLimits, scratchTool } from "./scratch.mjs";
import { commandPolicy, runCommand } from "./commands.mjs";
import { buildToolRegistry, validateArguments } from "./tools.mjs";
import { requestModel } from "./ai.mjs";
import { invokeTool } from "./broker.mjs";
import { buildCheckpoint, loadCheckpoint, persistCheckpoint } from "./checkpoint.mjs";
import { createCallbackClient } from "./callback.mjs";

// Execution states. "completed" means this execution observed a final model
// answer; Study AI alone decides whether the logical task is complete.
export const ExecutionState = Object.freeze({
  QUEUED: "queued", STARTING: "starting", RUNNING: "running", CHECKPOINTING: "checkpointing",
  HANDOFF_PENDING: "handoff_pending", COMPLETED: "completed", PAUSED_FOR_USER: "paused_for_user",
  FAILED_TERMINAL: "failed_terminal", CANCELLED: "cancelled",
});

const FINAL_EVENT = {
  completed: "execution_completed", paused_for_user: "execution_paused", handoff_pending: "execution_handoff",
  failed_terminal: "execution_failed", cancelled: "execution_cancelled",
};
const LEGACY_STATUS = { completed: "completed", failed_terminal: "failed" };
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms) => new Date(ms).toISOString();

function systemMessage(payload) {
  const custom = typeof payload.system === "string" ? payload.system.trim() : "";
  const scratch = "You have a temporary, execution-scoped workspace accessible through the scratch_* tools (paths are relative). It is deleted when this execution ends; files from previous executions are not available. Never assume secrets are available.";
  return { role: "system", content: [custom, scratch].filter(Boolean).join("\n\n") };
}

export async function runExecution(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const cancelSignal = options.signal ?? new AbortController().signal;
  const sink = options.sink ?? ((line) => console.log(line));
  const spawnImpl = options.spawnImpl;
  const startedAtMs = now();
  const redactor = new Redactor().add(env.AI_API_KEY, env.TOOL_BROKER_TOKEN, env.CALLBACK_TOKEN);
  const identity = { task_id: null, execution_id: null, hop_number: null };
  const log = createEventLog({ identity, redactor, sink, now });
  const preflightFailure = (error, stopReason) => {
    log.emit("execution_failed", { status: ExecutionState.FAILED_TERMINAL, stop_reason: stopReason, failure_category: FailureCategory.TERMINAL, message: redactor.text(error?.message) });
    return { exitCode: 1, status: ExecutionState.FAILED_TERMINAL, stopReason };
  };

  // ---- Preflight that must succeed before any callback can be sent ----
  let payload, callbackUrl, settings, checkpointUrl;
  try { payload = parsePayload(env.TASK_PAYLOAD); } catch (error) { return preflightFailure(error, "invalid_dispatch"); }
  try { Object.assign(identity, resolveIdentity(payload, env, startedAtMs)); } catch (error) { return preflightFailure(error, "invalid_dispatch"); }
  try { callbackUrl = validateCallbackUrl(payload.callback_url, env); } catch (error) { return preflightFailure(error, "callback_not_allowed"); }
  try { settings = executionSettings(env, payload.execution); checkpointUrl = validateCheckpointUrl(env); } catch (error) { return preflightFailure(error, "invalid_configuration"); }

  const v2 = identity.protocol === "v2";
  const token = env.CALLBACK_TOKEN?.trim() || undefined;
  const callback = createCallbackClient({ url: callbackUrl, token, identity, fetchImpl, redactor, log, sleep, timeoutMs: settings.CALLBACK_TIMEOUT_MS, maxAttempts: settings.CALLBACK_MAX_ATTEMPTS });
  const deadlineAt = startedAtMs + settings.EXECUTION_DEADLINE_MS;
  const reserveAt = deadlineAt - settings.CHECKPOINT_RESERVE_MS;
  const run = {
    state: ExecutionState.STARTING, model: null, messages: [], usage: null,
    roundsThisHop: 0, roundsTotal: 0, toolCallsThisHop: 0, toolCallsTotal: 0,
    unknownOutcomes: [], checkpointVersion: identity.checkpoint_version, checkpointRef: null, checkpointInline: null,
    heartbeatAt: identity.started_at, lastHeartbeatMs: startedAtMs, heartbeatSeq: 0, lastCheckpointMs: startedAtMs,
  };
  const storeArgs = { url: checkpointUrl, token, identity, fetchImpl, sleep, timeoutMs: settings.CALLBACK_TIMEOUT_MS, maxAttempts: settings.CALLBACK_MAX_ATTEMPTS };
  let scratch = null;

  log.emit("execution_started", { state: run.state, provider: identity.provider, provider_job_id: identity.provider_job_id, lease_version: identity.lease_version, protocol: identity.protocol, deadline_at: iso(deadlineAt), checkpoint_reserve_ms: settings.CHECKPOINT_RESERVE_MS });

  const boundaryReason = () => {
    if (cancelSignal.aborted) return "provider_job_cancelled";
    if (now() >= reserveAt) return "execution_deadline";
    return null;
  };

  const handleDirective = (directive) => {
    if (directive === "cancel") return { status: ExecutionState.CANCELLED, stopReason: "cancelled_by_controller" };
    if (directive === "checkpoint_and_handoff") return { checkpointReason: "controller_requested_handoff" };
    return null;
  };

  // Persist continuation state. Returns the checkpoint ref/version, or throws.
  const saveCheckpoint = async (reason) => {
    const version = run.checkpointVersion + 1;
    const checkpoint = buildCheckpoint({ identity, run, version, reason, createdAt: iso(now()), redactor });
    if (checkpointUrl) {
      const { checkpointRef } = await persistCheckpoint({ ...storeArgs, checkpoint });
      run.checkpointRef = checkpointRef;
      run.checkpointInline = null;
    } else {
      run.checkpointRef = null;
      run.checkpointInline = checkpoint; // durable once the final callback is accepted
    }
    run.checkpointVersion = version;
    run.lastCheckpointMs = now();
    return version;
  };

  const checkpointAndStop = async (status, stopReason, extra = {}) => {
    run.state = ExecutionState.CHECKPOINTING;
    const t0 = now();
    log.emit("checkpoint_started", { reason: stopReason, next_version: run.checkpointVersion + 1 });
    try {
      await saveCheckpoint(stopReason);
      log.emit("checkpoint_saved", { checkpoint_version: run.checkpointVersion, checkpoint_ref: run.checkpointRef, inline: Boolean(run.checkpointInline), duration_ms: now() - t0 });
    } catch (error) {
      if (error.category === FailureCategory.LEASE_FENCING_FAILURE) throw error;
      log.emit("execution_failed", { stop_reason: "checkpoint_failed", failure_category: FailureCategory.CHECKPOINT_FAILURE, message: error.message, intended_stop_reason: stopReason });
      return { status: ExecutionState.HANDOFF_PENDING, stopReason: "checkpoint_failed", category: FailureCategory.CHECKPOINT_FAILURE, intendedStopReason: stopReason, nextHopAt: iso(now()), ...extra };
    }
    if (status === ExecutionState.HANDOFF_PENDING) {
      const nextHopAt = extra.nextHopAt ?? iso(now());
      log.emit("handoff_requested", { stop_reason: stopReason, checkpoint_version: run.checkpointVersion, next_hop_at: nextHopAt });
      return { status, stopReason, ...extra, nextHopAt };
    }
    return { status, stopReason, ...extra };
  };

  const pushToolResult = (callId, content) => run.messages.push({ role: "tool", tool_call_id: callId, content });
  const fillNotExecuted = (calls) => {
    for (const call of calls) pushToolResult(call.id, JSON.stringify({ ok: false, status: "not_executed", reason: "This execution stopped before running this tool call. It was not executed and may be requested again." }));
  };

  async function executeToolCall(call, registry, ctx) {
    const name = call.function?.name;
    const entry = registry.index.get(name);
    const t0 = now();
    const meta = entry?.meta ?? { application_id: null, capability: null, mutating: false };
    log.emit("tool_started", { tool: name, tool_call_id: call.id, kind: entry?.kind ?? "unknown", application_id: meta.application_id, capability: meta.capability, mutating: meta.mutating });
    const finish = (outcome, extra = {}) => { log.emit("tool_finished", { tool: name, tool_call_id: call.id, outcome, duration_ms: now() - t0, ...extra }); };
    const errorResult = (code, message) => { finish("tool_error", { code }); return { content: JSON.stringify({ ok: false, error: { code, message: redactor.text(message) } }) }; };

    if (!entry) return errorResult("unknown_tool", `Tool ${String(name).slice(0, 64)} is not published for this task.`);
    let args;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { return errorResult("invalid_arguments", "Tool arguments are not valid JSON."); }
    const schemaError = validateArguments(entry.parameters, args);
    if (schemaError) return errorResult("invalid_arguments", schemaError);

    try {
      if (entry.kind === "scratch") { const content = await scratchTool(name, args, ctx.scratch); finish("ok"); return { content }; }
      if (entry.kind === "command") { const content = await runCommand(args, ctx.scratch, ctx.commands, redactor, env, spawnImpl); finish("ok"); return { content }; }
      if (!ctx.broker) return errorResult("gateway_not_configured", "This task has no authorized tool gateway.");
      const files = [];
      for (const file of Array.isArray(args.files) ? args.files : []) files.push(await readAttachment(ctx.scratch, file));
      const toolTimeout = Math.max(1, Math.min(settings.TOOL_CALL_TIMEOUT_MS, deadlineAt - now() - Math.floor(settings.CHECKPOINT_RESERVE_MS / 2)));
      const outcome = await invokeTool({ broker: ctx.broker, identity, name, meta, callId: call.id, args, files, scratch: ctx.scratch, fetchImpl, sleep, redactor, timeoutMs: toolTimeout });
      if (outcome.kind === "result") { finish("ok"); return { content: outcome.content }; }
      if (outcome.kind === "tool_error") return errorResult(outcome.code, outcome.message);
      if (outcome.kind === "needs_user") {
        finish("needs_user", { code: outcome.code });
        return { pause: { code: outcome.code, message: outcome.message }, content: JSON.stringify({ ok: false, status: "needs_user", error: { code: outcome.code, message: outcome.message } }) };
      }
      finish("unknown_outcome", { action_key: outcome.actionKey, detail: outcome.detail });
      return {
        unknown: { action_key: outcome.actionKey, tool_call_id: call.id, tool: name, application_id: meta.application_id, capability: meta.capability, detail: outcome.detail, observed_at: iso(now()) },
        content: JSON.stringify({ ok: false, status: "unknown_outcome", action_key: outcome.actionKey, message: "The tool may or may not have executed. Do not repeat it; the controller will verify." }),
      };
    } catch (error) {
      if (error instanceof WorkerError && error.category === FailureCategory.TOOL_FAILURE) return errorResult(error.code || "tool_failed", error.message);
      throw error;
    }
  }

  async function execute() {
    const apiKey = env.AI_API_KEY?.trim();
    if (!apiKey) throw new WorkerError("Configure the AI_API_KEY repository secret.");
    const chatUrl = resolveModelEndpoint(env);
    const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : env.AI_DEFAULT_MODEL?.trim();
    if (!model) throw new WorkerError("Provide a model in the dispatch payload or configure AI_DEFAULT_MODEL.");
    run.model = model;
    const broker = validateBroker(payload, env);
    if (broker) {
      redactor.add(broker.encryptedGrant);
      broker.authorizationGrant = decryptGrant(broker.sharedToken, identity.task_id, broker.appUserId, broker.encryptedGrant);
      redactor.add(broker.authorizationGrant);
    }
    const limits = scratchLimits(payload, env);
    const commands = commandPolicy(payload, env);
    const registry = buildToolRegistry(payload, Boolean(commands));

    if (broker?.expiresAtMs !== null && broker?.expiresAtMs !== undefined && broker.expiresAtMs <= now()) {
      return { status: ExecutionState.PAUSED_FOR_USER, stopReason: "authorization_expired", category: FailureCategory.AUTHORIZATION_REQUIRED };
    }

    if (v2) {
      const { directive } = await callback.send("execution_started", { ...identityFields(), status: ExecutionState.RUNNING, model }).catch((error) => {
        if (error.category === FailureCategory.LEASE_FENCING_FAILURE) throw error;
        log.emit("callback_failed", { event_type: "execution_started", message: error.message });
        return { directive: "continue" };
      });
      const action = handleDirective(directive);
      if (action?.status) return action;
    }

    const checkpoint = await loadCheckpoint({ payload, ...storeArgs });
    if (checkpoint) {
      run.messages = [systemMessage(payload), ...checkpoint.messages.filter((message) => message.role !== "system")];
      run.toolCallsTotal = checkpoint.tool_calls_total ?? 0;
      run.roundsTotal = checkpoint.model_rounds_total ?? 0;
      run.usage = checkpoint.usage_total ?? null;
      run.checkpointVersion = Math.max(run.checkpointVersion, checkpoint.checkpoint_version ?? 0);
      if (typeof payload.resume.instructions === "string" && payload.resume.instructions.trim()) run.messages.push({ role: "user", content: payload.resume.instructions });
      else if (typeof payload.input === "string" && payload.input.trim() && payload.resume.append_input === true) run.messages.push({ role: "user", content: payload.input });
    } else {
      run.messages = [systemMessage(payload), { role: "user", content: payload.input }];
    }

    scratch = await createScratchSpace(payload, limits, env);
    run.state = ExecutionState.RUNNING;
    const ctx = { scratch, broker, commands };

    while (true) {
      const boundary = boundaryReason();
      if (boundary) return checkpointAndStop(ExecutionState.HANDOFF_PENDING, boundary);

      if (v2 && now() - run.lastHeartbeatMs >= settings.HEARTBEAT_INTERVAL_MS) {
        run.heartbeatSeq += 1;
        run.lastHeartbeatMs = now();
        run.heartbeatAt = iso(run.lastHeartbeatMs);
        const { directive } = await callback.send("heartbeat", { ...identityFields(), status: ExecutionState.RUNNING, heartbeat_at: run.heartbeatAt, sequence: run.heartbeatSeq, tool_calls: run.toolCallsThisHop, checkpoint_version: run.checkpointVersion }, { suffix: run.heartbeatSeq }).catch((error) => {
          if (error.category === FailureCategory.LEASE_FENCING_FAILURE) throw error;
          return { directive: "continue" };
        });
        const action = handleDirective(directive);
        if (action?.status) return action;
        if (action?.checkpointReason) return checkpointAndStop(ExecutionState.HANDOFF_PENDING, action.checkpointReason);
      }

      if (run.roundsThisHop >= settings.EMERGENCY_MAX_MODEL_ROUNDS_PER_HOP) return checkpointAndStop(ExecutionState.HANDOFF_PENDING, "emergency_guard_model_rounds", { category: FailureCategory.RETRYABLE });
      if (Buffer.byteLength(JSON.stringify(run.messages)) > settings.EMERGENCY_MAX_CONTEXT_BYTES) return checkpointAndStop(ExecutionState.HANDOFF_PENDING, "emergency_guard_context_size", { category: FailureCategory.RETRYABLE });

      const remaining = reserveAt - now();
      const timeoutMs = Math.min(settings.MODEL_CALL_TIMEOUT_MS, remaining);
      run.roundsThisHop += 1;
      run.roundsTotal += 1;
      const t0 = now();
      log.emit("model_started", { round: run.roundsThisHop, model, message_count: run.messages.length, timeout_ms: timeoutMs });
      let result;
      try {
        result = await requestModel({ chatUrl, apiKey, model, messages: run.messages, tools: registry.forModel, fetchImpl, sleep, redactor, timeoutMs, cancelSignal });
      } catch (error) {
        log.emit("model_finished", { round: run.roundsThisHop, outcome: "error", failure_category: error.category, stop_reason: error.stopReason, http_status: error.httpStatus, duration_ms: now() - t0 });
        if (error instanceof WorkerError && !error.terminal && error.category === FailureCategory.TRANSIENT) {
          let reason = error.stopReason || "provider_unavailable";
          if (reason === "model_call_timeout") reason = timeoutMs < settings.MODEL_CALL_TIMEOUT_MS ? "execution_deadline" : "provider_timeout";
          return checkpointAndStop(ExecutionState.HANDOFF_PENDING, reason, { category: FailureCategory.TRANSIENT, httpStatus: error.httpStatus, nextHopAt: iso(now() + (error.retryAfterMs ?? 0)) });
        }
        throw error;
      }
      if (result.usage) run.usage = result.usage;
      log.emit("model_finished", { round: run.roundsThisHop, outcome: result.toolCalls.length ? "tool_calls" : "final", tool_call_count: result.toolCalls.length, duration_ms: now() - t0 });

      if (result.refusal || result.wasRefused) {
        return { status: ExecutionState.FAILED_TERMINAL, stopReason: "model_refusal", category: FailureCategory.MODEL_PROVIDER_FAILURE, refused: true, result: redactor.text(result.refusal || "The AI provider refused this request.") };
      }
      if (!result.toolCalls.length) {
        if (!result.text.trim()) throw new WorkerError("The AI API completed without returning a text answer or tool call.", { category: FailureCategory.MODEL_PROVIDER_FAILURE, terminal: true, stopReason: "model_empty_response" });
        run.messages.push({ role: "assistant", content: result.text });
        if (checkpointUrl) {
          try { await saveCheckpoint("model_final_answer"); } catch (error) { if (error.category === FailureCategory.LEASE_FENCING_FAILURE) throw error; log.emit("checkpoint_failed", { message: error.message }); }
        }
        return { status: ExecutionState.COMPLETED, stopReason: "model_final_answer", result: redactor.text(result.text) };
      }
      for (const call of result.toolCalls) {
        if (typeof call.id !== "string" || !call.id) throw new WorkerError("The AI returned a tool call without an id.", { category: FailureCategory.MODEL_PROVIDER_FAILURE, terminal: true, stopReason: "model_invalid_response" });
      }
      run.messages.push({ role: "assistant", content: result.text || null, tool_calls: result.toolCalls });

      for (let index = 0; index < result.toolCalls.length; index += 1) {
        const call = result.toolCalls[index];
        const stop = boundaryReason() ?? (run.toolCallsThisHop >= settings.EMERGENCY_MAX_TOOL_CALLS_PER_HOP ? "emergency_guard_tool_calls" : null);
        if (stop) {
          fillNotExecuted(result.toolCalls.slice(index));
          return checkpointAndStop(ExecutionState.HANDOFF_PENDING, stop, stop.startsWith("emergency") ? { category: FailureCategory.RETRYABLE } : {});
        }
        run.toolCallsThisHop += 1;
        run.toolCallsTotal += 1;
        const handled = await executeToolCall(call, registry, ctx);
        pushToolResult(call.id, handled.content);
        if (handled.pause) {
          fillNotExecuted(result.toolCalls.slice(index + 1));
          return checkpointAndStop(ExecutionState.PAUSED_FOR_USER, handled.pause.code === "confirmation_required" ? "user_confirmation_required" : "authorization_required", { category: FailureCategory.AUTHORIZATION_REQUIRED, pauseMessage: handled.pause.message });
        }
        if (handled.unknown) {
          run.unknownOutcomes.push(handled.unknown);
          fillNotExecuted(result.toolCalls.slice(index + 1));
          return checkpointAndStop(ExecutionState.HANDOFF_PENDING, "unknown_mutation_outcome", { category: FailureCategory.TOOL_FAILURE, requiresVerification: true });
        }
      }

      if (checkpointUrl && now() - run.lastCheckpointMs >= settings.CHECKPOINT_INTERVAL_MS) {
        try {
          await saveCheckpoint("periodic");
          log.emit("checkpoint_saved", { checkpoint_version: run.checkpointVersion, checkpoint_ref: run.checkpointRef, reason: "periodic" });
        } catch (error) {
          if (error.category === FailureCategory.LEASE_FENCING_FAILURE) throw error;
          log.emit("checkpoint_failed", { message: error.message, reason: "periodic" });
        }
      }
    }
  }

  function identityFields() {
    return {
      task_id: identity.task_id, execution_id: identity.execution_id, hop_number: identity.hop_number,
      provider: identity.provider, provider_job_id: identity.provider_job_id, lease_version: identity.lease_version,
      started_at: identity.started_at, heartbeat_at: run.heartbeatAt,
    };
  }

  function outcomeFromError(error) {
    const category = error?.category ?? FailureCategory.TERMINAL;
    const message = redactor.text(error?.message || "The execution failed.");
    if (category === FailureCategory.LEASE_FENCING_FAILURE) return { status: ExecutionState.CANCELLED, stopReason: error.stopReason || "lease_lost", category, leaseLost: true, error: { message } };
    if (!error?.terminal && (category === FailureCategory.TRANSIENT || category === FailureCategory.CHECKPOINT_FAILURE)) {
      return { status: ExecutionState.HANDOFF_PENDING, stopReason: error.stopReason || "runtime_failure", category, nextHopAt: iso(now()), error: { message } };
    }
    return { status: ExecutionState.FAILED_TERMINAL, stopReason: error?.stopReason || "terminal_failure", category, error: { message, ...(Number.isInteger(error?.httpStatus) ? { upstream_http_status: error.httpStatus } : {}) } };
  }

  let outcome;
  try { outcome = await execute(); }
  catch (error) { outcome = outcomeFromError(error); }
  finally {
    if (scratch) await cleanupScratch(scratch).catch(() => log.emit("scratch_cleanup_failed", {}));
  }

  // ---- Final lifecycle report ----
  const finishedAt = iso(now());
  const eventType = FINAL_EVENT[outcome.status];
  let exitCode = outcome.status === ExecutionState.FAILED_TERMINAL ? 1 : 0;
  const status = v2 ? outcome.status : outcome.refused ? "refused" : LEGACY_STATUS[outcome.status] ?? outcome.status;
  const body = {
    ...identityFields(),
    status,
    execution_state: outcome.status,
    stop_reason: outcome.stopReason,
    failure_category: outcome.category ?? null,
    checkpoint_version: run.checkpointVersion,
    checkpoint_ref: run.checkpointRef,
    ...(run.checkpointInline && outcome.status !== ExecutionState.COMPLETED ? { checkpoint: run.checkpointInline } : {}),
    next_hop_at: outcome.status === ExecutionState.HANDOFF_PENDING ? outcome.nextHopAt ?? finishedAt : null,
    finished_at: finishedAt,
    model: run.model,
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome.pauseMessage ? { pause: { message: outcome.pauseMessage } } : {}),
    ...(outcome.intendedStopReason ? { intended_stop_reason: outcome.intendedStopReason } : {}),
    usage: run.usage ?? undefined,
    tool_calls: run.toolCallsThisHop,
    tool_calls_total: run.toolCallsTotal,
    model_rounds: run.roundsThisHop,
    unknown_outcomes: run.unknownOutcomes,
    requires_verification: Boolean(outcome.requiresVerification) || run.unknownOutcomes.length > 0,
    completion_authority: "studyai",
    ...(outcome.error ? { error: outcome.error } : {}),
    storage: { persistence: "temporary", retained: false },
  };

  if (!outcome.leaseLost) {
    try { await callback.send(eventType, body); }
    catch (error) {
      if (error.category !== FailureCategory.LEASE_FENCING_FAILURE) {
        exitCode = 1;
        log.emit("execution_failed", { stop_reason: "callback_undelivered", failure_category: FailureCategory.TRANSIENT, message: redactor.text(error.message), intended_status: outcome.status });
      }
    }
  }
  const logEvent = { completed: "execution_completed", paused_for_user: "execution_paused", handoff_pending: "execution_paused", failed_terminal: "execution_failed", cancelled: "execution_failed" }[outcome.status];
  log.emit(logEvent, { status: outcome.status, stop_reason: outcome.stopReason, failure_category: outcome.category ?? null, checkpoint_version: run.checkpointVersion, tool_calls: run.toolCallsThisHop, duration_ms: now() - startedAtMs });
  return { exitCode, status: outcome.status, stopReason: outcome.stopReason, checkpointVersion: run.checkpointVersion, checkpointRef: run.checkpointRef, body };
}
