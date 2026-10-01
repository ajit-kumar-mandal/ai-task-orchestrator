import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const MAX_ATTEMPTS = 3;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TOOL_ROUNDS = 12;
const MAX_TOOL_CALLS = 60;
const MAX_TOOL_RESULT_BYTES = 1_000_000;
const MAX_DISPATCH_BYTES = 900_000;
const MAX_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_STORAGE_FILES = 10_000;
const DEFAULT_STORAGE_BYTES = 512 * 1024 * 1024;
const DEFAULT_STORAGE_FILES = 1_000;
const BLOCKED_COMMANDS = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);

const fail = (message) => { throw new Error(message); };

function safeMessage(message, ...secrets) {
  let cleaned = String(message || "The task failed.");
  for (const secret of secrets) if (secret) cleaned = cleaned.replaceAll(secret, "[redacted]");
  return cleaned.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1000) || "The task failed.";
}

function parsePayload() {
  const raw = process.env.TASK_PAYLOAD || "{}";
  if (Buffer.byteLength(raw) > MAX_DISPATCH_BYTES) fail("The dispatch payload exceeds the supported size limit.");
  let payload;
  try { payload = JSON.parse(raw); } catch { fail("The dispatch payload is not valid JSON."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("The dispatch payload must be a JSON object.");
  if (typeof payload.task_id !== "string" || !/^[\w.:/-]{1,180}$/.test(payload.task_id)) fail("A task_id containing 1–180 letters, numbers, or . _ : / - is required.");
  if (typeof payload.input !== "string" || !payload.input.trim()) fail("A non-empty input prompt is required.");
  if (payload.input.length > MAX_PROMPT_LENGTH) fail(`The input prompt must be no longer than ${MAX_PROMPT_LENGTH} characters.`);
  if (payload.callback_url && typeof payload.callback_url !== "string") fail("callback_url must be a string.");
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) fail("tools must be a list of tool definitions.");
  if (payload.tool_broker !== undefined && (!payload.tool_broker || typeof payload.tool_broker !== "object" || Array.isArray(payload.tool_broker))) fail("tool_broker must contain an app broker URL and authorized-user context.");
  if (payload.storage !== undefined && (!payload.storage || typeof payload.storage !== "object" || Array.isArray(payload.storage))) fail("storage must contain temporary scratch-space limits.");
  if (payload.execution !== undefined && (!payload.execution || typeof payload.execution !== "object" || Array.isArray(payload.execution))) fail("execution must contain an explicit command allowlist.");
  return payload;
}

function getEndpoints() {
  const raw = process.env.AI_API_BASE_URL?.trim();
  if (!raw) fail("Configure the AI_API_BASE_URL repository variable.");
  let base;
  try { base = new URL(raw); } catch { fail("AI_API_BASE_URL must be a valid HTTPS URL ending in /v1."); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) fail("AI_API_BASE_URL must be an HTTPS URL without embedded credentials or query parameters.");
  const path = base.pathname.replace(/\/+$/, "");
  const chatUrl = /\/chat\/completions$/.test(path) ? base.toString() : `${base.origin}${path}/chat/completions`;
  return { chatUrl };
}

function validateCallback(payload) {
  if (!payload.callback_url) return null;
  let callback;
  try { callback = new URL(payload.callback_url); } catch { fail("callback_url must be a valid HTTPS URL."); }
  if (callback.protocol !== "https:" || callback.username || callback.password) fail("callback_url must use HTTPS and must not contain embedded credentials.");
  const allowlist = (process.env.CALLBACK_ALLOWED_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.length) fail("Configure CALLBACK_ALLOWED_HOSTS with the hostname allowed to receive results.");
  if (!allowlist.includes(callback.hostname.toLowerCase())) fail("callback_url host is not included in CALLBACK_ALLOWED_HOSTS.");
  return callback;
}

function validateBroker(payload) {
  if (!payload.tools?.length) return null;
  const broker = payload.tool_broker;
  const brokerUrl = typeof broker?.url === "string" ? broker.url : process.env.TOOL_BROKER_URL?.trim();
  if (!broker || typeof brokerUrl !== "string" || typeof broker.app_user_id !== "string" || !/^[\w-]{1,200}$/.test(broker.app_user_id)) {
    fail("Tool calling requires a configured app tool-broker URL and the authenticated app user's stable app_user_id.");
  }
  let url;
  try { url = new URL(brokerUrl); } catch { fail("The app tool-broker URL must be a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("tool_broker.url must be HTTPS without credentials, query parameters, or fragments.");
  const allowedHosts = (process.env.TOOL_BROKER_ALLOWED_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowedHosts.length || !allowedHosts.includes(url.hostname.toLowerCase())) fail("Add the app broker hostname to the TOOL_BROKER_ALLOWED_HOSTS repository variable.");
  const authToken = typeof broker.auth_token === "string" ? broker.auth_token : "";
  if (!authToken) fail("tool_broker.auth_token is required; pass a short-lived, task-scoped app credential.");
  return { url, appUserId: broker.app_user_id, authToken };
}

function buildMessages(payload, scratch, context = []) {
  const messages = [];
  const customSystem = typeof payload.system === "string" ? payload.system.trim() : "";
  const scratchInstructions = `Task-scoped temporary workspace: ${scratch.root}. Use the scratch tool to read/write files. This workspace is deleted after the task. Never assume files or secrets are retained between jobs.`;
  messages.push({ role: "system", content: [customSystem, scratchInstructions].filter(Boolean).join("\n\n") });
  messages.push({ role: "user", content: payload.input });
  messages.push(...context);
  return messages;
}

function retryAfterMs(response, attempt) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const dateMs = Date.parse(header) - Date.now();
    const delay = Number.isFinite(seconds) ? seconds * 1000 : dateMs;
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, MAX_RETRY_DELAY_MS);
  }
  const exponential = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

async function responseError(response, apiKey) {
  let message = `AI API returned HTTP ${response.status}.`;
  try { const body = await response.json(); message = body?.error?.message || body?.message || message; } catch { /* keep status message */ }
  return { message: safeMessage(message, apiKey), status: response.status };
}

async function readEventStream(body, apiKey) {
  if (!body) fail("The AI API returned an empty response stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let refusal = "";
  let wasRefused = false;
  let usage = null;
  let toolCalls = new Map();
  let streamError = null;
  let streamErrorStatus;

  const consumeFrame = (frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { streamError = "The AI API returned an invalid streaming response."; return; }
    if (event.error) {
      streamError = safeMessage(event.error.message || "The AI stream ended with an error.", apiKey);
      const upstreamStatus = Number(event.error.upstream_http_status || event.error.http_status || event.error.status);
      if (Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599) streamErrorStatus = upstreamStatus;
      return;
    }
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === "string") text += delta.content;
    if (Array.isArray(delta?.content)) for (const part of delta.content) if (typeof part?.text === "string") text += part.text;
    if (typeof delta?.refusal === "string") refusal += delta.refusal;
    if (typeof choice?.message?.refusal === "string") refusal += choice.message.refusal;
    if (choice?.finish_reason === "refusal") wasRefused = true;
    for (const part of delta?.tool_calls || []) {
      const index = part.index ?? 0;
      const existing = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (part.id) existing.id = part.id;
      if (part.type) existing.type = part.type;
      if (part.function?.name) existing.function.name += part.function.name;
      if (part.function?.arguments) existing.function.arguments += part.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice?.message?.tool_calls?.length) {
      toolCalls = new Map(choice.message.tool_calls.map((part, index) => [index, part]));
    }
    if (event.usage) usage = event.usage;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (streamError) throw Object.assign(new Error(streamError), { httpStatus: streamErrorStatus });
  return { text, refusal, wasRefused, usage, toolCalls: [...toolCalls.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) };
}

function configuredTools(payload) {
  const custom = payload.tools || [];
  if (custom.length > 100) fail("A task may define no more than 100 tools.");
  const names = new Set();
  for (const tool of custom) {
    if (!tool || tool.type !== "function" || !tool.function || typeof tool.function.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) fail("Each tool must use the OpenAI-compatible function tool format with a valid name.");
    if (names.has(tool.function.name)) fail(`Duplicate tool name: ${tool.function.name}.`);
    names.add(tool.function.name);
  }
  return custom;
}

function scratchLimits(payload) {
  const rawBytes = Number(payload.storage?.max_bytes ?? process.env.TASK_STORAGE_MAX_BYTES ?? DEFAULT_STORAGE_BYTES);
  const rawFiles = Number(payload.storage?.max_files ?? process.env.TASK_STORAGE_MAX_FILES ?? DEFAULT_STORAGE_FILES);
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 1 || rawBytes > MAX_STORAGE_BYTES) fail(`storage.max_bytes must be from 1 to ${MAX_STORAGE_BYTES} bytes.`);
  if (!Number.isSafeInteger(rawFiles) || rawFiles < 1 || rawFiles > MAX_STORAGE_FILES) fail(`storage.max_files must be from 1 to ${MAX_STORAGE_FILES}.`);
  return { maxBytes: rawBytes, maxFiles: rawFiles };
}

function commandPolicy(payload) {
  const execution = payload.execution;
  if (!execution?.enabled) return null;
  if (!Array.isArray(execution.allowed_commands) || execution.allowed_commands.length === 0 || execution.allowed_commands.length > 20) {
    fail("Enable command execution only with a non-empty allowlist of up to 20 executable names.");
  }
  const allowed = new Set();
  for (const name of execution.allowed_commands) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9._+-]{1,80}$/.test(name) || name.includes("/") || BLOCKED_COMMANDS.has(name.toLowerCase())) {
      fail("Command allowlist entries must be executable names, not paths or shell interpreters.");
    }
    allowed.add(name);
  }
  const timeoutSeconds = Number(execution.timeout_seconds ?? 300);
  const maxOutputBytes = Number(execution.max_output_bytes ?? 64_000);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) fail("execution.timeout_seconds must be from 1 to 900.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_000 || maxOutputBytes > MAX_TOOL_RESULT_BYTES) fail("execution.max_output_bytes must be from 1000 to 1000000.");
  return { allowed, timeoutSeconds, maxOutputBytes };
}

