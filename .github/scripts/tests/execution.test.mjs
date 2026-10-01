import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, textReply, toolReply, json, finalCallback, events, v2 } from "./harness.mjs";

const writeCall = (id) => ({ id, name: "scratch_write", args: { path: `${id}.txt`, content: "x" } });

test("execution starts: execution_started callback carries execution identity", async () => {
  const { outcome, record } = await harness({ payload: v2(), ai: () => textReply("done") });
  assert.equal(outcome.status, "completed");
  const started = record.callbacks[0];
  assert.equal(started.body.event_type, "execution_started");
  assert.equal(started.body.status, "running");
  assert.equal(started.body.provider, "github_actions");
  assert.equal(started.body.provider_job_id, "777-1");
  assert.equal(started.headers["idempotency-key"], "task-1:exec-1:execution_started");
  const final = finalCallback(record);
  for (const field of ["task_id", "execution_id", "hop_number", "status", "stop_reason", "checkpoint_version", "idempotency_key", "provider_job_id", "lease_version", "started_at", "finished_at"]) assert.ok(field in final, field);
  assert.equal(final.idempotency_key, "task-1:exec-1:execution_completed");
  assert.equal(final.completion_authority, "studyai");
  assert.ok(events(record).some((event) => event.longrun_event === "execution_started"));
});

test("execution checkpoints and hands off at the execution deadline, never reports completed", async () => {
  let clock = 1_000_000;
  const { outcome, record } = await harness({
    payload: v2(),
    env: { EXECUTION_DEADLINE_MS: "2000", CHECKPOINT_RESERVE_MS: "1000" },
    now: () => clock,
    ai: (_body, n) => { clock += 400; return toolReply([writeCall(`c${n}`)]); },
  });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "execution_deadline");
  const final = finalCallback(record);
  assert.equal(final.status, "handoff_pending");
  assert.equal(final.event_type, "execution_handoff");
  assert.ok(final.checkpoint_ref);
  assert.ok(final.next_hop_at);
  assert.ok(Date.parse(final.finished_at) < 1_000_000 + 2000, "handoff finished before deadline");
  const types = events(record).map((event) => event.longrun_event);
  assert.ok(types.indexOf("checkpoint_started") < types.indexOf("checkpoint_saved"));
  assert.ok(types.indexOf("checkpoint_saved") < types.indexOf("handoff_requested"));
});

test("execution resumes from a persisted checkpoint in the next hop", async () => {
  const first = await harness({ payload: v2(), env: { EMERGENCY_MAX_TOOL_CALLS_PER_HOP: "2" }, ai: (_b, n) => toolReply([writeCall(`a${n}`)]) });
  assert.equal(first.outcome.status, "handoff_pending");
  const ref = finalCallback(first.record).checkpoint_ref;
  const second = await harness({
    payload: { ...v2({ execution_id: "exec-2", hop_number: 2, lease_version: 2 }), input: undefined, resume: { checkpoint_ref: ref } },
    checkpointStore: first.store,
    ai: () => textReply("resumed and finished"),
  });
  assert.equal(second.outcome.status, "completed");
  const messages = second.record.ai[0].messages;
  assert.ok(messages.some((message) => message.role === "tool" && message.tool_call_id === "a1"), "previous tool results restored");
  assert.ok(finalCallback(second.record).checkpoint_version > finalCallback(first.record).checkpoint_version);
  assert.equal(finalCallback(second.record).hop_number, 2);
});

test("duplicate execution: second worker with the same execution is fenced by Study AI (409)", async () => {
  const seen = new Set();
  const callback = (body) => {
    if (body.event_type === "execution_started") {
      if (seen.has(body.idempotency_key)) return json(409, { error: "execution already running" });
      seen.add(body.idempotency_key);
    }
    return json(200, {});
  };
  const one = await harness({ payload: v2(), ai: () => textReply("ok"), callback });
  assert.equal(one.outcome.status, "completed");
  const two = await harness({ payload: v2(), ai: () => { throw new Error("must not call model"); }, callback });
  assert.equal(two.outcome.status, "cancelled");
  assert.equal(two.outcome.stopReason, "lease_lost");
  assert.equal(two.record.ai.length, 0);
  assert.equal(two.outcome.exitCode, 0);
});

test("stale execution: resume checkpoint from the same or later hop is rejected", async () => {
  const checkpoint = { schema: "longrun.checkpoint.v1", task_id: "task-1", hop_number: 3, checkpoint_version: 4, messages: [{ role: "user", content: "x" }] };
  const { outcome, record } = await harness({ payload: { ...v2({ hop_number: 2 }), resume: { checkpoint } }, ai: () => textReply("no") });
  assert.equal(outcome.status, "cancelled");
  assert.equal(record.ai.length, 0);
});

test("lease mismatch on heartbeat stops work immediately", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    env: { HEARTBEAT_INTERVAL_MS: "0" },
    ai: (_b, n) => toolReply([writeCall(`h${n}`)]),
    callback: (body) => (body.event_type === "heartbeat" && body.sequence >= 2 ? json(409, {}) : json(200, {})),
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.stopReason, "lease_lost");
  assert.equal(record.ai.length, 1);
});

test("cancellation directive from Study AI cancels the execution", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    env: { HEARTBEAT_INTERVAL_MS: "0" },
    ai: (_b, n) => toolReply([writeCall(`k${n}`)]),
    callback: (body) => json(200, body.event_type === "heartbeat" ? { directive: "cancel" } : {}),
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.stopReason, "cancelled_by_controller");
  assert.equal(finalCallback(record).event_type, "execution_cancelled");
});

test("terminal failure: provider 401 fails once with failed_terminal", async () => {
  const { outcome, record } = await harness({ payload: v2(), ai: () => json(401, { error: { message: "invalid api key" } }) });
  assert.equal(outcome.status, "failed_terminal");
  assert.equal(outcome.exitCode, 1);
  assert.equal(record.ai.length, 1);
  assert.equal(finalCallback(record).error.upstream_http_status, 401);
});

test("model refusal is terminal and not retried", async () => {
  const { outcome, record } = await harness({ payload: v2(), ai: () => textReply("").constructor === Response ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { refusal: "no" }, finish_reason: "refusal" }] })}\n\n`) : null });
  assert.equal(outcome.status, "failed_terminal");
  assert.equal(outcome.stopReason, "model_refusal");
  assert.equal(record.ai.length, 1);
});

test("legacy payload stays compatible: single final callback with legacy status", async () => {
  const { outcome, record } = await harness({ ai: () => textReply("legacy ok") });
  assert.equal(outcome.status, "completed");
  assert.equal(record.callbacks.length, 1);
  const final = finalCallback(record);
  assert.equal(final.status, "completed");
  assert.equal(final.result, "legacy ok");
  assert.equal(final.execution_id, "gha-777-1");
  assert.deepEqual(final.storage, { persistence: "temporary", retained: false });
  const failed = await harness({ ai: () => json(400, { error: { message: "bad" } }) });
  assert.equal(finalCallback(failed.record).status, "failed");
});
