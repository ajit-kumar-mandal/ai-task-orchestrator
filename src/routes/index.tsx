import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Check, Clipboard, Clock3, Command, ExternalLink, Github, LockKeyhole, Radio, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Longrun — GitHub AI task relay" },
      { name: "description", content: "Run long-running, multi-step AI and tool tasks through GitHub Actions, with temporary storage and an app-controlled tool broker." },
      { property: "og:title", content: "Longrun — GitHub AI task relay" },
      { property: "og:description", content: "Run long-running AI workflows with authorized tools, isolated commands, and temporary files." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  const [copied, setCopied] = useState(false);
  const dispatchBody = JSON.stringify({
    event_type: "run-ai-task",
    client_payload: {
      task_id: "task_01J...",
      input: "Read today's email, find the discussion about the documents, create a summary, upload it to Drive, and email me when complete.",
      model: "gpt-4.1",
      callback_url: "https://your-app.example.com/api/ai-complete",
      storage: { max_bytes: 1073741824, max_files: 2500 },
      tool_broker: {
        app_user_id: "AUTHENTICATED_USER_ID",
        authorization_grant_encrypted: "v1.IV.TAG.CIPHERTEXT",
      },
      tools: [
        { type: "function", function: { name: "search_email", description: "Search this user's authorized email.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
        { type: "function", function: { name: "upload_drive_file", description: "Upload a task file to this user's authorized Drive.", parameters: { type: "object", properties: { filename: { type: "string" }, files: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } }, required: ["filename", "files"], additionalProperties: false } } },
        { type: "function", function: { name: "send_email", description: "Email the user after the document is uploaded.", parameters: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"], additionalProperties: false } } },
      ],
    },
  }, null, 2);

  const copyPayload = async () => {
    await navigator.clipboard.writeText(dispatchBody);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="relay-shell">
      <header className="flex h-16 items-center justify-between border-b border-border px-5 md:px-10">
        <a href="#top" className="flex items-center gap-3 text-foreground no-underline" aria-label="Longrun home">
          <span className="flex size-9 items-center justify-center rounded-sm bg-primary text-primary-foreground"><Workflow size={19} /></span>
          <span className="text-lg font-semibold">longrun<span className="text-primary">.</span></span>
        </a>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="hidden items-center gap-2 sm:flex"><span className="size-2 rounded-full bg-primary" /> Ready to configure</span>
          <Button variant="outline" size="sm" asChild><a href="https://github.com" target="_blank" rel="noreferrer"><Github size={15} /> GitHub <ExternalLink size={13} /></a></Button>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-6xl px-5 pb-20 pt-10 md:px-10 md:pt-16">
        <section className="grid gap-10 border-b border-border pb-12 md:grid-cols-[1.15fr_0.85fr] md:items-end md:pb-16">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 border border-border bg-card px-3 py-1.5 text-xs font-medium text-primary"><Radio size={14} /> GITHUB ACTIONS · AI TASK RELAY</div>
            <h1 className="max-w-2xl text-4xl font-semibold leading-[1.06] tracking-tight sm:text-6xl">Let long tasks<br /><span className="text-primary">run their course.</span></h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">Run multi-step AI workflows that search email, create and upload documents, and send follow-up messages through your app's authorized tools.</p>
          </div>
          <div className="relay-grid flex min-h-48 flex-col justify-between border border-border bg-card p-5 sm:p-6">
            <div className="flex items-center justify-between text-xs text-muted-foreground"><span>RUN WINDOW</span><span className="flex items-center gap-1.5"><Clock3 size={14} /> UP TO 6 HOURS</span></div>
            <div className="flex items-end gap-3"><span className="text-6xl font-medium leading-none text-foreground">360</span><span className="pb-1 text-sm text-muted-foreground">minutes per job</span></div>
            <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground"><LockKeyhole size={14} className="text-primary" /> API keys stay in GitHub Actions secrets</div>
          </div>
        </section>

        <section className="grid gap-12 py-12 md:grid-cols-[0.75fr_1.25fr] md:gap-16 md:py-16">
          <div>
            <p className="mb-3 text-xs font-semibold text-primary">01 / CONNECT</p>
            <h2 className="text-2xl font-semibold">Three pieces.<br />One long-running path.</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">Push this repository to GitHub. Add your API settings as repository secrets, then dispatch from your existing app.</p>
            <ol className="mt-8 space-y-0">
              {[
                ["01", "Push to GitHub", "Include the workflow and task runner."],
                ["02", "Add Actions secrets", "Store AI, broker, and callback credentials securely."],
                ["03", "Dispatch a task", "Send a task ID, prompt, tools, and temporary storage limits."],
              ].map(([number, title, description]) => <li key={number} className="flex gap-4 border-t border-border py-4"><span className="relay-code pt-0.5 text-xs text-primary">{number}</span><div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></li>)}
            </ol>
          </div>

          <div className="min-w-0">
            <div className="mb-4 flex items-end justify-between gap-3">
              <div><p className="mb-2 text-xs font-semibold text-primary">02 / DISPATCH</p><h2 className="text-xl font-semibold">Send from your app</h2></div>
              <Button variant="outline" size="sm" onClick={copyPayload} aria-label="Copy dispatch JSON">{copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? "Copied" : "Copy JSON"}</Button>
            </div>
            <pre className="relay-code overflow-x-auto border border-border bg-foreground p-4 text-xs leading-6 text-background sm:p-5"><code>{dispatchBody}</code></pre>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="border-l-2 border-primary pl-3"><div className="text-xs font-semibold">Dispatch event</div><code className="relay-code text-[11px] text-muted-foreground">repository_dispatch · run-ai-task</code></div>
              <div className="border-l-2 border-accent pl-3"><div className="text-xs font-semibold">Callback result</div><code className="relay-code text-[11px] text-muted-foreground">task_id · status · result</code></div>
            </div>
          </div>
        </section>

        <section className="border-y border-border py-12 md:py-14">
          <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div><p className="mb-2 text-xs font-semibold text-primary">03 / CONFIGURE</p><h2 className="text-2xl font-semibold">Keep credentials out of the payload.</h2></div>
            <a href="https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-primary underline underline-offset-4">GitHub secrets guide <ArrowUpRight size={15} /></a>
          </div>
          <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
            {[["AI_API_KEY", "Secret", "Provider key for streamed chat and tool-call responses"], ["TOOL_BROKER_TOKEN", "Secret", "Protects task-bound, user-authorized tool access"], ["TASK_STORAGE_MAX_BYTES", "Variable", "Default temporary space; each task can set its own limit"], ["TASK_CONTAINER_IMAGES", "Variable", "Approved SHA-256-pinned images for isolated commands"]].map(([name, kind, description]) => <div key={name} className="border-t border-border pt-3"><div className="flex items-center justify-between gap-2"><code className="relay-code text-xs font-semibold">{name}</code><span className="text-[10px] uppercase text-muted-foreground">{kind}</span></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p></div>)}
          </div>
        </section>

        <section className="grid gap-8 py-12 md:grid-cols-2 md:items-center md:py-14">
          <div><p className="mb-2 text-xs font-semibold text-primary">04 / CALLBACK</p><h2 className="text-2xl font-semibold">The result comes back to you.</h2><p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">Your callback receives the task ID and either the completed response or a safe error message. Use the task ID to match it to the request in your app.</p></div>
          <div className="relay-code border border-border bg-card p-5 text-xs leading-6"><div className="mb-3 flex items-center gap-2 text-muted-foreground"><ArrowDownRight size={14} className="text-primary" /> POST · application/json</div><pre className="overflow-x-auto">{JSON.stringify({ task_id: "task_01J...", status: "completed", result: "Your generated answer...", usage: { prompt_tokens: 42, completion_tokens: 128 } }, null, 2)}</pre></div>
        </section>

        <footer className="flex flex-col gap-3 border-t border-border pt-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>Longrun · portable source, ready for your GitHub repository</span><a href="https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary">Repository dispatch API <Command size={13} /></a></footer>
      </main>
    </div>
  );
}