async function createScratchSpace(payload, limits) {
  const basePath = process.env.TASK_STORAGE_BASE?.trim() || tmpdir();
  const base = resolve(basePath);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "longrun-task-"));
  const requested = payload.storage?.path;
  let workingRoot = root;
  if (requested !== undefined && requested !== "") {
    if (typeof requested !== "string" || requested.includes("\0")) fail("storage.path must be a safe relative folder name.");
    const destination = resolve(root, requested);
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) fail("storage.path must stay within the task's temporary workspace.");
    await mkdir(destination, { recursive: true });
    workingRoot = destination;
  }
  return { root: workingRoot, cleanupRoot: root, limits };
}

function scratchPath(root, path) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) fail("A non-empty scratch-file path is required.");
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) fail("Scratch file paths must stay inside the task workspace.");
  return resolved;
}

async function inspectScratch(root, limits, target = root) {
  let bytes = 0;
  let files = 0;
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) fail("Symbolic links are not allowed in task scratch storage.");
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
        if (files > limits.maxFiles || bytes > limits.maxBytes) fail("Task scratch storage limit exceeded; raise this task's storage.max_bytes or storage.max_files within the repository cap.");
      }
    }
  };
  await walk(target);
  return { bytes, files };
}

async function scratchTool(call, scratch) {
  let input;
  try { input = JSON.parse(call.function.arguments || "{}"); } catch { fail(`Scratch tool call ${call.function.name} has invalid JSON arguments.`); }
  if (call.function.name === "scratch_list") {
    const path = scratchPath(scratch.root, input.path || ".");
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) fail("The requested scratch folder does not exist.");
    const entries = await readdir(path, { withFileTypes: true });
    return JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })));
  }
  const path = scratchPath(scratch.root, input.path);
  if (call.function.name === "scratch_read") {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_TOOL_RESULT_BYTES) fail("The requested file is too large to return as a tool result.");
    return text;
  }
  if (call.function.name === "scratch_write") {
    const content = typeof input.content === "string" ? input.content : typeof input.content_base64 === "string" ? Buffer.from(input.content_base64, "base64") : null;
    if (content === null) fail("scratch_write requires text content or content_base64.");
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, { flag: "w" });
    const usage = await inspectScratch(scratch.root, scratch.limits);
    return JSON.stringify({ saved: true, path: resolve(scratch.root, path).slice(scratch.root.length + 1), ...usage });
  }
  if (call.function.name === "scratch_mkdir") {
    await mkdir(path, { recursive: true });
    return JSON.stringify({ created: true, path: resolve(scratch.root, path).slice(scratch.root.length + 1) });
  }
  if (call.function.name === "scratch_stat") {
    const info = await stat(path).catch(() => null);
    if (!info) return JSON.stringify({ exists: false });
    const usage = await inspectScratch(scratch.root, scratch.limits);
    return JSON.stringify({ exists: true, type: info.isDirectory() ? "directory" : "file", size: info.size, ...usage });
  }
  fail(`Unsupported scratch tool: ${call.function.name}.`);
}

