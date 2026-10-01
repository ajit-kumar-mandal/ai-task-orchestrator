<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project architecture
- The GitHub worker is a stateless per-hop executor; Study AI owns task state, checkpoints, leases, verification and completion, so the worker reports lifecycle and checkpoints instead of deciding task outcomes.
- Worker code lives only under .github/scripts/worker (dependency-free Node 22, tests in .github/scripts/tests); it must never import from src/ so the UI scaffold stays decoupled.
- Per-hop limits are execution-safety settings or EMERGENCY_* guards that trigger checkpoint + handoff; never add logical task limits.
- Mutating tool calls with unknown outcomes are never retried; they are reported with their action_key for Study AI verification.
- Keep the GitHub Actions workflow and dependency-free Node task runner as portable source files; the runner accepts repository-dispatch payloads, reads provider credentials from Actions secrets, and reports completion to the supplied HTTPS callback so users can push this repository and reuse it from another app.
- App-user tool credentials must be AES-256-GCM task/user-bound grants, decrypted only in memory and sent only to the allowlisted app broker; never dispatch long-lived provider credentials.
- Run optional user-requested software only inside SHA-256-pinned, repository-preapproved Docker images with shell disabled, secrets omitted, and task scratch as the sole writable host mount; this limits exposure from arbitrary tool workloads.
