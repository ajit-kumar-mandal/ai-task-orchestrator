// Central redaction for logs, callbacks, checkpoints and model-visible tool
// results. Registered secrets are removed verbatim; common credential shapes
// are removed by pattern; sensitive object keys are blanked.
const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-longrun-task-token|access_token|refresh_token|id_token|session_token|api_key|apikey|x-api-key|client_secret|secret|password|passwd|private_key|authorization_grant|authorization_grant_encrypted|credentials?|oauth_token)$/i;

const PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]"],
  [/\bv1\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-grant]"],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, "[redacted-key]"],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, "[redacted-oauth]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-github]"],
  [/((?:access|refresh|id)_token|client_secret|api[_-]?key|password|set-cookie|cookie|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1$2[redacted]"],
];

export class Redactor {
  constructor() { this.secrets = new Set(); }

  add(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length >= 6) this.secrets.add(value.trim());
    }
    return this;
  }

  text(input) {
    let output = String(input ?? "");
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) output = output.split(secret).join("[redacted]");
    for (const [pattern, replacement] of PATTERNS) output = output.replace(pattern, replacement);
    return output;
  }

  value(input, depth = 0) {
    if (depth > 64) return "[redacted-depth]";
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.value(item, depth + 1));
    if (input && typeof input === "object") {
      const output = {};
      for (const [key, value] of Object.entries(input)) {
        output[key] = SENSITIVE_KEY.test(key) && value !== null && value !== undefined ? "[redacted]" : this.value(value, depth + 1);
      }
      return output;
    }
    return input;
  }
}
