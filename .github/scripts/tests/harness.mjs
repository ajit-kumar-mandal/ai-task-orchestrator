import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecution } from "../worker/worker.mjs";
import { encryptGrant } from "../worker/grant.mjs";

export const SECRETS = {
  AI_API_KEY: "sk-test-AIKEY-1234567890abcdef",
  CALLBACK_TOKEN: "cb-SECRET-token-987654321",
  TOOL_BROKER_TOKEN: "broker-shared-SECRET-abcdef1234567890",
  GRANT_PLAINTEXT: "grant-PLAINTEXT-oauth-xyz-SECRETSECRET",
  OAUTH: "ya29.LEAKLEAKLEAKLEAKLEAK",
};

export const sse = (...events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
export const textReply = (text) => sse({ choices: [{ delta: { content: text } }] }, { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
export const toolReply = (calls) => sse({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}) } })) } }] });
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const hang = (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));

export const gatewayTool = (name, meta = {}, properties = { query: { type: "string" } }, required = []) => ({
  type: "function",
  "x-longrun": meta,
  function: { name, description: `Generic tool ${name}`, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export async function harness({ payload = {}, env = {}, ai, broker, callback, checkpointPost, checkpointStore, now, signal, spawnImpl } = {}) {
  const storageBase = await mkdtemp(join(tmpdir(), "longrun-test-"));
  const record = { ai: [], broker: [], callbacks: [], checkpoints: [], logs: [], fetches: [] };
  const store = checkpointStore ?? new Map();
  const taskId = payload.task_id ?? "task-1";
  const appUserId = payload.tool_broker?.app_user_id ?? "user-1";
  const fullPayload = {
    task_id: taskId,
    input: "Do the task.",
    callback_url: "https://studyai.test/callback",
    ...payload,
  };
  if (fullPayload.tools?.length && !fullPayload.tool_broker) {
    fullPayload.tool_broker = { app_user_id: appUserId, authorization_grant_encrypted: encryptGrant(SECRETS.TOOL_BROKER_TOKEN, taskId, appUserId, SECRETS.GRANT_PLAINTEXT) };
  }
  const fullEnv = {
    AI_API_KEY: SECRETS.AI_API_KEY,
    AI_API_BASE_URL: "https://ai.test/v1",
    AI_DEFAULT_MODEL: "test-model",
    CALLBACK_TOKEN: SECRETS.CALLBACK_TOKEN,
    CALLBACK_ALLOWED_HOSTS: "studyai.test",
    TOOL_BROKER_URL: "https://broker.test/tools",
    TOOL_BROKER_TOKEN: SECRETS.TOOL_BROKER_TOKEN,
    TOOL_BROKER_ALLOWED_HOSTS: "broker.test",
    STUDYAI_CHECKPOINT_URL: "https://studyai.test/checkpoints",
    GITHUB_RUN_ID: "777",
    GITHUB_RUN_ATTEMPT: "1",
    HEARTBEAT_INTERVAL_MS: "999999999",
    TASK_STORAGE_BASE: storageBase,
    PATH: process.env.PATH,
    ...env,
    TASK_PAYLOAD: JSON.stringify(fullPayload),
  };
  for (const [key, value] of Object.entries(fullEnv)) if (value === null) delete fullEnv[key];

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = init.body ? JSON.parse(init.body) : null;
    record.fetches.push({ url: url.toString(), headers, rawBody: init.body ?? "" });
    if (url.host === "ai.test") { record.ai.push(body); return ai(body, record.ai.length, init); }
    if (url.host === "broker.test") { record.broker.push({ body, headers }); return broker(body, headers, record.broker.length, init); }
    if (url.host === "studyai.test" && url.pathname === "/callback") {
      const entry = { body, headers, raw: init.body };
      record.callbacks.push(entry);
      return callback ? callback(body, headers, record.callbacks.length) : json(200, { ok: true });
    }
    if (url.host === "studyai.test" && url.pathname === "/checkpoints") {
      if ((init.method || "GET") === "GET") {
        const checkpoint = store.get(url.searchParams.get("checkpoint_ref"));
        return checkpoint ? json(200, { checkpoint }) : json(404, { error: "not found" });
      }
      record.checkpoints.push({ body, headers });
      const custom = checkpointPost?.(body, headers, record.checkpoints.length);
      if (custom) return custom;
      const ref = `${body.task_id}:${body.checkpoint_version}`;
      store.set(ref, body.checkpoint);
      return json(200, { checkpoint_ref: ref });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const outcome = await runExecution({ env: fullEnv, fetchImpl, sleep: async () => {}, sink: (line) => record.logs.push(line), now, signal, spawnImpl });
  return { outcome, record, store, payload: fullPayload, env: fullEnv };
}

export const finalCallback = (record) => record.callbacks.at(-1)?.body;
export const events = (record) => record.logs.map((line) => JSON.parse(line));
export const allOutput = (record) => [...record.logs, ...record.callbacks.map((entry) => entry.raw), ...record.checkpoints.map((entry) => JSON.stringify(entry.body))].join("\n");
export const v2 = (overrides = {}) => ({ execution: { execution_id: "exec-1", hop_number: 1, lease_version: 1, ...overrides } });
