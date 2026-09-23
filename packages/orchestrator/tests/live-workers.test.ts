import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import orchestrator from "../index.ts";
import { parentDirectory, readWorker, saveWorker, workerDirectory, type Worker } from "../store.ts";
import { harness, until } from "../../../tests/harness.ts";

delete process.env.MY_PI_WORKER_DIR;

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-live-test-"));
  const p = harness("parent");
  t.after(async () => { await p.close(); rmSync(root, { recursive: true, force: true }); });
  function add(id: string, state: Worker["state"], parent = "parent") {
    const dir = workerDirectory(parentDirectory(root, parent), id);
    saveWorker(dir, { id, parentId: parent, sessionId: id, tmux: `pi-${parent}-${id}`, cwd: "/tmp", state });
    return dir;
  }
  return { root, p, add };
}

test("live count uses namespace-scoped terminal existence, includes waiting, and tracks exits/resumes without metadata edits", async (t) => {
  const { root, p, add } = setup(t);
  const waiting = add("waiting", "waiting");
  add("running", "running");
  add("queued-dead", "queued");
  add("waiting-dead", "waiting");
  add("closed", "closed");
  add("stopped", "stopped");
  add("foreign", "waiting", "other");
  const sessions = new Set(["pi-parent-waiting", "pi-parent-running", "pi-other-foreign", "unrelated"]);
  orchestrator(p.pi, { root, pollMs: 5, liveSessions: async () => new Set(sessions),
    isAlive: async () => { throw new Error("must reuse batch snapshot"); } });
  p.setIdle(false);
  await p.start();
  assert.equal(p.statuses.get("orchestrator"), "Orchestrator: waiting on worker | Live Workers: 2");
  sessions.delete("pi-parent-waiting");
  await until(() => p.statuses.get("orchestrator")?.endsWith("Live Workers: 1") === true);
  assert.equal(readWorker(waiting).state, "waiting", "counting a dead waiting worker is read-only");
  // Stale metadata alone is not proof of death, either.
  sessions.add("pi-parent-stopped");
  sessions.add("pi-parent-closed");
  await until(() => p.statuses.get("orchestrator")?.endsWith("Live Workers: 3") === true);
  assert.deepEqual(p.notices, []);
});

test("launch and explicit stop update the count immediately without additional probes", async (t) => {
  const { root, p } = setup(t);
  let probes = 0;
  orchestrator(p.pi, { root, pollMs: 100_000, liveSessions: async () => { probes++; return new Set(); },
    launch: async () => {}, stopWorkerTerminal: async (_dir, _worker, validate) => validate() });
  await p.start();
  assert.equal(p.statuses.get("orchestrator"), "Orchestrator: idle | Live Workers: 0");
  const result = await p.call("spawn_worker", { task: "Work" });
  assert.equal(p.statuses.get("orchestrator"), "Orchestrator: waiting on worker | Live Workers: 1");
  const dir = workerDirectory(parentDirectory(root, "parent"), result.details.worker_id);
  saveWorker(dir, { ...readWorker(dir), state: "waiting" });
  await p.call("stop_worker", { worker_id: result.details.worker_id });
  assert.equal(p.statuses.get("orchestrator"), "Orchestrator: idle | Live Workers: 0");
  assert.equal(probes, 0);
});

test("slow snapshots do not overlap or overwrite a newer stop; shutdown stops polling", async (t) => {
  const { root, p, add } = setup(t);
  add("w", "waiting");
  let probes = 0;
  let release: ((sessions: Set<string>) => void) | undefined;
  orchestrator(p.pi, { root, pollMs: 5,
    liveSessions: async () => { probes++; return probes === 1 ? new Set(["pi-parent-w"]) : new Promise((resolve) => { release = resolve; }); },
    stopWorkerTerminal: async (_dir, _worker, validate) => validate() });
  await p.start();
  await until(() => !!release);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(probes, 2, "at most one snapshot in flight");
  await p.call("stop_worker", { worker_id: "w" });
  release!(new Set(["pi-parent-w"]));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(p.statuses.get("orchestrator"), "Orchestrator: idle | Live Workers: 0");
  await p.close();
  release?.(new Set(["pi-parent-w"]));
  const afterClose = probes;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(probes, afterClose);
  assert.equal(p.statuses.get("orchestrator"), undefined);
});
