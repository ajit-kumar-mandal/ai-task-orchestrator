import { lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { HARD } from "./config.mjs";
import { fail, FailureCategory } from "./errors.mjs";

// Temporary per-execution workspace. Never durable task state.
const toolFail = (message, code = "scratch_error") => fail(message, { category: FailureCategory.TOOL_FAILURE, code });

export function scratchLimits(payload, env) {
  const rawBytes = Number(payload.storage?.max_bytes ?? env.TASK_STORAGE_MAX_BYTES ?? HARD.DEFAULT_STORAGE_BYTES);
  const rawFiles = Number(payload.storage?.max_files ?? env.TASK_STORAGE_MAX_FILES ?? HARD.DEFAULT_STORAGE_FILES);
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 1 || rawBytes > HARD.MAX_STORAGE_BYTES) fail(`storage.max_bytes must be from 1 to ${HARD.MAX_STORAGE_BYTES} bytes.`);
  if (!Number.isSafeInteger(rawFiles) || rawFiles < 1 || rawFiles > HARD.MAX_STORAGE_FILES) fail(`storage.max_files must be from 1 to ${HARD.MAX_STORAGE_FILES}.`);
  return { maxBytes: rawBytes, maxFiles: rawFiles };
}

export async function createScratchSpace(payload, limits, env) {
  const base = resolve(env.TASK_STORAGE_BASE?.trim() || tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "longrun-task-"));
  const requested = payload.storage?.path;
  let workingRoot = root;
  if (requested !== undefined && requested !== "") {
    if (typeof requested !== "string" || requested.includes("\0")) { await rm(root, { recursive: true, force: true }); fail("storage.path must be a safe relative folder name."); }
    const destination = resolve(root, requested);
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) { await rm(root, { recursive: true, force: true }); fail("storage.path must stay within the task's temporary workspace."); }
    await mkdir(destination, { recursive: true });
    workingRoot = destination;
  }
  return { root: workingRoot, cleanupRoot: root, limits };
}

export const cleanupScratch = (scratch) => rm(scratch.cleanupRoot, { recursive: true, force: true });

export function scratchPath(root, path) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) toolFail("A non-empty scratch-file path is required.", "invalid_path");
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) toolFail("Scratch file paths must stay inside the task workspace.", "path_traversal");
  return resolved;
}

export async function rejectScratchSymlinks(root, target) {
  let current = root;
  for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) toolFail("Symbolic links are not allowed in task scratch storage.", "symlink_rejected");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function inspectScratch(root) {
  let bytes = 0;
  let files = 0;
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) toolFail("Symbolic links are not allowed in task scratch storage.", "symlink_rejected");
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) { files += 1; bytes += (await stat(path)).size; }
    }
  };
  await walk(root);
  return { bytes, files };
}

// Reject before writing so limits are never exceeded on disk.
async function ensureCapacity(scratch, path, newBytes) {
  const usage = await inspectScratch(scratch.root);
  const existing = await stat(path).catch(() => null);
  const bytes = usage.bytes - (existing?.isFile() ? existing.size : 0) + newBytes;
  const files = usage.files + (existing ? 0 : 1);
  if (bytes > scratch.limits.maxBytes || files > scratch.limits.maxFiles) toolFail("Task scratch storage limit reached; raise storage.max_bytes or storage.max_files within the repository cap.", "storage_limit");
}

const SENSITIVE_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dockercfg|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;
export const isSensitiveFilename = (name) => SENSITIVE_NAME.test(basename(String(name)));

async function writeScratchFile(scratch, relativePath, content) {
  const path = scratchPath(scratch.root, relativePath);
  const parent = resolve(path, "..");
  await rejectScratchSymlinks(scratch.root, parent);
  await rejectScratchSymlinks(scratch.root, path);
  await ensureCapacity(scratch, path, Buffer.byteLength(content));
  await mkdir(parent, { recursive: true });
  await rejectScratchSymlinks(scratch.root, path);
  await writeFile(path, content, { flag: "w" });
  return path;
}

