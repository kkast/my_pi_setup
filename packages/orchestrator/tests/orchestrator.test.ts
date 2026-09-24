import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import orchestrator from "../index.ts";
import { atomicJson, messages, parentDirectory, publish, readWorker, safeId, saveWorker, workerDirectory, workers } from "../store.ts";
import { launchArguments, shellQuote } from "../tmux.ts";
import { harness, until } from "../../../tests/harness.ts";

// Tests may be launched from an actual worker; never adopt its live metadata.
delete process.env.MY_PI_WORKER_DIR;

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "my-pi-test-"));
  const agents: ReturnType<typeof harness>[] = [];
  const launches: any[] = [];
  const runtime = { root, pollMs: 5, launch: async (options: any) => { launches.push(options); }, isAlive: async () => true };
  function agent(id: string, directory?: string, entries?: any[]) {
    const h = harness(id, entries ?? (directory ? [{ type: "custom", customType: "my-pi-worker", data: { directory } }] : []));
    orchestrator(h.pi, runtime);
    agents.push(h);
    return h;
  }
  t.after(async () => {
    for (const h of agents) await h.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agent, launches, runtime };
}

const report = { status: "needs_input", summary: "Need API clarification", checks: [], question: "What does X mean?" };

test("A reports, B investigates, A continues in its original session", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent-a");
  await parent.start();
  assert.equal(parent.statuses.get("orchestrator"), "Orchestrator: idle | Live Workers: 0");
  assert.deepEqual(parent.pi.getActiveTools(), ["spawn_worker", "send_to_worker", "stop_worker"]);
  assert.deepEqual(parent.tools.get("spawn_worker").renderCall({ task: "private long brief" }).render(80), []);
  assert.deepEqual(parent.tools.get("send_to_worker").renderCall({ worker_id: "a", message: "private long follow-up" }).render(80), []);
  const first = await parent.call("spawn_worker", { task: "Implement A" });
  assert.equal(first.terminate, true);
  assert.equal(parent.statuses.get("orchestrator"), "Orchestrator: waiting on worker | Live Workers: 1");
  assert.equal(first.content[0].text, `Worker: Implement A\nFolder: ${launches[0].dir}\nAttach: ${first.details.attach}`);
  assert.doesNotMatch(first.content[0].text, /session_file|metadata_file|pi_session_id/);
  assert.equal(launches[0].model, "model");
  assert.equal(launches[0].thinking, "high");
  assert.equal(launches[0].trusted, false);

  const a = agent(first.details.pi_session_id, launches[0].dir);
  await a.start();
  assert.deepEqual(a.pi.getActiveTools(), ["report_to_parent"]);
  assert.ok(a.commands.has("report"));
  await until(() => a.delivered.length === 1);
  assert.match(a.delivered[0].content, /Implement A/);
  await assert.rejects(parent.call("spawn_worker", { task: "Too soon" }), /running/);

  const reported = await a.call("report_to_parent", report);
  assert.equal(reported.terminate, true);
  assert.equal(messages(launches[0].dir, "report").length, 0, "not published before worker settles");
  // Snapshot at settlement, not at report_to_parent execution.
  (a.ctx as any).getContextUsage = () => ({ tokens: 12_000, contextWindow: 120_000, percent: 10 });
  await a.settle();
  await until(() => parent.delivered.length === 1);
  await until(() => parent.statuses.get("orchestrator") === "Orchestrator: idle | Live Workers: 1");
  assert.match(parent.delivered[0].content, /What does X mean/);
  assert.deepEqual(messages(launches[0].dir, "report")[0].report.context_usage, {
    provider: "test", model: "model", tokens: 12_000, context_window: 120_000, percent: 10,
  });
  assert.match(parent.delivered[0].content, /"context_usage"/);

  const second = await parent.call("spawn_worker", { title: "Investigate API", task: "Investigate X" });
  assert.match(second.content[0].text, /^Worker: Investigate API\n/);
  const b = agent(second.details.pi_session_id, launches[1].dir);
  await b.start();
  await until(() => b.delivered.length === 1);
  await b.call("report_to_parent", { status: "ready_for_review", summary: "X means Y", checks: [] });
  await b.settle();
  await parent.settle();
  await until(() => parent.delivered.length === 2);

  const followUp = await parent.call("send_to_worker", { worker_id: first.details.worker_id, message: "X means Y. Continue." });
  assert.equal(followUp.terminate, true);
  assert.equal(followUp.content[0].text, `Continuing: Implement A\nFolder: ${launches[0].dir}\nAttach: ${followUp.details.attach}`);
  assert.doesNotMatch(followUp.content[0].text, /session_file|metadata_file|pi_session_id/);
  await until(() => a.delivered.length === 2);
  assert.match(a.delivered[1].content, /X means Y/);
  assert.equal(a.ctx.sessionManager.getSessionId(), first.details.pi_session_id);
  assert.equal(launches.length, 2, "continuation did not spawn another worker");
  assert.equal(readWorker(launches[1].dir).state, "waiting");
  assert.equal(parent.statuses.get("orchestrator"), "Orchestrator: waiting on worker | Live Workers: 2");
});

