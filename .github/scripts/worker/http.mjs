import { backoffMs } from "./config.mjs";
import { FailureCategory, WorkerError, leaseLost } from "./errors.mjs";

// JSON request to a Study AI endpoint (callback / checkpoint). Only used for
// idempotent operations, so 429/5xx/network failures are retried with the same
// body and idempotency key. 409 always means lease fencing.
export async function sendJson({ method = "POST", url, headers = {}, body, fetchImpl, sleep, timeoutMs, maxAttempts, label }) {
  let lastStatus;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url.toString(), { method, redirect: "error", headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body, signal: controller.signal });
    } catch {
      lastStatus = undefined;
      if (timer) clearTimeout(timer);
      if (attempt < maxAttempts - 1) { await sleep(backoffMs(attempt)); continue; }
      break;
    }
    if (timer) clearTimeout(timer);
    if (response.status === 409) throw leaseLost();
    const text = await response.text().catch(() => "");
    if (response.ok) {
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json, attempts: attempt + 1 };
    }
    lastStatus = response.status;
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxAttempts - 1) { await sleep(backoffMs(attempt)); continue; }
      break;
    }
    throw new WorkerError(`${label} returned HTTP ${response.status}.`, { category: FailureCategory.TERMINAL, httpStatus: response.status });
  }
  throw new WorkerError(`${label} was unavailable after ${maxAttempts} attempts.`, { category: FailureCategory.TRANSIENT, httpStatus: lastStatus });
}