export async function scratchTool(name, input, scratch) {
  if (name === "scratch_list") {
    const path = scratchPath(scratch.root, input.path || ".");
    await rejectScratchSymlinks(scratch.root, path);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) toolFail("The requested scratch folder does not exist.", "not_found");
    const entries = await readdir(path, { withFileTypes: true });
    return JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })));
  }
  const path = scratchPath(scratch.root, input.path);
  const relative = path.slice(scratch.root.length + 1);
  if (name === "scratch_read") {
    await rejectScratchSymlinks(scratch.root, path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) toolFail("The requested scratch file does not exist.", "not_found");
    if (info.size > HARD.MAX_TOOL_RESULT_BYTES) toolFail("The requested file is too large to return as a tool result.", "too_large");
    return readFile(path, "utf8");
  }
  if (name === "scratch_write") {
    const content = typeof input.content === "string" ? input.content : typeof input.content_base64 === "string" ? Buffer.from(input.content_base64, "base64") : null;
    if (content === null) toolFail("scratch_write requires text content or content_base64.", "invalid_arguments");
    await writeScratchFile(scratch, input.path, content);
    return JSON.stringify({ saved: true, path: relative, ...(await inspectScratch(scratch.root)) });
  }
  if (name === "scratch_mkdir") {
    await rejectScratchSymlinks(scratch.root, path);
    await mkdir(path, { recursive: true });
    return JSON.stringify({ created: true, path: relative });
  }
  if (name === "scratch_stat") {
    await rejectScratchSymlinks(scratch.root, path);
    const info = await stat(path).catch(() => null);
    if (!info) return JSON.stringify({ exists: false });
    return JSON.stringify({ exists: true, type: info.isDirectory() ? "directory" : "file", size: info.size, ...(await inspectScratch(scratch.root)) });
  }
  return toolFail(`Unsupported scratch tool: ${name}.`, "unknown_tool");
}

export function scratchToolDefinitions() {
  const define = (name, description, properties, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
  const path = { type: "string", description: "Relative path inside this execution's temporary workspace." };
  return [
    define("scratch_list", "List names and types in a temporary folder.", { path }),
    define("scratch_read", "Read a UTF-8 text file from temporary task storage.", { path }, ["path"]),
    define("scratch_write", "Create or replace a text file (content) or binary file (content_base64) in temporary task storage.", { path, content: { type: "string" }, content_base64: { type: "string" } }, ["path"]),
    define("scratch_mkdir", "Create a folder in temporary task storage.", { path }, ["path"]),
    define("scratch_stat", "Inspect a temporary file or folder and current storage use.", { path }, ["path"]),
  ];
}

// Attachments sent to the tool gateway. Sensitive filenames are never uploaded.
export async function readAttachment(scratch, file) {
  if (!file || typeof file.path !== "string") toolFail("Each tool attachment must include a scratch-file path.", "invalid_arguments");
  if (isSensitiveFilename(file.path) || (typeof file.name === "string" && isSensitiveFilename(file.name))) toolFail("Credential-like files cannot be attached to tool calls.", "sensitive_file");
  const path = scratchPath(scratch.root, file.path);
  await rejectScratchSymlinks(scratch.root, path);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) toolFail("A tool attachment must refer to a regular task scratch file.", "not_found");
  if (info.size > HARD.MAX_TOOL_RESULT_BYTES) toolFail("A single tool attachment exceeds the supported size limit.", "too_large");
  const bytes = await readFile(path);
  return {
    path: file.path,
    name: typeof file.name === "string" ? file.name.slice(0, 180) : basename(file.path),
    content_type: typeof file.content_type === "string" ? file.content_type.slice(0, 160) : "application/octet-stream",
    content_base64: bytes.toString("base64"),
  };
}

export async function saveReturnedFile(scratch, file) {
  if (!file || typeof file.path !== "string" || typeof file.content_base64 !== "string") toolFail("The tool gateway returned an invalid file attachment.", "invalid_broker_file");
  const bytes = Buffer.from(file.content_base64, "base64");
  if (bytes.byteLength > HARD.MAX_TOOL_RESULT_BYTES) toolFail("A returned file exceeds the supported size limit.", "too_large");
  await writeScratchFile(scratch, file.path, bytes);
}