test("worker termination without a report alerts the parent even while busy, once per assignment", async (t) => {
  const { agent, launches, runtime } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  const sessionFile = join(launches[0].dir, "activity.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }) + "\n");
  saveWorker(launches[0].dir, { ...readWorker(launches[0].dir), sessionFile });
  parent.setIdle(false);
  runtime.isAlive = async () => false;
  await worker.close();
  await until(() => parent.notices.some((notice) => notice.includes("stopped without reporting")));
  assert.match(parent.notices.at(-1)!, /Last activity: assistant: tools bash;.*Running child processes:/);
  assert.equal(parent.delivered.length, 0);
  assert.equal(readWorker(launches[0].dir).state, "stopped");
  await parent.settle();
  await until(() => parent.delivered.length === 1);
  assert.match(parent.delivered[0].content, /ORCHESTRATION FAILURE/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(parent.delivered.length, 1);
  assert.equal(messages(launches[0].dir, "failure").length, 1);
});

test("plain final wakes busy parent only after settlement; notice survives reload without replay", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  parent.setIdle(false);
  const final = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Ready for review. " + "x".repeat(9_000) }] };
  await worker.emit("agent_end", { messages: [final] });
  assert.equal(messages(launches[0].dir, "missing_report").length, 0);
  await worker.settle();
  await worker.settle();
  const notices = messages(launches[0].dir, "missing_report");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Unverified worker output/);
  assert.match(notices[0].text, /\[truncated\]/);
  assert.ok(notices[0].text.length < 9_000);
  assert.equal(messages(launches[0].dir, "report").length, 0);
  assert.equal(readWorker(launches[0].dir).state, "waiting");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(parent.delivered.length, 0);
  await worker.close("reload");
  const resumedWorker = agent(started.details.pi_session_id, launches[0].dir, worker.entries);
  await resumedWorker.start();
  await resumedWorker.settle();
  await parent.close("reload");
  const resumed = agent("parent", undefined, parent.entries);
  await resumed.start();
  await until(() => resumed.delivered.length === 1);
  assert.match(resumed.delivered[0].content, /MISSING WORKER REPORT/);
  await resumed.close("reload");
  const again = agent("parent", undefined, resumed.entries);
  await again.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(again.delivered.length, 0);
  await again.call("send_to_worker", { worker_id: started.details.worker_id, message: "Please report properly" });
  await until(() => resumedWorker.delivered.length === 1);
  await resumedWorker.settle(); // No new final: must not reuse previous output.
  assert.equal(messages(launches[0].dir, "missing_report").length, 1);
  await resumedWorker.call("report_to_parent", report);
  await resumedWorker.settle();
  await until(() => again.delivered.length === 1);
  assert.match(again.delivered[0].content, /Report from worker/);
  assert.equal(messages(launches[0].dir, "missing_report").length, 1);
});

