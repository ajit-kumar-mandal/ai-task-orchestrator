import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { HARD } from "./config.mjs";
import { fail, FailureCategory } from "./errors.mjs";
import { scratchPath, inspectScratch } from "./scratch.mjs";

// OPTIONAL isolated command execution. Disabled unless the task enables it.
// Shells and process launchers are always refused; commands run without a
// shell inside a pinned, read-only, network-less (default) container that sees
// only the task scratch folder and receives no worker secrets.
export const BLOCKED_EXECUTABLES = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "ash", "busybox", "cmd", "powershell", "pwsh",
  "env", "xargs", "nohup", "timeout", "nice", "stdbuf", "setsid", "sudo", "su", "doas", "chroot", "script", "expect",
]);
const IMAGE_PATTERN = /^[a-zA-Z0-9._/:+-]+@sha256:[a-f0-9]{64}$/;
const toolFail = (message, code) => fail(message, { category: FailureCategory.TOOL_FAILURE, code });

export function commandPolicy(payload, env) {
  const source = payload.commands ?? (payload.execution?.enabled ? payload.execution : null);
  if (!source?.enabled) return null;
  if (!Array.isArray(source.allowed_commands) || source.allowed_commands.length === 0 || source.allowed_commands.length > 20) fail("Enable command execution only with a non-empty allowlist of up to 20 executable names.");
  const allowed = new Set();
  for (const name of source.allowed_commands) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9._+-]{1,80}$/.test(name) || BLOCKED_EXECUTABLES.has(name.toLowerCase())) fail("Command allowlist entries must be executable names, not paths, shells, or process launchers.");
    allowed.add(name);
  }
  const timeoutSeconds = Number(source.timeout_seconds ?? 300);
  const maxOutputBytes = Number(source.max_output_bytes ?? 64_000);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) fail("commands.timeout_seconds must be from 1 to 3600.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_000 || maxOutputBytes > HARD.MAX_TOOL_RESULT_BYTES) fail("commands.max_output_bytes must be from 1000 to 1000000.");
  const image = source.container_image;
  if (typeof image !== "string" || !IMAGE_PATTERN.test(image)) fail("commands.container_image must be an image pinned to a sha256 digest.");
  const trusted = String(env.TASK_CONTAINER_IMAGES || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!trusted.includes(image)) fail("Add this exact pinned container image to the TASK_CONTAINER_IMAGES repository variable before use.");
  return { allowed, timeoutSeconds, maxOutputBytes, image, networkAccess: source.network_access === true };
}

export function validateCommandCall(input, policy, scratchRoot) {
  if (!policy) toolFail("Command execution was not enabled for this task.", "commands_disabled");
  if (typeof input.command !== "string" || BLOCKED_EXECUTABLES.has(input.command.toLowerCase()) || !policy.allowed.has(input.command)) toolFail("The requested executable is not in this task's command allowlist.", "command_not_allowed");
  if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some((arg) => typeof arg !== "string" || arg.length > 20_000 || arg.includes("\0"))) toolFail("Command arguments must be a list of at most 100 strings without NUL bytes.", "invalid_arguments");
  const cwdHost = scratchPath(scratchRoot, input.cwd || ".");
  const cwdContainer = resolve("/workspace", input.cwd || ".");
  if (cwdContainer !== "/workspace" && !cwdContainer.startsWith("/workspace/")) toolFail("The command working directory must stay inside task scratch storage.", "path_traversal");
  const timeoutSeconds = Math.min(policy.timeoutSeconds, Number.isSafeInteger(input.timeout_seconds) ? Math.max(1, input.timeout_seconds) : policy.timeoutSeconds);
  return { command: input.command, args: [...input.args], cwdHost, cwdContainer, timeoutSeconds };
}

export function buildDockerArgs(policy, call, scratchRoot, uid = 1000, gid = 1000) {
  return [
    "run", "--rm", "--pull=never",
    "--network", policy.networkAccess ? "bridge" : "none",
    "--pids-limit=128", "--memory=1g", "--cpus=2", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user", `${uid}:${gid}`,
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=256m,uid=${uid},gid=${gid}`,
    "--mount", `type=bind,src=${scratchRoot},dst=/workspace,rw`,
    "--workdir", call.cwdContainer,
    "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "CI=1",
    policy.image, call.command, ...call.args,
  ];
}

// Only these variables reach the docker client; no worker secrets.
export const commandChildEnv = (env) => ({ PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", DOCKER_CONFIG: "/tmp/longrun-docker-config" });

export async function runCommand(input, scratch, policy, redactor, env, spawnImpl = spawn) {
  const call = validateCommandCall(input, policy, scratch.root);
  const directory = await stat(call.cwdHost).catch(() => null);
  if (!directory?.isDirectory()) toolFail("The requested command working directory does not exist.", "not_found");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const args = buildDockerArgs(policy, call, scratch.root, uid, gid);
  const result = await new Promise((resolvePromise) => {
    let child;
    try { child = spawnImpl("docker", args, { cwd: scratch.root, env: commandChildEnv(env), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolvePromise({ startError: error.message }); return; }
    let output = "";
    let total = 0;
    let timedOut = false;
    let tooMuch = false;
    const append = (chunk) => {
      total += chunk.byteLength;
      if (total > policy.maxOutputBytes) { tooMuch = true; child.kill("SIGKILL"); return; }
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolvePromise({ startError: error.message }));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, call.timeoutSeconds * 1000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, timedOut, tooMuch, output }); });
  });
  if (result.startError) toolFail(`Could not start the isolated task container: ${redactor.text(result.startError)}`, "container_start_failed");
  const safeOutput = redactor.text(result.output.trim() || "(no output)");
  if (result.timedOut) toolFail(`Command exceeded its ${call.timeoutSeconds}-second limit. Partial output: ${safeOutput}`, "command_timeout");
  if (result.tooMuch) toolFail(`Command exceeded its ${policy.maxOutputBytes}-byte output limit. Partial output: ${safeOutput}`, "output_limit");
  if (result.code !== 0) toolFail(`Isolated command exited with code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}. Output: ${safeOutput}`, "command_failed");
  return JSON.stringify({ exit_code: 0, output: safeOutput, storage: await inspectScratch(scratch.root) });
}

export const runCommandDefinition = () => ({
  type: "function",
  function: {
    name: "run_command",
    description: "Run one allowlisted executable with arguments, without a shell, in an isolated container that sees only task scratch storage.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Exact executable name from the task allowlist." },
        args: { type: "array", items: { type: "string" }, description: "Arguments passed directly; no shell expansion." },
        cwd: { type: "string", description: "Optional directory relative to task scratch storage." },
        timeout_seconds: { type: "integer", description: "Optional timeout, capped by task policy." },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
  },
});