async function runCommand(call, scratch, policy) {
  if (!policy) fail("Command execution was not explicitly enabled for this task.");
  let input;
  try { input = JSON.parse(call.function.arguments || "{}"); } catch { fail("The command tool call has invalid JSON arguments."); }
  if (typeof input.command !== "string" || !policy.allowed.has(input.command)) fail("The requested executable is not in this task's command allowlist.");
  if (BLOCKED_COMMANDS.has(input.command.toLowerCase())) fail("Shell interpreters cannot be run by the task command tool.");
  if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some((arg) => typeof arg !== "string" || arg.length > 20_000)) fail("Command arguments must be a list of at most 100 strings.");
  const cwd = scratchPath(scratch.root, input.cwd || ".");
  const directory = await stat(cwd).catch(() => null);
  if (!directory?.isDirectory()) fail("The requested command working directory does not exist.");
  const timeoutSeconds = Math.min(policy.timeoutSeconds, Number.isSafeInteger(input.timeout_seconds) ? Math.max(1, input.timeout_seconds) : policy.timeoutSeconds);
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: scratch.root,
    TMPDIR: scratch.root,
    TMP: scratch.root,
    TEMP: scratch.root,
    CI: "1",
    PIP_CACHE_DIR: join(scratch.root, ".cache", "pip"),
    NPM_CONFIG_CACHE: join(scratch.root, ".cache", "npm"),
  };
  await mkdir(env.PIP_CACHE_DIR, { recursive: true });
  await mkdir(env.NPM_CONFIG_CACHE, { recursive: true });
  const result = await new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(input.command, input.args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`Could not start the allowlisted command: ${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let timedOut = false;
    let tooMuchOutput = false;
    const append = (current, chunk) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > policy.maxOutputBytes) {
        tooMuchOutput = true;
        child.kill("SIGKILL");
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => reject(new Error(`Could not start the allowlisted command: ${error.message}`)));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutSeconds * 1000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, timedOut, tooMuchOutput, stdout, stderr });
    });
  });
  const safeOutput = safeMessage([result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(no output)", process.env.AI_API_KEY, process.env.TOOL_BROKER_TOKEN, process.env.CALLBACK_TOKEN);
  const storage = await inspectScratch(scratch.root, scratch.limits);
  if (result.timedOut) fail(`Command exceeded its ${timeoutSeconds}-second task limit. Partial output: ${safeOutput}`);
  if (result.tooMuchOutput) fail(`Command exceeded its ${policy.maxOutputBytes}-byte output limit. Partial output: ${safeOutput}`);
  if (result.code !== 0) fail(`Allowlisted command exited with code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}. Output: ${safeOutput}`);
  return JSON.stringify({ exit_code: result.code, output: safeOutput, storage });
}

function scratchTools(commandEnabled) {
  const define = (name, description, properties, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
  const path = { type: "string", description: "Relative path inside this task's temporary workspace." };
  const tools = [
    define("scratch_list", "List names and types in a temporary folder.", { path }, []),
    define("scratch_read", "Read a UTF-8 text file from temporary task storage.", { path }, ["path"]),
    define("scratch_write", "Create or replace a UTF-8 text file or base64 binary file in temporary task storage. Supply content or content_base64.", { path, content: { type: "string" }, content_base64: { type: "string" } }, ["path"]),
    define("scratch_mkdir", "Create a folder in temporary task storage.", { path }, ["path"]),
    define("scratch_stat", "Inspect a temporary file or folder and current storage use.", { path }, ["path"]),
  ];
  if (commandEnabled) tools.push(define("run_command", "Run one explicitly allowlisted executable with arguments, without a shell, inside task scratch storage. Useful for approved document converters or package managers. No GitHub secrets are passed to the subprocess.", {
    command: { type: "string", description: "An exact executable name from execution.allowed_commands." },
    args: { type: "array", items: { type: "string" }, description: "Arguments passed directly to the executable; no shell expansion." },
    cwd: { type: "string", description: "Optional directory relative to task scratch storage." },
    timeout_seconds: { type: "integer", description: "Optional command timeout, capped by task policy." },
  }, ["command", "args"]));
  return tools;
}

async function callBroker(call, broker, scratch) {
  let args;
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { fail(`Tool ${call.function.name} returned invalid JSON arguments.`); }
  const files = [];
  if (args.files !== undefined && !Array.isArray(args.files)) fail("Tool file attachments must be supplied as a files array.");
  for (const file of args.files || []) {
    if (!file || typeof file.path !== "string") fail("Each tool attachment must include a scratch-file path.");
    const path = scratchPath(scratch.root, file.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail("A tool attachment must refer to a regular task scratch file.");
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_TOOL_RESULT_BYTES) fail("A single tool attachment exceeds the supported size limit.");
    files.push({ path: file.path, name: typeof file.name === "string" ? file.name.slice(0, 180) : file.path.split(/[\\/]/).pop(), content_type: typeof file.content_type === "string" ? file.content_type.slice(0, 160) : "application/octet-stream", content_base64: bytes.toString("base64") });
  }
  const response = await fetch(broker.url, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${process.env.TOOL_BROKER_TOKEN?.trim() || broker.authToken}`,
      ...(process.env.TOOL_BROKER_TOKEN?.trim() ? { "X-Longrun-Task-Token": broker.authToken } : {}),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ protocol: "longrun.tool-broker.v1", task_id: broker.taskId, app_user_id: broker.appUserId, tool_call_id: call.id, name: call.function.name, arguments: args, files }),
  });
  if (!response.ok) {
    const detail = safeMessage(await response.text(), broker.authToken, process.env.AI_API_KEY, process.env.CALLBACK_TOKEN);
    throw Object.assign(new Error(`App tool broker returned HTTP ${response.status}: ${detail}`), { httpStatus: response.status });
  }
  const result = await response.json();
  if (result?.ok === false) fail(safeMessage(result.error?.message || "The app tool broker rejected the tool request.", broker.authToken));
  for (const file of result?.files || []) {
    if (!file || typeof file.path !== "string" || typeof file.content_base64 !== "string") fail("The app tool broker returned an invalid file attachment.");
    const path = scratchPath(scratch.root, file.path);
    const bytes = Buffer.from(file.content_base64, "base64");
    if (bytes.byteLength > MAX_TOOL_RESULT_BYTES) fail("A single broker file attachment exceeds the supported size limit.");
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes, { flag: "w" });
  }
  if (result?.files?.length) await inspectScratch(scratch.root, scratch.limits);
  const serialized = JSON.stringify(result?.result ?? result);
  if (Buffer.byteLength(serialized) > MAX_TOOL_RESULT_BYTES) fail("The app tool broker result exceeds the supported tool-result limit.");
  return serialized;
}

