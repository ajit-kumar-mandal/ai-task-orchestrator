import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, textReply, toolReply, json, finalCallback, gatewayTool, hang, v2 } from "./harness.mjs";

const writeCall = (id) => ({ id, name: "scratch_write", args: { path: `${id}.txt`, content: "x" } });

test("lost callback: transient failures are retried with identical body and idempotency key", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    ai: () => textReply("ok"),
    callback: (body, _h, n) => (body.event_type === "execution_completed" && n <= 3 ? json(503, {}) : json(200, {})),
  });
  assert.equal(outcome.exitCode, 0);
  const finals = record.callbacks.filter((entry) => entry.body.event_type === "execution_completed");
  assert.equal(finals.length, 3);
  assert.equal(new Set(finals.map((entry) => entry.raw)).size, 1, "byte-identical retries");
  assert.equal(new Set(finals.map((entry) => entry.headers["idempotency-key"])).size, 1);
});

test("duplicate callback: receiver can dedupe by deterministic key", async () => {
  const delivered = new Map();
  const callback = (body, headers) => { delivered.set(headers["idempotency-key"], (delivered.get(headers["idempotency-key"]) ?? 0) + 1); return delivered.get(headers["idempotency-key"]) === 1 ? json(500, {}) : json(200, { duplicate: true }); };
  const { outcome } = await harness({ payload: v2(), ai: () => textReply("ok"), callback });
  assert.equal(outcome.exitCode, 0);
  assert.equal(delivered.get("task-1:exec-1:execution_completed"), 2);
});

test("callback undeliverable: exit 1 but checkpoint already persisted for recovery", async () => {
  const { outcome, record, store } = await harness({
    payload: v2(),
    env: { EMERGENCY_MAX_TOOL_CALLS_PER_HOP: "1", CALLBACK_MAX_ATTEMPTS: "2" },
    ai: () => toolReply([writeCall("c1")]),
    callback: (body) => (body.event_type === "execution_started" ? json(200, {}) : json(503, {})),
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.status, "handoff_pending");
  assert.ok(store.size >= 1);
  assert.ok(record.checkpoints.length >= 1);
});

test("worker crash: periodic checkpoints let a new hop resume", async () => {
  const store = new Map();
  // Hop 1 "crashes" (model never responds and the process is abandoned).
  void harness({
    payload: v2(),
    env: { CHECKPOINT_INTERVAL_MS: "0", MODEL_CALL_TIMEOUT_MS: "300" },
    checkpointStore: store,
    ai: (_b, n, init) => (n <= 2 ? toolReply([writeCall(`x${n}`)]) : hang(init.signal)),
  });
  for (let i = 0; i < 50 && store.size < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(store.size >= 2, "checkpoints written before crash");
  const latest = [...store.keys()].sort().at(-1);
  const hop2 = await harness({
    payload: { ...v2({ execution_id: "exec-2", hop_number: 2, lease_version: 2 }), resume: { checkpoint_ref: latest, instructions: "Previous execution crashed; continue." } },
    checkpointStore: store,
    ai: () => textReply("recovered"),
  });
  assert.equal(hop2.outcome.status, "completed");
  const messages = hop2.record.ai[0].messages;
  assert.ok(messages.some((message) => message.tool_call_id === "x2"));
  assert.equal(messages.at(-1).content, "Previous execution crashed; continue.");
});

test("GitHub job cancellation aborts the model call and hands off with a checkpoint", async () => {
  const controller = new AbortController();
  const { outcome, record } = await harness({
    payload: v2(),
    signal: controller.signal,
    ai: (_b, n, init) => { if (n === 1) return toolReply([writeCall("c1")]); setTimeout(() => controller.abort(), 5); return hang(init.signal); },
  });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "provider_job_cancelled");
  assert.ok(finalCallback(record).checkpoint_ref);
});

test("provider timeout is an execution-level handoff, not completion", async () => {
  const { outcome } = await harness({ payload: v2(), env: { MODEL_CALL_TIMEOUT_MS: "20" }, ai: (_b, _n, init) => hang(init.signal) });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "provider_timeout");
});

test("provider 5xx after bounded retries hands off with next_hop_at", async () => {
  const { outcome, record } = await harness({ payload: v2(), ai: () => json(503, { error: { message: "busy" } }) });
  assert.equal(record.ai.length, 3);
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "provider_unavailable");
});

test("tool unknown outcome: a mutation with a lost response is never repeated", async () => {
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("send_message", { application_id: "app_m", capability: "message.send", mutating: true })] },
    ai: () => toolReply([{ id: "m1", name: "send_message", args: {} }, { id: "m2", name: "send_message", args: {} }]),
    broker: () => { throw new Error("socket hang up"); },
  });
  assert.equal(record.broker.length, 1);
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "unknown_mutation_outcome");
  const final = finalCallback(record);
  assert.equal(final.requires_verification, true);
  assert.equal(final.unknown_outcomes[0].action_key, "task-1:exec-1:m1");
  assert.equal(final.unknown_outcomes[0].application_id, "app_m");
});

test("mutating 502 is unknown outcome (single call); read-only network errors are retried", async () => {
  const mutating = await harness({
    payload: { ...v2(), tools: [gatewayTool("w", { mutating: true })] },
    ai: () => toolReply([{ id: "w1", name: "w", args: {} }]),
    broker: () => json(502, { error: { message: "bad gateway" } }),
  });
  assert.equal(mutating.record.broker.length, 1);
  assert.equal(mutating.outcome.stopReason, "unknown_mutation_outcome");
  const readOnly = await harness({
    payload: { ...v2(), tools: [gatewayTool("r", { mutating: false })] },
    ai: (_b, n) => (n === 1 ? toolReply([{ id: "r1", name: "r", args: {} }]) : textReply("ok")),
    broker: (_b, _h, n) => { if (n < 3) throw new Error("reset"); return json(200, { ok: true, result: 1 }); },
  });
  assert.equal(readOnly.record.broker.length, 3);
  assert.equal(readOnly.outcome.status, "completed");
});

test("checkpoint retry: transient store failure retried with the same idempotency key", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    env: { EMERGENCY_MAX_TOOL_CALLS_PER_HOP: "1" },
    ai: () => toolReply([writeCall("c1")]),
    checkpointPost: (_body, _h, n) => (n === 1 ? json(503, {}) : null),
  });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "emergency_guard_tool_calls");
  assert.equal(record.checkpoints.length, 2);
  assert.equal(record.checkpoints[0].headers["idempotency-key"], record.checkpoints[1].headers["idempotency-key"]);
});

test("checkpoint permanently failing reports checkpoint_failed, not completed", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    env: { EMERGENCY_MAX_TOOL_CALLS_PER_HOP: "1", CALLBACK_MAX_ATTEMPTS: "2" },
    ai: () => toolReply([writeCall("c1")]),
    checkpointPost: () => json(503, {}),
  });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "checkpoint_failed");
  assert.equal(finalCallback(record).failure_category, "checkpoint_failure");
  assert.equal(finalCallback(record).intended_stop_reason, "emergency_guard_tool_calls");
});

test("without a checkpoint store, the checkpoint is delivered inline in the handoff callback", async () => {
  const { outcome, record } = await harness({ payload: v2(), env: { STUDYAI_CHECKPOINT_URL: null, EMERGENCY_MAX_TOOL_CALLS_PER_HOP: "1" }, ai: () => toolReply([writeCall("c1")]) });
  assert.equal(outcome.status, "handoff_pending");
  const final = finalCallback(record);
  assert.equal(final.checkpoint.schema, "longrun.checkpoint.v1");
  assert.equal(final.checkpoint_ref, null);
});
