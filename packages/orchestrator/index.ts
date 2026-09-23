import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  assertAvailable, atomicJson, message, messages, parentDirectory, publish, readJson,
  readWorker, saveWorker, workerDirectory, workers, type Message, type Worker,
} from "./store.ts";
import { isAlive, launch } from "./tmux.ts";

const LINK = "my-pi-worker";
const MAIL = "my-pi-mail";
const HANDOFF_TOOLS = new Set(["spawn_worker", "send_to_worker", "report_to_parent"]);
const extensionPath = fileURLToPath(import.meta.url);
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const reportSchema = Type.Object({
  status: StringEnum(["ready_for_review", "needs_input", "blocked"] as const),
  summary: text(8_000),
  checks: Type.Array(text(1_000), { maxItems: 20 }),
  question: Type.Optional(text(4_000)),
});

// Dependency seam for tests; no user-facing configuration or toggle commands.
type Runtime = {
  root: string;
  launch: typeof launch;
  isAlive: typeof isAlive;
  pollMs: number;
};

export default function orchestrator(pi: ExtensionAPI, overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = {
    root: join(getAgentDir(), "orchestration"), launch, isAlive, pollMs: 1_000, ...overrides,
  };
  let workerDir: string | undefined;
  let parentDir: string;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let dispatching = false;
  let delivering: string | undefined;
  const received = new Set<string>();
  let lastError = "";

  function notifyError(ctx: ExtensionContext, error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    if (text !== lastError) ctx.ui.notify(`Orchestrator: ${text}`, "error");
    lastError = text;
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
      description: "Launch an ordinary Pi in tmux with a fresh context. Supply a self-contained task, decisions, scope, and checks. Returns immediately after launch; ends your turn while the worker runs.",
      promptSnippet: "Delegate a focused task to a fresh interactive Pi worker",
      parameters: Type.Object({ task: text(24_000) }),
      async execute(_id, args, signal, _update, ctx) {
        return dispatch(ctx, async () => {
          signal?.throwIfAborted();
          if (!ctx.model) throw new Error("Select a model before spawning a worker.");
          const id = randomUUID();
          const worker: Worker = {
            id, parentId: ctx.sessionManager.getSessionId(), sessionId: id,
            cwd: ctx.cwd, tmux: `pi-${ctx.sessionManager.getSessionId().slice(0, 12)}-${id}`,
            state: "queued",
          };
          const dir = workerDirectory(parentDir, id);
          saveWorker(dir, worker);
          publish(dir, message(worker, { kind: "instruction", text: args.task }));
          try {
            await runtime.launch({
              dir, worker, extension: extensionPath,
              provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              trusted: ctx.isProjectTrusted(),
              env: { ...process.env, PI_CODING_AGENT_DIR: getAgentDir() },
            });
          } catch (error) {
            saveWorker(dir, { ...worker, state: "stopped" });
            throw new Error(`Could not launch worker ${id}; inspect ${dir}. ${String(error)}`);
          }
          const result = details(dir, readWorker(dir));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
            terminate: true,
          };
        });
      },
    });

    pi.registerTool({
      name: "send_to_worker",
      label: "Continue worker",
      description: "Send a message to a waiting worker in this orchestrator's namespace, preserving its full context. Ends your turn; the next report wakes you.",
      promptSnippet: "Guide or continue an existing worker in its own context",
      parameters: Type.Object({ worker_id: text(100), message: text(24_000) }),
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
            content: [{ type: "text", text: `Message sent. Waiting for worker report.\n${JSON.stringify(result, null, 2)}` }],
            details: result,
            terminate: true,
          };
        });
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
    // Capture usage at handoff, after the worker has settled (not inside the
    // report_to_parent tool, where its final turn has not completed yet).
    const usage = ctx.getContextUsage();
    report.report = {
      ...report.report,
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

  function poll(ctx: ExtensionContext) {
    if (stopped || !ctx.isIdle() || delivering) return;
    try {
      publishReport(ctx);
      const candidates = workerDir
        ? messages(workerDir, "instruction")
        : workers(parentDir).flatMap(({ dir }) => messages(dir, "report"));
      const next = candidates.sort((a, b) => a.id.localeCompare(b.id)).find((msg) => !received.has(msg.id));
      if (!next) return;
      delivering = next.id;
      pi.sendMessage({
        customType: MAIL,
        content: next.kind === "instruction"
          ? `Instruction from your orchestrator:\n${next.text}`
          : `Report from worker ${next.workerId}:\n${JSON.stringify(next.report, null, 2)}\nDecide whether to accept this step, send guidance, delegate another task, or ask the user.`,
        display: true,
        details: { messageId: next.id, workerId: next.workerId },
      }, { triggerTurn: true });
      lastError = "";
    } catch (error) {
      delivering = undefined;
      notifyError(ctx, error);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
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
      registerWorkerTools();
    } else {
      parentDir = parentDirectory(runtime.root, ctx.sessionManager.getSessionId());
      registerParentTools();
    }
    for (const entry of entries) {
      if (entry.type === "custom_message" && entry.customType === MAIL) {
        const id = (entry.details as { messageId?: string } | undefined)?.messageId;
        if (id) received.add(id);
      }
    }
    // Idle polling also handles reports received while this parent was closed.
    timer = setInterval(() => poll(ctx), runtime.pollMs);
    timer.unref();
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "custom" || event.message.customType !== MAIL) return;
    const id = (event.message.details as { messageId?: string } | undefined)?.messageId;
    if (id) received.add(id);
    if (id === delivering) delivering = undefined;
  });

  pi.on("before_agent_start", (event) => {
    if (workerDir) {
      event.systemPromptOptions.promptGuidelines.push(
        "You are an execution worker. Perform the assigned work directly; never delegate, spawn other agents, or launch Pi yourself. Preserve this session for follow-up.",
        "When ready for review, blocked, or needing guidance, call report_to_parent as your ONLY tool call in that turn, then wait. Report actual check outcomes; never call an unrun check passed. The parent decides acceptance.",
      );
    } else {
      event.systemPromptOptions.promptGuidelines.push(
        "When asked to orchestrate a plan, delegate focused tasks using spawn_worker. Keep the plan and decisions here, not worker transcripts. Do not edit the checkout alongside a running worker.",
        "Call spawn_worker or send_to_worker alone in a turn; each yields until a report arrives. Accept reports or guide the same worker with send_to_worker. You may investigate a waiting worker's question using a new worker, then pass the findings back. Only one worker executes at a time. Ask the user rather than retrying indefinitely.",
      );
      const roster = workers(parentDir).map(({ worker }) => `${worker.id}: ${worker.state}; attach: tmux attach -t ${worker.tmux}`);
      if (roster.length) event.systemPromptOptions.sections.orchestration_workers = roster.join("\n");
    }
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
    if (!workerDir) return;
    // Human guidance queued before handoff invalidates the not-yet-sent report.
    const pending = join(workerDir, "pending-report.json");
    if (existsSync(pending)) unlinkSync(pending);
    saveWorker(workerDir, { ...readWorker(workerDir), state: "running" });
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (stopped || !ctx.isIdle()) return;
    if (workerDir) {
      saveWorker(workerDir, { ...readWorker(workerDir), state: "waiting" });
      try { publishReport(ctx); } catch (error) { notifyError(ctx, error); }
    }
  });

  const keepWorkerSession = (_event: unknown, ctx: ExtensionContext) => {
    if (!workerDir) return;
    ctx.ui.notify("This worker must keep its session for parent communication. Open a separate Pi for new or forked conversations.", "warning");
    return { cancel: true };
  };
  pi.on("session_before_switch", keepWorkerSession);
  pi.on("session_before_fork", keepWorkerSession);

  pi.on("session_shutdown", (event) => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (workerDir && event.reason !== "reload") {
      saveWorker(workerDir, { ...readWorker(workerDir), state: "stopped" });
    }
    // Parent shutdown never kills workers. Their terminals and mail survive.
  });
}