async function runTool(call, broker, scratch, commands) {
  if (call.function.name.startsWith("scratch_")) return scratchTool(call, scratch);
  if (call.function.name === "run_command") return runCommand(call, scratch, commands);
  if (!broker) fail(`Tool ${call.function.name} requires an authorized app tool broker.`);
  return callBroker(call, broker, scratch);
}

async function requestAi(payload, apiKey, chatUrl, model, messages, tools) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(chatUrl, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools, tool_choice: "auto" } : {}) }),
      });
    } catch (error) {
      throw new Error(safeMessage(error?.message || "Could not reach the AI API.", apiKey));
    }
    if (!response.ok) {
      const upstream = await responseError(response, apiKey);
      const blocked = /account|billing|configuration|misconfigured|invalid api key|suspended|disabled/i.test(upstream.message);
      if (!(response.status === 429 || (response.status >= 500 && !blocked)) || attempt === MAX_ATTEMPTS - 1) throw Object.assign(new Error(upstream.message), { httpStatus: upstream.status });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryAfterMs(response, attempt)));
      continue;
    }
    return readEventStream(response.body, apiKey);
  }
  fail("The AI request could not be completed.");
}

async function callAi(payload, apiKey, chatUrl, scratch, broker) {
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : process.env.AI_DEFAULT_MODEL?.trim();
  if (!model) fail("Provide a model in the dispatch payload or configure AI_DEFAULT_MODEL.");
  const customTools = configuredTools(payload);
  const commands = commandPolicy(payload);
  const tools = [...scratchTools(Boolean(commands)), ...customTools];
  const messages = buildMessages(payload, scratch);
  let usage = null;
  let toolCallsRun = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const result = await requestAi(payload, apiKey, chatUrl, model, messages, tools);
    if (result.usage) usage = result.usage;
    if (result.refusal || result.wasRefused) return { model, status: "refused", result: result.refusal || "The AI provider refused this request.", usage };
    if (!result.toolCalls.length) {
      if (!result.text.trim()) fail("The AI API completed without returning a text answer or tool call.");
      return { model, status: "completed", result: result.text, usage, tool_calls: toolCallsRun };
    }
    if (round === MAX_TOOL_ROUNDS) fail(`The task reached the maximum of ${MAX_TOOL_ROUNDS} tool rounds.`);
    messages.push({ role: "assistant", content: result.text || null, tool_calls: result.toolCalls });
    for (const toolCall of result.toolCalls) {
      toolCallsRun += 1;
      if (toolCallsRun > MAX_TOOL_CALLS) fail(`The task reached the maximum of ${MAX_TOOL_CALLS} tool calls.`);
      if (typeof toolCall.id !== "string" || !toolCall.id || typeof toolCall.function?.name !== "string") fail("The AI returned an incomplete tool call.");
      const toolResult = await runTool(toolCall, broker, scratch, commands);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
      console.log(`Task ${payload.task_id}: completed tool ${toolCall.function.name} (${toolCallsRun}/${MAX_TOOL_CALLS}).`);
    }
  }
  fail("The task exceeded the tool-round limit.");
}

