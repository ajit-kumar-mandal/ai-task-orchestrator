import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, textReply, toolReply, json, finalCallback, gatewayTool, v2 } from "./harness.mjs";

const writeCall = (id) => ({ id, name: "scratch_write", args: { path: `${id}.txt`, content: "x" } });
const toolResults = (record) => record.ai.at(-1).messages.filter((message) => message.role === "tool").map((message) => ({ id: message.tool_call_id, content: JSON.parse(message.content) }));

test("normal execution does not stop after 12 model rounds", async () => {
  const { outcome, record } = await harness({ payload: v2(), ai: (_b, n) => (n <= 20 ? toolReply([writeCall(`r${n}`)]) : textReply("finished")) });
  assert.equal(outcome.status, "completed");
  assert.equal(record.ai.length, 21);
});

test("normal execution does not stop after 60 tool calls", async () => {
  const { outcome } = await harness({
    payload: v2(),
    ai: (_b, n) => (n <= 15 ? toolReply([1, 2, 3, 4, 5].map((i) => writeCall(`t${n}_${i}`))) : textReply("finished")),
  });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.body.tool_calls, 75);
});

test("emergency tool-call guard checkpoints and hands off, never completes", async () => {
  const { outcome, record } = await harness({ payload: v2(), env: { EMERGENCY_MAX_TOOL_CALLS_PER_HOP: "3" }, ai: (_b, n) => toolReply([writeCall(`e${n}a`), writeCall(`e${n}b`)]) });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "emergency_guard_tool_calls");
  assert.ok(finalCallback(record).checkpoint_ref);
  assert.equal(outcome.body.tool_calls, 3);
});

test("emergency model-round guard hands off", async () => {
  const { outcome } = await harness({ payload: v2(), env: { EMERGENCY_MAX_MODEL_ROUNDS_PER_HOP: "2" }, ai: (_b, n) => toolReply([writeCall(`m${n}`)]) });
  assert.equal(outcome.stopReason, "emergency_guard_model_rounds");
  assert.equal(outcome.status, "handoff_pending");
});

test("dynamic tool invocation forwards application/capability scope from the definition only", async () => {
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("search_items", { application_id: "app_a", capability: "items.read", mutating: false })] },
    ai: (_b, n) => (n === 1 ? toolReply([{ id: "c1", name: "search_items", args: { query: "docs" } }]) : textReply("ok")),
    broker: () => json(200, { ok: true, result: { items: [1] } }),
  });
  assert.equal(outcome.status, "completed");
  const request = record.broker[0].body;
  assert.equal(request.application_id, "app_a");
  assert.equal(request.capability, "items.read");
  assert.equal(request.execution_id, "exec-1");
  assert.equal(request.action_key, "task-1:exec-1:c1");
  assert.equal(record.broker[0].headers["idempotency-key"], "task-1:exec-1:c1");
  assert.ok(!JSON.stringify(record.ai[0].tools).includes("x-longrun"), "metadata stripped from model tools");
});

test("wrong application capability is rejected by the gateway and model-supplied scope cannot override it", async () => {
  const { record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("read_calendar", { application_id: "calendar", capability: "calendar.read", mutating: false }, { query: { type: "string" }, application_id: { type: "string" } })] },
    ai: (_b, n) => (n === 1 ? toolReply([{ id: "c1", name: "read_calendar", args: { query: "x", application_id: "mail" } }]) : textReply("ok")),
    broker: (body) => (body.application_id !== "calendar" ? json(200, { ok: true }) : json(403, { ok: false, error: { code: "capability_mismatch", message: "Capability does not authorize this application." } })),
  });
  assert.equal(record.broker[0].body.application_id, "calendar");
  assert.equal(toolResults(record)[0].content.error.code, "capability_mismatch");
});

test("unauthorized tool is returned to the model as a tool error", async () => {
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("delete_all", { application_id: "x", capability: "x.admin" })] },
    ai: (_b, n) => (n === 1 ? toolReply([{ id: "c1", name: "delete_all", args: {} }]) : textReply("could not")),
    broker: () => json(403, { ok: false, error: { code: "tool_not_allowed", message: "Not granted." } }),
  });
  assert.equal(outcome.status, "completed");
  assert.equal(toolResults(record)[0].content.error.code, "tool_not_allowed");
});

test("expired grant pauses for the user before any work", async () => {
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("t")], tool_broker: undefined },
    ai: () => textReply("no"),
  }).catch((error) => { throw error; });
  assert.equal(outcome.status, "completed"); // sanity: no expiry configured
  const expired = await harness({
    payload: { ...v2(), tools: [gatewayTool("t")], tool_broker: { app_user_id: "user-1", grant_expires_at: "2000-01-01T00:00:00Z", authorization_grant_encrypted: (await import("../worker/grant.mjs")).encryptGrant("broker-shared-SECRET-abcdef1234567890", "task-1", "user-1", "g") } },
    ai: () => textReply("no"),
  });
  assert.equal(expired.outcome.status, "paused_for_user");
  assert.equal(expired.outcome.stopReason, "authorization_expired");
  assert.equal(expired.record.ai.length, 0);
  void record;
});

test("gateway grant_expired response pauses for the user with a checkpoint", async () => {
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("t", { mutating: false })] },
    ai: () => toolReply([{ id: "c1", name: "t", args: {} }, { id: "c2", name: "t", args: {} }]),
    broker: () => json(401, { ok: false, error: { code: "grant_expired", message: "Grant expired." } }),
  });
  assert.equal(outcome.status, "paused_for_user");
  assert.equal(record.broker.length, 1);
  assert.ok(finalCallback(record).checkpoint_ref);
});

test("malformed arguments are rejected before reaching the gateway", async () => {
  const { record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("t", {}, { query: { type: "string" } }, ["query"])] },
    ai: (_b, n) => (n === 1 ? toolReply([{ id: "c1", name: "t", args: "{not json" }, { id: "c2", name: "t", args: { query: 5 } }, { id: "c3", name: "t", args: {} }]) : textReply("ok")),
    broker: () => { throw new Error("gateway must not be called"); },
  });
  assert.equal(record.broker.length, 0);
  assert.deepEqual(toolResults(record).map((r) => r.content.error.code), ["invalid_arguments", "invalid_arguments", "invalid_arguments"]);
});

test("unknown tool is handled safely", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    ai: (_b, n) => (n === 1 ? toolReply([{ id: "c1", name: "launch_rocket", args: {} }]) : textReply("ok")),
  });
  assert.equal(outcome.status, "completed");
  assert.equal(toolResults(record)[0].content.error.code, "unknown_tool");
});