for (const outcome of ["aborted", "error", "length", "toolUse", "late-abort", "compaction-abort", "continuation", "shutdown", "explicit-report"] as const) {
  test(`no missing-report notification for ${outcome}`, async (t) => {
    const { agent, launches } = setup(t);
    const parent = agent("parent");
    await parent.start();
    const started = await parent.call("spawn_worker", { task: "Work" });
    const worker = agent(started.details.pi_session_id, launches[0].dir);
    await worker.start();
    await until(() => worker.delivered.length === 1);
    const controller = new AbortController();
    (worker.ctx as any).signal = controller.signal;
    const stopReason = ["aborted", "error", "length", "toolUse"].includes(outcome) ? outcome : "stop";
    await worker.emit("agent_end", { messages: [{ role: "assistant", stopReason, content: [{ type: "text", text: "Not a report" }] }] });
    if (outcome === "late-abort") controller.abort();
    if (outcome === "compaction-abort") await worker.emit("session_compact_failed", { aborted: true });
    if (outcome === "continuation") {
      await worker.emit("agent_start");
      await worker.emit("agent_end", { messages: [] });
    }
    if (outcome === "shutdown") await worker.close("reload");
    if (outcome === "explicit-report") await worker.call("report_to_parent", report);
    await worker.settle();
    assert.equal(messages(launches[0].dir, "missing_report").length, 0);
    if (outcome === "explicit-report") assert.equal(messages(launches[0].dir, "report").length, 1);
  });
}

test("explicit handoff titles display fully without truncating and leave instructions intact", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const title = "Complete API ownership and test fixture follow-up without losing context";
  assert.ok(title.length > 60 && title.length <= 80);
  const started = await parent.call("spawn_worker", { title, task: "Work" });
  assert.match(started.content[0].text, new RegExp(`^Worker: ${title}\\n`));
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  await worker.call("report_to_parent", report);
  await worker.settle();
  const followUp = await parent.call("send_to_worker", { worker_id: started.details.worker_id, title: "Verify fixture registration", message: "A very long detailed instruction that should remain intact" });
  assert.match(followUp.content[0].text, new RegExp(`^Continuing: ${title} — Verify fixture registration\\n`));
  assert.equal(messages(launches[0].dir, "instruction").at(-1)?.text, "A very long detailed instruction that should remain intact");
  assert.equal(readWorker(launches[0].dir).title, title);
});

test("legacy workers without a saved title use their identity, not a clipped message", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Old worker" });
  const worker = readWorker(launches[0].dir);
  delete worker.title;
  saveWorker(launches[0].dir, { ...worker, state: "waiting" });
  const message = "PRIVATE follow-up instructions ".repeat(100);
  const result = await parent.call("send_to_worker", { worker_id: worker.id, message, title: "Verify legacy compatibility" });
  assert.ok(result.content[0].text.startsWith(`Continuing: Worker ${worker.id} — Verify legacy compatibility\n`));
  assert.doesNotMatch(result.content[0].text, /PRIVATE|…/);
  // Both instructions can be published in the same millisecond; UUID suffixes
  // do not imply chronological order within that millisecond.
  assert.ok(messages(launches[0].dir, "instruction").some((entry) => entry.text === message));
});

test("long fallback worker titles end at a word boundary with an ellipsis; task stays intact", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const task = "ONE corrective RES-642 test-contract task before further architecture. Continue with detailed instructions.";
  const started = await parent.call("spawn_worker", { task });
  assert.match(started.content[0].text, /^Worker: ONE corrective RES-642 test-contract task before further…\n/);
  assert.equal(messages(launches[0].dir, "instruction")[0].text, task);
});

