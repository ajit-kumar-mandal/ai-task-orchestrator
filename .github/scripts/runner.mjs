// Entry point for the GitHub Actions execution worker.
// The worker executes one hop of a Study AI task, then reports completion,
// pause, failure, or checkpoint + handoff. Study AI owns all task state.
import { runExecution } from "./worker/worker.mjs";

const controller = new AbortController();
// GitHub sends SIGINT then SIGTERM when a job is cancelled or times out.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());

try {
  const outcome = await runExecution({ signal: controller.signal });
  process.exitCode = outcome.exitCode;
} catch {
  console.error(JSON.stringify({ longrun_event: "execution_failed", stop_reason: "worker_crash", timestamp: new Date().toISOString() }));
  process.exitCode = 1;
}