async function postCallback(callback, payload, result, secrets) {
  if (!callback) return;
  const response = await fetch(callback, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", "Idempotency-Key": payload.task_id, ...(process.env.CALLBACK_TOKEN ? { Authorization: `Bearer ${process.env.CALLBACK_TOKEN}` } : {}) },
    body: JSON.stringify({ task_id: payload.task_id, ...result }),
  });
  if (!response.ok) throw new Error(`Callback returned HTTP ${response.status}.`);
  console.log(`Callback accepted task ${payload.task_id}.`);
  void secrets;
}

async function main() {
  const payload = parsePayload();
  const callback = validateCallback(payload);
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) fail("Configure the AI_API_KEY repository secret.");
  const { chatUrl } = getEndpoints();
  const broker = validateBroker(payload);
  const limits = scratchLimits(payload);
  const scratch = await createScratchSpace(payload, limits);
  if (broker) broker.taskId = payload.task_id;
  console.log(`Starting task ${payload.task_id}; scratch limit ${scratch.limits.maxBytes} bytes / ${scratch.limits.maxFiles} files.`);
  try {
    const result = await callAi(payload, apiKey, chatUrl, scratch, broker);
    await postCallback(callback, payload, { ...result, storage: { persistence: "temporary", retained: false } }, [apiKey, broker?.authToken]);
    console.log(`Task ${payload.task_id} finished with status ${result.status}.`);
  } catch (error) {
    const message = safeMessage(error?.message, apiKey, broker?.authToken, process.env.CALLBACK_TOKEN);
    try {
      await postCallback(callback, payload, { status: "failed", error: { message, ...(Number.isInteger(error?.httpStatus) ? { upstream_http_status: error.httpStatus } : {}) }, storage: { persistence: "temporary", retained: false } }, [apiKey, broker?.authToken]);
    } catch (callbackError) {
      console.error(safeMessage(callbackError?.message, broker?.authToken, process.env.CALLBACK_TOKEN, apiKey));
    }
    console.error(message);
    process.exitCode = 1;
  } finally {
    await rm(scratch.cleanupRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(safeMessage(error?.message, process.env.AI_API_KEY, process.env.CALLBACK_TOKEN));
  process.exitCode = 1;
});