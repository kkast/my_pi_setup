import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  assertAvailable, atomicJson, message, messages, parentDirectory, publish, readJson,
  readWorker, saveWorker, workerDirectory, workers, type Message, type Worker,
} from "./store.ts";
import { isAlive, launch, liveSessions, stopWorkerTerminal } from "./tmux.ts";
import { childProcesses, lastActivity } from "./diagnostics.ts";
import { compactionNotice, contextHealth } from "./context.ts";

const LINK = "my-pi-worker";
const MAIL = "my-pi-mail";
const STATUS = "orchestrator";
const HANDOFF_TOOLS = new Set(["spawn_worker", "send_to_worker", "report_to_parent"]);
const extensionPath = fileURLToPath(import.meta.url);
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Custom-message turns bypass before_agent_start (and initial base-prompt
// preparation in Pi 0.86.1). Supply our role rules through the context hook.
const parentGuidelines = [
  "When asked to orchestrate a plan, delegate focused tasks using spawn_worker. Give each spawn_worker a concise, descriptive title, and each send_to_worker a descriptive follow-up title so the user can identify the worker and current step without reading long instructions. Keep the plan and decisions here, not worker transcripts. Do not edit the checkout alongside a running worker.",
  "Call spawn_worker or send_to_worker alone in a turn; each yields until a report arrives. Accept reports or guide the same worker with send_to_worker. You may investigate a waiting worker's question using a new worker, then pass the findings back. Only one worker executes at a time. Ask the user rather than retrying indefinitely.",
  "Keep waiting workers available for likely follow-ups. When you decide no further follow-up is expected, call stop_worker to release their process memory. Reporting alone never stops a worker; do not stop workers mid-edit.",
  "Aim for zero worker compactions: assign bounded tasks and prefer a fresh worker before compaction becomes necessary. Compaction is a fallback, not the normal continuation strategy. If compaction_count is 1 or more, prefer a fresh worker with an explicit handoff for substantial follow-up, even if current context usage is low. An exception is a small correction or final check; reaffirm critical constraints when continuing a compacted worker. Do not discard completed work because compaction occurred.",
  "Choose workers by task continuity, not topic similarity alone. For an uncompacted worker on the same unfinished task, under 60% context usage generally continue; at 60–80% use only a bounded follow-up; above 80% prefer a fresh worker for substantial work. Unrelated work, a new phase, or independent review should use a fresh worker.",
  "Consider a fresh review worker at consequential milestones and before accepting risky or substantial changes. Use focused briefs and concise findings. Avoid repeated reviews of unchanged work; after fixes, re-review only when their risk or unresolved findings warrant it.",
  "Context percentages are advisory estimates, not enforced cutoffs; consider the next task's size and unknown usage. After compaction, reaffirm critical constraints in follow-up guidance. Never kill or replace a worker mid-edit just because of context usage; wait for its settled report.",
].map((guideline) => `For spawn_worker/send_to_worker orchestration: ${guideline}`);

function workerModel(ctx: ExtensionContext, selection?: string) {
  if (selection === undefined) {
    if (!ctx.model) throw new Error("Select a model before spawning a worker.");
    return ctx.model;
  }
  // Exact IDs only: CLI fuzzy matching can silently pick the wrong provider.
  const all = ctx.modelRegistry.getAll();
  const qualified = all.filter((model) => `${model.provider}/${model.id}` === selection);
  const matches = qualified.length ? qualified : all.filter((model) => model.id === selection);
  if (!matches.length) throw new Error(`Unknown worker model: ${selection}. Use an exact provider/model ID from Pi's model registry.`);
  if (matches.length > 1) throw new Error(`Ambiguous worker model: ${selection}. Use provider/model: ${matches.map((model) => `${model.provider}/${model.id}`).join(", ")}`);
  const model = matches[0];
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Authentication is not configured for worker model ${model.provider}/${model.id}. Configure it in Pi before spawning.`);
  }
  return model;
}

function workerTitle(task: string, title?: string): string {
  if (title?.trim()) return title.trim();
  const source = (task.trim().split(/\r?\n/, 1)[0] || "New task")
    .replace(/^[-#*\s]+/, "").trim();
  if (source.length <= 60) return source || "New task";
  const prefix = source.slice(0, 59);
  const boundary = prefix.lastIndexOf(" ");
  return `${(boundary > 20 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}
// Explicit wrapping keeps all three fields visible even in collapsed rows.
// Errors also arrive as text without success details.
const renderHandoffResult: NonNullable<ToolDefinition["renderResult"]> = (result, _options, theme) =>
  new Text(theme.fg("toolOutput", result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")), 0, 0);

const reportSchema = Type.Object({
  status: StringEnum(["ready_for_review", "needs_input", "blocked"] as const),
  summary: text(8_000),
  checks: Type.Array(text(1_000), { maxItems: 20 }),
  question: Type.Optional(text(4_000)),
});

// Dependency seam for tests; no user-facing configuration or toggle commands.
type Runtime = {
  root: string;
  launch: (options: Parameters<typeof launch>[0]) => Promise<number | void>;
  isAlive: typeof isAlive;
  liveSessions?: typeof liveSessions;
  stopWorkerTerminal: typeof stopWorkerTerminal;
  pollMs: number;
};

export default function orchestrator(pi: ExtensionAPI, overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = {
    root: join(getAgentDir(), "orchestration"), launch, isAlive, stopWorkerTerminal, pollMs: 1_000,
    liveSessions: overrides.isAlive ? undefined : liveSessions, ...overrides,
  };
  let workerDir: string | undefined;
  let parentDir: string;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let dispatching = false;
  let delivering: string | undefined;
  const received = new Set<string>();
  let lastError = "";
  let lastStatus: string | undefined;
  let polling = false;
  const seenChildren = new Map<string, Set<number>>();
  const liveWorkers = new Set<string>();
  let lifecycleRevision = 0;
  let plainCompletion: { text: string; signal?: AbortSignal } | undefined;

  async function refreshLiveWorkers() {
    const revision = lifecycleRevision;
    const roster = workers(parentDir);
    const sessions = runtime.liveSessions
      ? (roster.length ? await runtime.liveSessions() : new Set<string>())
      : new Set((await Promise.all(roster.map(async ({ worker }) =>
        await runtime.isAlive(worker.tmux) ? worker.tmux : undefined))).filter((name): name is string => !!name));
    // A lifecycle action supersedes a snapshot taken before it completed.
    if (stopped || dispatching || revision !== lifecycleRevision) return;
    liveWorkers.clear();
    for (const { worker } of roster) {
      if (sessions.has(worker.tmux)) liveWorkers.add(worker.id);
    }
  }

  function notifyError(ctx: ExtensionContext, error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    if (text !== lastError) ctx.ui.notify(`Orchestrator: ${text}`, "error");
    lastError = text;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (workerDir || stopped) return;
    const active = workers(parentDir).some(({ worker }) => worker.state === "queued" || worker.state === "running");
    const status = `${active ? "Orchestrator: waiting on worker" : "Orchestrator: idle"} | Live Workers: ${liveWorkers.size}`;
    if (status !== lastStatus) {
      ctx.ui.setStatus(STATUS, status);
      lastStatus = status;
    }
  }

  function requireParent(ctx: ExtensionContext) {
    if (workerDir) throw new Error("Workers cannot dispatch other workers.");
    if (stopped) throw new Error("This orchestration session has been shut down.");
    if (!ctx.sessionManager.getSessionFile() || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
      throw new Error("Use orchestration from a saved interactive or RPC Pi session, not print/JSON mode.");
    }
  }

  // Pi tools may run in parallel. Reserve dispatch before the first await.
  async function dispatch<T>(ctx: ExtensionContext, action: () => Promise<T>): Promise<T> {
    requireParent(ctx);
    if (dispatching) throw new Error("Another dispatch is in progress.");
    dispatching = true;
    try {
      assertAvailable(parentDir);
      return await action();
    } finally {
      dispatching = false;
      updateStatus(ctx);
    }
  }

  function details(dir: string, worker: Worker) {
    return {
      worker_id: worker.id,
      pi_session_id: worker.sessionId,
      session_file: worker.sessionFile ?? null,
      session_directory: join(dir, "sessions"),
      metadata_file: join(dir, "metadata.json"),
      attach: `tmux attach -t ${worker.tmux}`,
    };
  }

  function registerParentTools() {
    pi.registerTool({
      name: "spawn_worker",
      label: "Spawn worker",
      description: "Launch an ordinary Pi in tmux with a fresh context. Supply a short display title and a self-contained task with decisions, scope, and checks. Optional model and thinking override only this new worker; each defaults independently to the orchestrator. Pi clamps thinking to model capabilities. Returns immediately after launch; ends your turn while the worker runs.",
      promptSnippet: "Delegate a focused task to a fresh interactive Pi worker",
      parameters: Type.Object({
        task: text(24_000), title: Type.Optional(text(80)),
        model: Type.Optional(Type.String({ minLength: 1, description: "Exact provider/model ID (recommended), or an unambiguous exact model ID from Pi's registry. No fuzzy patterns or :thinking suffix." })),
        thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Pi thinking level; omitted inherits the orchestrator's level. Pi clamps unsupported levels for the worker model." })),
      }),
      // The brief remains in the saved tool call, but must not flood the TUI.
      renderCall() { return new Container(); },
      renderResult: renderHandoffResult,
      async execute(_id, args, signal, _update, ctx) {
        return dispatch(ctx, async () => {
          signal?.throwIfAborted();
          if (args.thinking !== undefined && !thinkingLevels.includes(args.thinking)) {
            throw new Error(`Invalid worker thinking level: ${args.thinking}. Use ${thinkingLevels.join(", ")}.`);
          }
          const model = workerModel(ctx, args.model);
          const thinking = args.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel();
          const id = randomUUID();
          const worker: Worker = {
            id, parentId: ctx.sessionManager.getSessionId(), sessionId: id,
            cwd: ctx.cwd, tmux: `pi-${ctx.sessionManager.getSessionId().slice(0, 12)}-${id}`,
            title: workerTitle(args.task, args.title), state: "queued",
          };
          const dir = workerDirectory(parentDir, id);
          saveWorker(dir, worker);
          publish(dir, message(worker, { kind: "instruction", text: args.task }));
          try {
            const panePid = await runtime.launch({
              dir, worker, extension: extensionPath,
              provider: model.provider, model: model.id, thinking,
              trusted: ctx.isProjectTrusted(),
              env: { ...process.env, PI_CODING_AGENT_DIR: getAgentDir() },
            });
            if (panePid) saveWorker(dir, { ...readWorker(dir), panePid });
            liveWorkers.add(id);
            lifecycleRevision++;
          } catch (error) {
            saveWorker(dir, { ...worker, state: "stopped", launchFailed: true });
            throw new Error(`Could not launch worker ${id}; inspect ${dir}. ${String(error)}`);
          }
          const result = details(dir, readWorker(dir));
          return {
            content: [{ type: "text", text: `Worker: ${worker.title}\nFolder: ${dir}\nAttach: ${result.attach}` }],
            details: result,
            terminate: true,
          };
        });
      },
    });

    pi.registerTool({
      name: "send_to_worker",
      label: "Continue worker",
      description: "Send a message to a waiting worker in this orchestrator's namespace, preserving its full context. The display retains the worker's title; supply a short follow-up title to display in full alongside it. Ends your turn; the next report wakes you.",
      promptSnippet: "Guide or continue an existing worker in its own context",
      parameters: Type.Object({ worker_id: text(100), message: text(24_000), title: Type.Optional(text(80)) }),
      renderCall() { return new Container(); },
      renderResult: renderHandoffResult,
      async execute(_id, args, signal, _update, ctx) {
        return dispatch(ctx, async () => {
          signal?.throwIfAborted();
          const dir = workerDirectory(parentDir, args.worker_id);
          const worker = readWorker(dir);
          if (worker.parentId !== ctx.sessionManager.getSessionId()) throw new Error("Worker belongs to another orchestrator.");
          if (worker.state !== "waiting") throw new Error(`Worker is ${worker.state}; inspect its terminal before continuing.`);
          if (!await runtime.isAlive(worker.tmux)) {
            throw new Error(`Worker terminal is not running. Resume its saved Pi session in a terminal first: ${worker.sessionFile ?? join(dir, "sessions")}`);
          }
          signal?.throwIfAborted();
          if (stopped) throw new Error("Orchestrator shut down during dispatch.");
          // Human input may have started a worker while tmux was being checked.
          assertAvailable(parentDir);
          saveWorker(dir, { ...readWorker(dir), state: "queued" });
          publish(dir, message(worker, { kind: "instruction", text: args.message }));
          const result = details(dir, worker);
          return {
            content: [{ type: "text", text: `Continuing: ${worker.title?.trim() || `Worker ${worker.id}`}${args.title?.trim() ? ` — ${args.title.trim()}` : ""}\nFolder: ${dir}\nAttach: ${result.attach}` }],
            details: result,
            terminate: true,
          };
        });
      },
    });

  pi.registerTool({
    name: "stop_worker",
    label: "Stop worker",
    description: "Release a settled waiting worker's process memory by closing only its owned tmux session. Use when no further follow-up is expected. Preserves saved sessions and reports; rejects active workers and pending report publication. Does not yield your turn.",
    promptSnippet: "Stop a waiting worker when no further follow-up is expected",
    parameters: Type.Object({ worker_id: text(100) }),
    renderCall() { return new Container(); },
    renderResult: renderHandoffResult,
    async execute(_id, args, signal, _update, ctx) {
      requireParent(ctx);
      if (dispatching) throw new Error("Another dispatch is in progress.");
      dispatching = true;
      try {
        const dir = workerDirectory(parentDir, args.worker_id);
        const validate = () => {
          signal?.throwIfAborted();
          requireParent(ctx);
          const worker = readWorker(dir);
          if (worker.id !== args.worker_id || worker.parentId !== ctx.sessionManager.getSessionId()) {
            throw new Error("Worker belongs to another orchestrator or directory.");
          }
          if (worker.state !== "waiting" && worker.state !== "closed") {
            throw new Error(`Worker is ${worker.state}; only settled waiting workers can be stopped.`);
          }
          if (existsSync(join(dir, "pending-report.json"))) {
            throw new Error("Worker report publication is pending; wait for its settled report before stopping.");
          }
          return worker;
        };
        const worker = validate();
        if (worker.state !== "closed") {
          await runtime.stopWorkerTerminal(dir, worker, () => {
            const current = validate();
            if (current.tmux !== worker.tmux || current.panePid !== worker.panePid) {
              throw new Error("Worker terminal identity changed during stop; inspect it manually.");
            }
          });
          // Do not overwrite session/report metadata updated during shutdown.
          saveWorker(dir, { ...readWorker(dir), state: "closed" });
        }
        liveWorkers.delete(worker.id);
        lifecycleRevision++;
        return {
          content: [{ type: "text", text: `Stopped: ${worker.title?.trim() || `Worker ${worker.id}`}\nFolder: ${dir}\nSaved session and reports preserved.` }],
          details: { worker_id: worker.id, state: "closed", metadata_file: join(dir, "metadata.json"), session_file: worker.sessionFile ?? null },
        };
      } catch (error) {
        throw new Error(`Could not stop worker ${args.worker_id}: ${String(error)}`);
      } finally {
        dispatching = false;
        updateStatus(ctx);
      }
    },
  });
  }

  function registerWorkerTools() {
    pi.registerTool({
      name: "report_to_parent",
      label: "Report to parent",
      description: "Send a concise structured update to your orchestrator, then yield. Use for review, questions, or blockers. This does not close your session or declare the assignment accepted. Must be your only tool call in this turn.",
      promptSnippet: "Report results, questions, or blockers to your parent and wait",
      parameters: reportSchema,
      async execute(_id, report) {
        if (!workerDir || stopped) throw new Error("Not an active worker session.");
        const worker = readWorker(workerDir);
        const pending = join(workerDir, "pending-report.json");
        if (existsSync(pending)) throw new Error("A report is already pending delivery.");
        // Do not wake the parent until this worker has actually settled.
        atomicJson(pending, message(worker, { kind: "report", report }));
        return {
          content: [{ type: "text", text: "Report saved. Yielding to parent; remain available for follow-up." }],
          details: report,
          terminate: true,
        };
      },
    });
  }

  function registerWorkerCommands() {
    pi.registerCommand("report", {
      description: "Ask this worker to report its current state to its parent and yield",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        pi.sendUserMessage("Summarize your current work, check outcomes, and any question or blocker using report_to_parent now. Do not perform more implementation first.");
      },
    });
  }

  function publishReport(ctx: ExtensionContext) {
    if (!workerDir) return;
    const pending = join(workerDir, "pending-report.json");
    if (!existsSync(pending)) return;
    const report = readJson<Message>(pending);
    const worker = readWorker(workerDir);
    if (report.kind !== "report" || report.workerId !== worker.id || report.parentId !== worker.parentId) {
      throw new Error("Pending report has invalid worker linkage.");
    }
    // A previous publication may have succeeded before cleanup failed. Never
    // overwrite that snapshot or compare this report against itself on retry.
    const publishedReports = messages(workerDir, "report");
    if (publishedReports.some((published) => published.id === report.id)) {
      saveWorker(workerDir, { ...worker, state: "waiting" });
      unlinkSync(pending);
      return;
    }
    const previous = publishedReports.at(-1)?.report;
    const instructionId = messages(workerDir, "instruction").at(-1)?.id;
    // Capture usage at handoff, after the worker has settled (not inside the
    // report_to_parent tool, where its final turn has not completed yet).
    const usage = ctx.getContextUsage();
    report.report = {
      ...report.report,
      context_health: contextHealth(ctx.sessionManager.getBranch(), previous, instructionId),
      context_usage: ctx.model && usage ? {
        provider: ctx.model.provider,
        model: ctx.model.id,
        tokens: usage.tokens,
        context_window: usage.contextWindow,
        percent: usage.percent,
      } : null,
    };
    publish(workerDir, report);
    saveWorker(workerDir, { ...worker, state: "waiting" });
    unlinkSync(pending);
  }

  function publishMissingReport(ctx: ExtensionContext) {
    if (!workerDir || !plainCompletion || plainCompletion.signal?.aborted) return;
    const worker = readWorker(workerDir);
    const instruction = messages(workerDir, "instruction").at(-1);
    if (!instruction || !received.has(instruction.id)) return;
    // Require this assignment's receipt on the active branch, not an old final
    // from a resumed session or a different branch. Explicit reports win.
    if (!ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" &&
      entry.customType === MAIL && (entry.details as { messageId?: string })?.messageId === instruction.id)) return;
    if (messages(workerDir, "report").some((report) => report.id > instruction.id)) return;
    const id = `${instruction.id}-missing-report`;
    if (messages(workerDir, "missing_report").some((notice) => notice.id === id)) return;
    publish(workerDir, {
      id, kind: "missing_report", parentId: worker.parentId, workerId: worker.id, instructionId: instruction.id,
      text: `Worker ${worker.id} settled with a normal final reply but did not call report_to_parent. This is a missing-report notification, NOT a structured report or task acceptance. The worker remains available; inspect its output and use send_to_worker to request a report or further work.\nSession: ${worker.sessionFile ?? join(workerDir, "sessions")}\nUnverified worker output (at most 8,000 characters):\n${plainCompletion.text || "[No text in final reply]"}`,
    });
  }

  async function checkWorkers(ctx: ExtensionContext) {
    for (const { dir, worker } of workers(parentDir)) {
      if (worker.launchFailed || worker.state === "waiting" || worker.state === "closed") continue;
      const instructions = messages(dir, "instruction");
      const latest = instructions.at(-1);
      if (!latest) continue;
      const reports = messages(dir, "report");
      if (reports.some((report) => report.id > latest.id)) continue;
      const seen = seenChildren.get(worker.id) ?? new Set<number>();
      seenChildren.set(worker.id, seen);
      if (worker.state !== "stopped" && liveWorkers.has(worker.id)) {
        await childProcesses(worker, seen);
        continue;
      }
      if (stopped) return;
      const id = `${latest.id}-failure`;
      if (messages(dir, "failure").some((failure) => failure.id === id)) continue;
      const children = await childProcesses(worker, seen);
      // A stop or settlement may have completed while the probe was in flight.
      const current = readWorker(dir);
      if (dispatching || current.state === "closed" || current.state === "waiting") continue;
      const failure = `Worker ${worker.id} stopped without reporting its assignment. This is an orchestration failure, not task completion. Last activity: ${lastActivity(worker)}. Running child processes: ${children}. Inspect ${dir} before retrying.`;
      saveWorker(dir, { ...readWorker(dir), state: "stopped" });
      publish(dir, { id, kind: "failure", parentId: worker.parentId, workerId: worker.id, text: failure });
      ctx.ui.notify(`Orchestrator: ${failure}`, "error");
    }
  }

  async function poll(ctx: ExtensionContext) {
    if (stopped || polling) return;
    polling = true;
    try {
      if (!workerDir && !dispatching) {
        await refreshLiveWorkers();
        if (stopped) return;
        if (!dispatching) await checkWorkers(ctx);
      }
      updateStatus(ctx);
      if (!ctx.isIdle() || delivering) return;
      publishReport(ctx);
      const candidates = workerDir
        ? messages(workerDir, "instruction")
        : workers(parentDir).flatMap(({ dir }) => [...messages(dir, "report"), ...messages(dir, "failure"), ...messages(dir, "missing_report")]);
      const next = candidates.sort((a, b) => a.id.localeCompare(b.id)).find((msg) => !received.has(msg.id));
      if (!next) return;
      delivering = next.id;
      pi.sendMessage({
        customType: MAIL,
        content: next.kind === "instruction"
          ? `Instruction from your orchestrator:\n${next.text}`
          : next.kind === "failure" ? `ORCHESTRATION FAILURE:\n${next.text}`
          : next.kind === "missing_report" ? `MISSING WORKER REPORT:\n${next.text}`
          : `Report from worker ${next.workerId}:\n${compactionNotice(next.report)}${JSON.stringify(next.report, null, 2)}\nDecide whether to accept this step, send guidance, delegate another task, or ask the user.`,
        display: true,
        details: { messageId: next.id, workerId: next.workerId },
      }, { triggerTurn: true });
      lastError = "";
    } catch (error) {
      delivering = undefined;
      notifyError(ctx, error);
    } finally {
      polling = false;
    }
  }

  // Pi rebuilds transcript rows before session_start on reload/session replacement.
  // Register definitions now or restored rows permanently use the generic
  // tool-name + JSON-arguments fallback. Only activation is role-specific.
  registerParentTools();
  registerWorkerTools();

  pi.on("session_start", async (_event, ctx) => {
    stopped = false;
    liveWorkers.clear();
    lastStatus = undefined;
    received.clear();
    const entries = ctx.sessionManager.getEntries();
    const link = ctx.sessionManager.getBranch().find((entry) => entry.type === "custom" && entry.customType === LINK);
    workerDir = link?.type === "custom"
      ? (link.data as { directory: string }).directory
      : process.env.MY_PI_WORKER_DIR;
    if (workerDir) {
      workerDir = resolve(workerDir);
      const worker = readWorker(workerDir);
      if (worker.sessionId !== ctx.sessionManager.getSessionId()) {
        throw new Error("Worker linkage does not match this Pi session. Do not use /new or fork inside a worker terminal.");
      }
      if (ctx.mode !== "tui") throw new Error("Workers must run as ordinary interactive Pi sessions.");
      parentDir = dirname(dirname(workerDir));
      saveWorker(workerDir, {
        ...worker, sessionFile: ctx.sessionManager.getSessionFile(),
        state: worker.state === "queued" ? "queued" : "waiting",
      });
      if (!link) pi.appendEntry(LINK, { directory: workerDir });
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "spawn_worker" && name !== "send_to_worker" && name !== "stop_worker"));
      registerWorkerCommands();
    } else {
      parentDir = parentDirectory(runtime.root, ctx.sessionManager.getSessionId());
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "report_to_parent"));
    }
    for (const entry of entries) {
      if (entry.type === "custom_message" && entry.customType === MAIL) {
        const id = (entry.details as { messageId?: string } | undefined)?.messageId;
        if (id) received.add(id);
      }
    }
    if (!workerDir) {
      try { await refreshLiveWorkers(); } catch (error) { notifyError(ctx, error); }
      updateStatus(ctx);
    }
    // Idle polling also handles reports received while this parent was closed.
    timer = setInterval(() => { void poll(ctx); }, runtime.pollMs);
    timer.unref();
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "custom" || event.message.customType !== MAIL) return;
    const id = (event.message.details as { messageId?: string } | undefined)?.messageId;
    if (id) received.add(id);
    if (id === delivering) delivering = undefined;
  });

  pi.on("context", (event) => {
    const guidelines = workerDir ? [
      "As a report_to_parent execution worker, perform the assigned work directly; never delegate, spawn other agents, or launch Pi yourself. Preserve this session for follow-up.",
      "When ready for review, blocked, or needing guidance, call report_to_parent as your ONLY tool call in that turn, then wait. Report actual check outcomes; never call an unrun check passed. The parent decides acceptance.",
    ] : parentGuidelines;
    const roster = workerDir ? [] : workers(parentDir).map(({ worker }) =>
      `${worker.id}: ${worker.title ?? "Untitled worker"}; ${worker.state}${worker.state === "closed" ? "" : `; attach: tmux attach -t ${worker.tmux}`}`);
    // context is a request-local copy: never appendEntry/sendMessage here.
    // Named sections replace by name for providers that fold system messages;
    // mid-conversation providers receive this supplemental system message in place.
    // Keep the base prompt, existing messages and tool declarations unchanged.
    return { messages: [...event.messages, {
      role: "system" as const, content: "", timestamp: Date.now(),
      sections: { orchestration_guidance: [...guidelines, ...roster].join("\n") },
    }] };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!HANDOFF_TOOLS.has(event.toolName)) return;
    const latest = [...ctx.sessionManager.getBranch()].reverse().find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    if (latest?.type === "message" && latest.message.role === "assistant") {
      const calls = latest.message.content.filter((part) => part.type === "toolCall");
      if (calls.length !== 1) return { block: true, reason: `${event.toolName} must be the only tool call in its turn so handoff can safely yield.` };
    }
  });

  pi.on("agent_start", () => {
    plainCompletion = undefined;
    if (!workerDir) return;
    // Human guidance queued before handoff invalidates the not-yet-sent report.
    const pending = join(workerDir, "pending-report.json");
    if (existsSync(pending)) unlinkSync(pending);
    saveWorker(workerDir, { ...readWorker(workerDir), state: "running" });
  });
  pi.on("agent_end", (event, ctx) => {
    plainCompletion = undefined;
    if (!workerDir || stopped) return;
    // agent_end alone is not settlement: Pi may retry/compact/continue. Keep
    // only this run's final, and retain its signal to detect late cancellation.
    const final = event.messages.at(-1);
    if (final?.role !== "assistant" || final.stopReason !== "stop" ||
      final.content.some((part) => part.type === "toolCall")) return;
    const output = final.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    plainCompletion = { text: output.length > 8_000 ? `${output.slice(0, 7_980)}\n[truncated]` : output, signal: ctx.signal };
  });
  pi.on("session_compact_failed", (event) => {
    // A user can cancel post-run compaction after the low-level signal ended.
    if (event.aborted) plainCompletion = undefined;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (stopped || !ctx.isIdle()) return;
    if (workerDir) {
      try {
        const pending = existsSync(join(workerDir, "pending-report.json"));
        publishReport(ctx);
        if (!pending) publishMissingReport(ctx);
        saveWorker(workerDir, { ...readWorker(workerDir), state: "waiting" });
        updateStatus(ctx);
      } catch (error) { notifyError(ctx, error); }
      finally { plainCompletion = undefined; }
    }
  });

  const keepWorkerSession = (_event: unknown, ctx: ExtensionContext) => {
    if (!workerDir) return;
    ctx.ui.notify("This worker must keep its session for parent communication. Open a separate Pi for new or forked conversations.", "warning");
    return { cancel: true };
  };
  pi.on("session_before_switch", keepWorkerSession);
  pi.on("session_before_fork", keepWorkerSession);

  pi.on("session_shutdown", (event, ctx) => {
    stopped = true;
    if (!workerDir) ctx.ui.setStatus(STATUS, undefined);
    if (timer) clearInterval(timer);
    if (workerDir && event.reason !== "reload") {
      const worker = readWorker(workerDir);
      if (worker.state !== "closed") saveWorker(workerDir, { ...worker, state: "stopped" });
    }
    // Parent shutdown never kills workers. Their terminals and mail survive.
  });
}
