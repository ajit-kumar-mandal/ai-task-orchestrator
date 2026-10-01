import { HARD } from "./config.mjs";
import { fail } from "./errors.mjs";
import { scratchToolDefinitions } from "./scratch.mjs";
import { runCommandDefinition } from "./commands.mjs";

// Application-agnostic tool registry. Tools come from the dispatch payload
// (Study AI decides what is published). Optional "x-longrun" metadata carries
// application_id / capability / mutating for gateway scoping and is stripped
// before tools are sent to the model.
export const RESERVED_TOOLS = new Set(["scratch_list", "scratch_read", "scratch_write", "scratch_mkdir", "scratch_stat", "run_command"]);

function metadata(tool) {
  const meta = tool["x-longrun"] ?? {};
  if (typeof meta !== "object" || Array.isArray(meta)) fail("x-longrun tool metadata must be an object.");
  if (meta.application_id !== undefined && (typeof meta.application_id !== "string" || !/^[\w.:-]{1,120}$/.test(meta.application_id))) fail("x-longrun.application_id is invalid.");
  if (meta.capability !== undefined && (typeof meta.capability !== "string" || !/^[\w.:/-]{1,160}$/.test(meta.capability))) fail("x-longrun.capability is invalid.");
  if (meta.mutating !== undefined && typeof meta.mutating !== "boolean") fail("x-longrun.mutating must be boolean.");
  // Unknown side effects are treated as mutating: never auto-retried.
  return { application_id: meta.application_id ?? null, capability: meta.capability ?? null, mutating: meta.mutating ?? true };
}

export function buildToolRegistry(payload, commandsEnabled) {
  const custom = payload.tools || [];
  if (custom.length > HARD.MAX_TOOLS) fail(`A task may define no more than ${HARD.MAX_TOOLS} tools.`);
  const index = new Map();
  const forModel = [];
  for (const def of scratchToolDefinitions()) { index.set(def.function.name, { kind: "scratch", parameters: def.function.parameters, meta: { application_id: null, capability: "scratch", mutating: false } }); forModel.push(def); }
  if (commandsEnabled) { const def = runCommandDefinition(); index.set("run_command", { kind: "command", parameters: def.function.parameters, meta: { application_id: null, capability: "command", mutating: false } }); forModel.push(def); }
  for (const tool of custom) {
    if (!tool || tool.type !== "function" || !tool.function || typeof tool.function.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) fail("Each tool must use the function tool format with a valid name.");
    const name = tool.function.name;
    if (RESERVED_TOOLS.has(name)) fail(`Tool name ${name} is reserved by the worker.`);
    if (index.has(name)) fail(`Duplicate tool name: ${name}.`);
    index.set(name, { kind: "gateway", parameters: tool.function.parameters ?? null, meta: metadata(tool) });
    const { "x-longrun": _omit, ...clean } = tool;
    forModel.push(clean);
  }
  return { index, forModel };
}

const typeOk = (type, value) => ({
  string: typeof value === "string",
  number: typeof value === "number" && Number.isFinite(value),
  integer: Number.isSafeInteger(value),
  boolean: typeof value === "boolean",
  array: Array.isArray(value),
  object: value !== null && typeof value === "object" && !Array.isArray(value),
  null: value === null,
})[type] ?? true;

// Minimal structural check. The gateway remains the authoritative validator.
export function validateArguments(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "Tool arguments must be a JSON object.";
  if (!schema || typeof schema !== "object") return null;
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) if (!(key in args)) return `Missing required argument: ${key}.`;
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) { if (schema.additionalProperties === false) return `Unexpected argument: ${key}.`; continue; }
    const types = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
    if (types.length && !types.some((type) => typeOk(type, value))) return `Argument ${key} must be of type ${types.join(" or ")}.`;
    if (property.enum && !property.enum.includes(value)) return `Argument ${key} is not an allowed value.`;
  }
  return null;
}
