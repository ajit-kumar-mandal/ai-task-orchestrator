import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, textReply, toolReply, json, finalCallback, gatewayTool, hang, v2 } from "./harness.mjs";
import { Redactor } from "../worker/redact.mjs";

test("regression: checkpoint_and_handoff directive on execution_started hands off without model work", async () => {
  const { outcome, record } = await harness({
    payload: v2(),
    ai: () => { throw new Error("model must not be called"); },
    callback: (body) => json(200, body.event_type === "execution_started" ? { directive: "checkpoint_and_handoff" } : {}),
  });
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "controller_requested_handoff");
  assert.equal(record.ai.length, 0);
});

test("regression: fine-grained GitHub tokens and Google API keys are redacted", () => {
  const r = new Redactor();
  const pat = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
  const google = "AIzaSyA1234567890abcdefghijklmnopqrstuv";
  const out = r.text(`${pat} ${google}`);
  assert.ok(!out.includes(pat) && !out.includes(google));
});

test("cancellation during a mutating tool call lets it drain once, then checkpoints and hands off", async () => {
  const controller = new AbortController();
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("send", { mutating: true })] },
    signal: controller.signal,
    ai: () => toolReply([{ id: "s1", name: "send", args: {} }, { id: "s2", name: "send", args: {} }]),
    broker: async () => { controller.abort(); await new Promise((r) => setTimeout(r, 5)); return json(200, { ok: true, result: "sent" }); },
  });
  assert.equal(record.broker.length, 1, "in-flight call finished, next call not started");
  assert.equal(outcome.status, "handoff_pending");
  assert.equal(outcome.stopReason, "provider_job_cancelled");
  assert.ok(finalCallback(record).checkpoint_ref);
  assert.equal(finalCallback(record).requires_verification, false);
});

test("mutating tool timeout is an unknown outcome and is never replayed", async () => {
  const { outcome, record } = await harness({
    payload: { ...v2(), tools: [gatewayTool("send", { mutating: true })] },
    env: { TOOL_CALL_TIMEOUT_MS: "20" },
    ai: () => toolReply([{ id: "s1", name: "send", args: {} }]),
    broker: (_b, _h, _n, init) => hang(init.signal),
  });
  assert.equal(record.broker.length, 1);
  assert.equal(outcome.stopReason, "unknown_mutation_outcome");
});

test("checkpoint store and broker URLs must be HTTPS and allowlisted", async () => {
  const cp = await harness({ payload: v2(), env: { STUDYAI_CHECKPOINT_URL: "https://evil.test/cp" }, ai: () => textReply("x") });
  assert.equal(cp.outcome.stopReason, "invalid_configuration");
  assert.equal(cp.record.fetches.length, 0);
  const br = await harness({ payload: { ...v2(), tools: [gatewayTool("t")] }, env: { TOOL_BROKER_URL: "http://broker.test/tools" }, ai: () => textReply("x") });
  assert.equal(br.outcome.status, "failed_terminal");
  assert.equal(br.record.ai.length, 0);
  const creds = await harness({ payload: { ...v2(), callback_url: "https://u:p@studyai.test/callback" }, ai: () => textReply("x") });
  assert.equal(creds.outcome.stopReason, "callback_not_allowed");
});

test("command execution stays disabled unless explicitly configured", async () => {
  const { record } = await harness({ payload: v2(), ai: (_b, n) => (n === 1 ? toolReply([{ id: "c1", name: "run_command", args: { command: "ls", args: [] } }]) : textReply("ok")) });
  assert.ok(!record.ai[0].tools.some((t) => t.function.name === "run_command"));
  assert.match(record.ai[1].messages.at(-1).content, /unknown_tool/);
});
