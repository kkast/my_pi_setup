import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import orchestrator from "../index.ts";
import { atomicJson, messages, parentDirectory, publish, readWorker, safeId, saveWorker, workerDirectory, workers } from "../store.ts";
import { launchArguments, shellQuote } from "../tmux.ts";
import { harness, until } from "../../../tests/harness.ts";

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
  assert.deepEqual([...parent.tools.keys()], ["spawn_worker", "send_to_worker"]);
  const first = await parent.call("spawn_worker", { task: "Implement A" });
  assert.equal(first.terminate, true);
  assert.equal(launches[0].model, "model");
  assert.equal(launches[0].thinking, "high");
  assert.equal(launches[0].trusted, false);

  const a = agent(first.details.pi_session_id, launches[0].dir);
  await a.start();
  assert.deepEqual([...a.tools.keys()], ["report_to_parent"]);
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
  assert.match(parent.delivered[0].content, /What does X mean/);
  assert.deepEqual(messages(launches[0].dir, "report")[0].report.context_usage, {
    provider: "test", model: "model", tokens: 12_000, context_window: 120_000, percent: 10,
  });
  assert.match(parent.delivered[0].content, /"context_usage"/);

  const second = await parent.call("spawn_worker", { task: "Investigate X" });
  const b = agent(second.details.pi_session_id, launches[1].dir);
  await b.start();
  await until(() => b.delivered.length === 1);
  await b.call("report_to_parent", { status: "ready_for_review", summary: "X means Y", checks: [] });
  await b.settle();
  await parent.settle();
  await until(() => parent.delivered.length === 2);

  const followUp = await parent.call("send_to_worker", { worker_id: first.details.worker_id, message: "X means Y. Continue." });
  assert.equal(followUp.terminate, true);
  await until(() => a.delivered.length === 2);
  assert.match(a.delivered[1].content, /X means Y/);
  assert.equal(a.ctx.sessionManager.getSessionId(), first.details.pi_session_id);
  assert.equal(launches.length, 2, "continuation did not spawn another worker");
  assert.equal(readWorker(launches[1].dir).state, "waiting");
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
  assert.deepEqual([...resumed.tools.keys()], ["report_to_parent"]);
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