test("unknown context tokens are reported as unknown, not zero", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  (worker.ctx as any).getContextUsage = () => ({ tokens: null, contextWindow: 272_000, percent: null });
  await worker.call("report_to_parent", report);
  await worker.settle();
  assert.deepEqual(messages(launches[0].dir, "report")[0].report.context_usage, {
    provider: "test", model: "model", tokens: null, context_window: 272_000, percent: null,
  });
});

test("two orchestrators cannot cross-address workers or receive each other's reports", async (t) => {
  const { agent, launches } = setup(t);
  const p = agent("parent-a");
  const q = agent("parent-b");
  await p.start(); await q.start();
  const first = await p.call("spawn_worker", { task: "A" });
  await q.call("spawn_worker", { task: "B" });
  const a = agent(first.details.pi_session_id, launches[0].dir);
  await a.start();
  await until(() => a.delivered.length === 1);
  await a.call("report_to_parent", report);
  await a.settle();
  await until(() => p.delivered.length === 1);
  assert.equal(q.delivered.length, 0);
  saveWorker(launches[1].dir, { ...readWorker(launches[1].dir), state: "waiting" });
  await assert.rejects(q.call("send_to_worker", { worker_id: first.details.worker_id, message: "Wrong parent" }), /ENOENT/);
});

test("reports wait while parent is busy and are not replayed on parent resume", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const child = agent(started.details.pi_session_id, launches[0].dir);
  await child.start();
  await until(() => child.delivered.length === 1);
  parent.setIdle(false);
  await child.call("report_to_parent", report);
  await child.settle();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(parent.delivered.length, 0);
  await parent.close();

  const resumed = agent("parent", undefined, parent.entries);
  await resumed.start();
  await until(() => resumed.delivered.length === 1);
  await resumed.close();
  const again = agent("parent", undefined, resumed.entries);
  await again.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(again.delivered.length, 0);
});

test("worker resume retains role and does not repeat consumed instructions", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Do not repeat" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  await worker.close();
  const resumed = agent(started.details.pi_session_id, undefined, worker.entries);
  await resumed.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(resumed.delivered.length, 0);
  assert.deepEqual(resumed.pi.getActiveTools(), ["report_to_parent"]);
  assert.deepEqual((await resumed.emit("session_before_switch", { reason: "new" }))[0], { cancel: true });
  assert.deepEqual((await resumed.emit("session_before_fork"))[0], { cancel: true });
});

test("pending report survives worker reload without creating a second report", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  await worker.call("report_to_parent", report);
  await worker.close("reload");
  const resumed = agent(started.details.pi_session_id, undefined, worker.entries);
  await resumed.start();
  await until(() => parent.delivered.length === 1);
  assert.equal(messages(launches[0].dir, "report").length, 1);
  assert.equal(messages(launches[0].dir, "report")[0].report.context_usage, null);
  await resumed.settle();
  assert.equal(messages(launches[0].dir, "report").length, 1);
});

test("compaction notice and baseline survive reload, publication retry and subsequent reporting", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  worker.entries.push({ type: "compaction", id: "compact-1", timestamp: "2026-01-02T00:00:00.000Z" });
  await worker.call("report_to_parent", report);
  await worker.emit("agent_start"); // retry/correction must not consume the baseline
  await worker.call("report_to_parent", report);
  await worker.close("reload");
  const resumed = agent(started.details.pi_session_id, undefined, worker.entries);
  await resumed.start();
  await until(() => parent.delivered.length === 1);
  assert.match(parent.delivered[0].content, /NOTICE: Context compaction occurred during this assignment/);
  const first = messages(launches[0].dir, "report")[0];
  assert.equal(first.report.context_health?.compacted_since_previous_report, true);
  assert.equal(first.report.context_usage, null, "compaction metadata works without usage");
  // Simulate a crash after publish but before pending-file cleanup.
  atomicJson(join(launches[0].dir, "pending-report.json"), first);
  resumed.entries.push({ type: "compaction", id: "compact-2", timestamp: "2026-01-03T00:00:00.000Z" });
  await resumed.settle();
  assert.deepEqual(messages(launches[0].dir, "report")[0], first, "retry must not overwrite published metadata");
  await resumed.call("report_to_parent", report);
  await resumed.settle();
  assert.equal(messages(launches[0].dir, "report").at(-1)?.report.context_health?.compacted_since_previous_report, true);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await resumed.call("report_to_parent", report);
  await resumed.settle();
  assert.equal(messages(launches[0].dir, "report").at(-1)?.report.context_health?.compacted_since_previous_report, false);
});

