import { HARD } from "./config.mjs";
import { fail } from "./errors.mjs";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parsePayload(raw = "{}") {
  if (Buffer.byteLength(raw) > HARD.MAX_DISPATCH_BYTES) fail("The dispatch payload exceeds the supported size limit.");
  let payload;
  try { payload = JSON.parse(raw); } catch { fail("The dispatch payload is not valid JSON."); }
  if (!isObject(payload)) fail("The dispatch payload must be a JSON object.");
  if (typeof payload.task_id !== "string" || !/^[\w.:/-]{1,180}$/.test(payload.task_id)) fail("A task_id containing 1–180 letters, numbers, or . _ : / - is required.");
  const resuming = isObject(payload.resume);
  if (!resuming && (typeof payload.input !== "string" || !payload.input.trim())) fail("A non-empty input prompt is required.");
  if (typeof payload.input === "string" && payload.input.length > HARD.MAX_PROMPT_LENGTH) fail(`The input prompt must be no longer than ${HARD.MAX_PROMPT_LENGTH} characters.`);
  if (payload.callback_url !== undefined && typeof payload.callback_url !== "string") fail("callback_url must be a string.");
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) fail("tools must be a list of tool definitions.");
  for (const key of ["tool_broker", "storage", "execution", "commands", "resume"]) {
    if (payload[key] !== undefined && !isObject(payload[key])) fail(`${key} must be a JSON object.`);
  }
  return payload;
}

export const hostList = (value) => String(value || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);

export function validateAllowlistedUrl(raw, allowlist, label, { allowQuery = true } = {}) {
  let url;
  try { url = new URL(raw); } catch { fail(`${label} must be a valid HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (!allowQuery && url.search)) fail(`${label} must use HTTPS without embedded credentials${allowQuery ? "" : ", query parameters,"} or fragments.`);
  if (!allowlist.length) fail(`Configure an allowed-host list for ${label}.`);
  if (!allowlist.includes(url.hostname.toLowerCase())) fail(`${label} host is not in its allowed-host list.`);
  return url;
}

export function validateCallbackUrl(raw, env) {
  if (!raw) return null;
  return validateAllowlistedUrl(raw, hostList(env.CALLBACK_ALLOWED_HOSTS), "callback_url");
}

export function validateCheckpointUrl(env) {
  const raw = env.STUDYAI_CHECKPOINT_URL?.trim();
  if (!raw) return null;
  return validateAllowlistedUrl(raw, hostList(env.CHECKPOINT_ALLOWED_HOSTS || env.CALLBACK_ALLOWED_HOSTS), "STUDYAI_CHECKPOINT_URL", { allowQuery: false });
}

export function resolveModelEndpoint(env) {
  const raw = env.AI_API_BASE_URL?.trim();
  if (!raw) fail("Configure the AI_API_BASE_URL repository variable.");
  let base;
  try { base = new URL(raw); } catch { fail("AI_API_BASE_URL must be a valid HTTPS URL ending in /v1."); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) fail("AI_API_BASE_URL must be an HTTPS URL without embedded credentials or query parameters.");
  const path = base.pathname.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(path) ? base.toString() : `${base.origin}${path}/chat/completions`;
}

// task_id + execution_id + hop_number identify one execution. Legacy payloads
// (no execution_id) get a deterministic id derived from the GitHub run.
export function resolveIdentity(payload, env, startedAtMs) {
  const execution = payload.execution ?? {};
  const providerJobId = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || "1"}` : `local-${process.pid}`;
  const v2 = execution.execution_id !== undefined;
  if (v2) {
    if (typeof execution.execution_id !== "string" || !/^[\w.:-]{1,120}$/.test(execution.execution_id)) fail("execution.execution_id must contain 1–120 letters, numbers, or . _ : -.");
    if (!Number.isSafeInteger(execution.hop_number) || execution.hop_number < 1) fail("execution.hop_number must be a positive integer.");
    if (!Number.isSafeInteger(execution.lease_version) || execution.lease_version < 0) fail("execution.lease_version must be a non-negative integer.");
  }
  const checkpointVersion = execution.checkpoint_version ?? 0;
  if (!Number.isSafeInteger(checkpointVersion) || checkpointVersion < 0) fail("execution.checkpoint_version must be a non-negative integer.");
  return {
    protocol: v2 ? "v2" : "legacy",
    task_id: payload.task_id,
    execution_id: v2 ? execution.execution_id : `gha-${providerJobId}`,
    hop_number: v2 ? execution.hop_number : 1,
    lease_version: v2 ? execution.lease_version : 0,
    checkpoint_version: checkpointVersion,
    provider: "github_actions",
    provider_job_id: providerJobId,
    started_at: new Date(startedAtMs).toISOString(),
  };
}

export function validateBroker(payload, env) {
  if (!payload.tools?.length) return null;
  const broker = payload.tool_broker;
  const brokerUrl = typeof broker?.url === "string" ? broker.url : env.TOOL_BROKER_URL?.trim();
  if (!broker || typeof brokerUrl !== "string" || typeof broker.app_user_id !== "string" || !/^[\w-]{1,200}$/.test(broker.app_user_id)) {
    fail("Tool calling requires a configured app tool-broker URL and the authenticated app user's stable app_user_id.");
  }
  const url = validateAllowlistedUrl(brokerUrl, hostList(env.TOOL_BROKER_ALLOWED_HOSTS), "tool broker URL", { allowQuery: false });
  const sharedToken = env.TOOL_BROKER_TOKEN?.trim();
  if (!sharedToken) fail("Configure the TOOL_BROKER_TOKEN Actions secret before enabling app tools.");
  if (typeof broker.authorization_grant_encrypted !== "string") fail("tool_broker.authorization_grant_encrypted is required for app tools.");
  let expiresAtMs = null;
  if (broker.grant_expires_at !== undefined) {
    expiresAtMs = Date.parse(broker.grant_expires_at);
    if (!Number.isFinite(expiresAtMs)) fail("tool_broker.grant_expires_at must be an ISO-8601 timestamp.");
  }
  return { url, appUserId: broker.app_user_id, sharedToken, encryptedGrant: broker.authorization_grant_encrypted, expiresAtMs, expiresAt: broker.grant_expires_at ?? null };
}