test("parent guidelines give advisory continuity and compaction guidance", async (t) => {
  const { agent } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const options = { promptGuidelines: [] as string[], sections: {} };
  await parent.emit("before_agent_start", { systemPromptOptions: options });
  assert.deepEqual(options.promptGuidelines, [], "user turns do not add duplicate runtime guidelines");
  const original = [{ role: "system", content: "Existing base", toolsAdded: [{ name: "original-tool" }] }];
  const [result] = await parent.emit("context", { messages: original });
  assert.equal(result.messages[0], original[0], "existing base and tools are untouched");
  assert.equal(original.length, 1, "request-local injection never appends to original context");
  const [next] = await parent.emit("context", { messages: original });
  assert.equal(next.messages.length, 2, "repeated requests do not accumulate guidance");
  const guidelines = result.messages.at(-1).sections.orchestration_guidance;
  assert.match(guidelines, /Consider a fresh review worker at consequential milestones and before accepting risky or substantial changes\. Use focused briefs and concise findings\. Avoid repeated reviews of unchanged work; after fixes, re-review only when their risk or unresolved findings warrant it\./);
  for (const pattern of [/Aim for zero worker compactions/, /compaction_count is 1 or more/, /fresh worker with an explicit handoff/, /even if current context usage is low/, /exception is a small correction or final check/, /Do not discard completed work/, /uncompacted worker/]) {
    assert.match(guidelines, pattern);
  }
  for (const pattern of [/same unfinished task/, /under 60%/, /60–80%.*bounded/, /above 80%.*fresh/, /topic similarity alone/, /new phase.*independent review/, /advisory estimates, not enforced/, /next task's size/, /reaffirm critical constraints/, /Never kill or replace a worker mid-edit/]) {
    assert.match(guidelines, pattern);
  }
});

test("human follow-up before handoff invalidates the pending report", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  const started = await parent.call("spawn_worker", { task: "Work" });
  const worker = agent(started.details.pi_session_id, launches[0].dir);
  await worker.start();
  await until(() => worker.delivered.length === 1);
  await worker.call("report_to_parent", report);
  await worker.emit("agent_start"); // queued human correction, before settling
  assert.equal(messages(launches[0].dir, "report").length, 0);
  await worker.call("report_to_parent", { status: "ready_for_review", summary: "Corrected", checks: [] });
  await worker.settle();
  await until(() => parent.delivered.length === 1);
  assert.match(parent.delivered[0].content, /Corrected/);
  assert.equal(messages(launches[0].dir, "report").length, 1);
});

test("parallel dispatch is rejected; failed launch is not success and can be retried", async (t) => {
  const { root } = setup(t);
  const parent = harness("parent");
  let release!: () => void;
  orchestrator(parent.pi, {
    root, pollMs: 5,
    launch: () => new Promise<void>((resolve) => { release = resolve; }),
  });
  t.after(() => parent.close());
  await parent.start();
  const pending = parent.call("spawn_worker", { task: "First" });
  await assert.rejects(parent.call("spawn_worker", { task: "Second" }), /dispatch is in progress/);
  release(); await pending;

  const failing = harness("failing-parent");
  orchestrator(failing.pi, { root, launch: async () => { throw new Error("tmux missing"); } });
  t.after(() => failing.close());
  await failing.start();
  await assert.rejects(failing.call("spawn_worker", { task: "Fail" }), /Could not launch.*tmux missing/);
  assert.equal(workers(parentDirectory(root, "failing-parent"))[0].worker.state, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(failing.notices.length, 0, "launch error is already reported by the tool");
  await assert.rejects(failing.call("spawn_worker", { task: "Retry" }), /Could not launch/);
});

test("handoff tools must be sole tool calls; aborted dispatch makes no worker", async (t) => {
  const { agent, launches } = setup(t);
  const parent = agent("parent");
  await parent.start();
  parent.entries.push({ type: "message", message: { role: "assistant", content: [
    { type: "toolCall", name: "spawn_worker" }, { type: "toolCall", name: "bash" },
  ] } });
  const [gate] = await parent.emit("tool_call", { toolName: "spawn_worker" });
  assert.equal(gate.block, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parent.call("spawn_worker", { task: "Never" }, controller.signal));
  assert.equal(launches.length, 0);
});

test("message files are private and atomic; unsafe IDs and crossed messages are rejected", (t) => {
  const { root } = setup(t);
  assert.throws(() => safeId("../../other"), /Invalid ID/);
  const dir = workerDirectory(parentDirectory(root, "parent"), "worker");
  const worker = { id: "worker", parentId: "parent", sessionId: "worker", cwd: "/tmp", tmux: "test", state: "waiting" as const };
  saveWorker(dir, worker);
  assert.equal(statSync(join(dir, "metadata.json")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dir), ["metadata.json"]);
  publish(dir, { id: "message", parentId: "wrong-parent", workerId: "worker", kind: "instruction", text: "No" });
  assert.throws(() => messages(dir, "instruction"), /does not belong/);
  atomicJson(join(dir, "to-worker", "message.json"), { id: "different-id", parentId: "parent", workerId: "worker", kind: "instruction", text: "No" });
  assert.throws(() => messages(dir, "instruction"), /does not belong/);
});

test("stop preserves reports, closes only waiting workers, and is idempotent without false failures", async (t) => {
  const { root } = setup(t);
  const p = harness("parent");
  let kills = 0;
  orchestrator(p.pi, { root, pollMs: 5, stopWorkerTerminal: async (_dir, _worker, validate) => { validate(); kills++; } });
  t.after(() => p.close());
  await p.start();
  const dir = workerDirectory(parentDirectory(root, "parent"), "w");
  const worker = { id: "w", parentId: "parent", sessionId: "w", tmux: "pi-parent-w", cwd: "/tmp", state: "waiting" as const, title: "Full meaningful worker title" };
  saveWorker(dir, worker);
  publish(dir, { id: "001", kind: "instruction", workerId: "w", parentId: "parent", text: "Work" });
  p.setIdle(false);
  publish(dir, { id: "002", kind: "report", workerId: "w", parentId: "parent", report: { status: "ready_for_review", summary: "Done", checks: [] } });
  const result = await p.call("stop_worker", { worker_id: "w" });
  assert.equal(result.terminate, undefined);
  assert.match(result.content[0].text, /^Stopped: Full meaningful worker title/);
  assert.equal(readWorker(dir).state, "closed");
  await p.call("stop_worker", { worker_id: "w" });
  assert.equal(kills, 1);
  await assert.rejects(p.call("send_to_worker", { worker_id: "w", message: "Again" }), /closed/);
  await p.settle();
  await until(() => p.delivered.length === 1);
  assert.match(p.delivered[0].content, /Done/);
  assert.equal(messages(dir, "failure").length, 0);
  assert.equal(p.notices.length, 0);
  // Even a settled worker without a report can be explicitly retired, not failed.
  saveWorker(dir, worker);
  rmSync(join(dir, "to-parent"), { recursive: true });
  await p.call("stop_worker", { worker_id: "w" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages(dir, "failure").length, 0);
});

test("stop rejects active, pending, foreign and worker-role calls; failures leave state honest", async (t) => {
  const { root } = setup(t);
  const p = harness("parent");
  let kills = 0;
  orchestrator(p.pi, { root, pollMs: 100_000, stopWorkerTerminal: async (_dir, _worker, validate) => { validate(); kills++; throw new Error("tmux denied"); } });
  t.after(() => p.close());
  await p.start();
  const dir = workerDirectory(parentDirectory(root, "parent"), "w");
  const worker = { id: "w", parentId: "parent", sessionId: "w", tmux: "pi-parent-w", cwd: "/tmp", state: "waiting" as const };
  for (const state of ["queued", "running", "stopped"] as const) {
    saveWorker(dir, { ...worker, state });
    await assert.rejects(p.call("stop_worker", { worker_id: "w" }), new RegExp(state));
  }
  saveWorker(dir, { ...worker, parentId: "other" });
  await assert.rejects(p.call("stop_worker", { worker_id: "w" }), /another orchestrator/);
  saveWorker(dir, worker);
  atomicJson(join(dir, "pending-report.json"), { pending: true });
  await assert.rejects(p.call("stop_worker", { worker_id: "w" }), /publication is pending/);
  assert.equal(kills, 0);
  rmSync(join(dir, "pending-report.json"));
  await assert.rejects(p.call("stop_worker", { worker_id: "w" }), /tmux denied/);
  assert.equal(readWorker(dir).state, "waiting");
  const child = harness("w", [{ type: "custom", customType: "my-pi-worker", data: { directory: dir } }]);
  orchestrator(child.pi, { root, pollMs: 100_000 });
  t.after(() => child.close("reload"));
  await child.start();
  assert.ok(!child.pi.getActiveTools().includes("stop_worker"));
  await assert.rejects(child.call("stop_worker", { worker_id: "w" }), /Workers cannot/);
});

test("stop rechecks state after asynchronous terminal inspection", async (t) => {
  const { root } = setup(t);
  const p = harness("parent");
  const dir = workerDirectory(parentDirectory(root, "parent"), "w");
  let killed = false;
  orchestrator(p.pi, { root, pollMs: 100_000, stopWorkerTerminal: async (_dir, worker, validate) => {
    saveWorker(dir, { ...worker, state: "running" });
    validate(); killed = true;
  } });
  t.after(() => p.close());
  await p.start();
  saveWorker(dir, { id: "w", parentId: "parent", sessionId: "w", tmux: "pi-parent-w", cwd: "/tmp", state: "waiting" });
  await assert.rejects(p.call("stop_worker", { worker_id: "w" }), /running/);
  assert.equal(killed, false);
  assert.equal(readWorker(dir).state, "running");
});

test("tmux launch preserves model, config, trust and shell-quotes paths", () => {
  const args = launchArguments({
    dir: "/tmp/worker's files", worker: { id: "w", parentId: "p", sessionId: "w", cwd: "/tmp/project", tmux: "pi-p-w", state: "queued" },
    extension: "/tmp/setup/index.ts", provider: "provider", model: "model", thinking: "high", trusted: false,
    env: { PATH: "/bin", PI_CODING_AGENT_DIR: "/tmp/config", SECRET_API_KEY: "not-in-command" },
  });
  assert.ok(args.includes("MY_PI_WORKER_DIR=/tmp/worker's files"));
  assert.ok(args.includes("PI_CODING_AGENT_DIR=/tmp/config"));
  assert.match(args.at(-1)!, /'--session-id' 'w'/);
  assert.match(args.at(-1)!, /'--thinking' 'high'/);
  assert.match(args.at(-1)!, /'--no-approve'/);
  assert.ok(!args.join(" ").includes("not-in-command"));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
