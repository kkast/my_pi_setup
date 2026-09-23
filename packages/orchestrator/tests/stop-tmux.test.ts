import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveSessions, shellQuote, stopWorkerTerminal } from "../tmux.ts";

let tmux: string | undefined;
try { tmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); } catch { /* skip */ }

test("real private tmux stop verifies ownership and leaves other sessions alive", { skip: !tmux }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-stop-test-"));
  const socket = `pi-stop-${randomUUID()}`;
  const path = process.env.PATH;
  const run = (...args: string[]) => execFileSync(tmux!, ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  writeFileSync(join(dir, "tmux"), `#!/bin/sh\nexec ${shellQuote(tmux!)} -L ${shellQuote(socket)} "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    try { run("kill-server"); } catch { /* only our private server */ }
    rmSync(dir, { recursive: true, force: true });
  });
  run("new-session", "-d", "-s", "unrelated", "sleep 60");
  run("new-session", "-d", "-s", "pi-parent-w", "-e", `MY_PI_WORKER_DIR=${dir}`, "sleep 60");
  assert.deepEqual(await liveSessions(), new Set(["unrelated", "pi-parent-w"]));
  const worker = { id: "w", parentId: "parent", sessionId: "w", tmux: "pi-parent-w", cwd: dir, state: "waiting" as const,
    panePid: Number(run("display-message", "-p", "-t", "=pi-parent-w:0.0", "#{pane_pid}")) };
  await assert.rejects(stopWorkerTerminal(dir, { ...worker, tmux: "unrelated" }, () => {}), /ownership/);
  await assert.rejects(stopWorkerTerminal(dir, { ...worker, panePid: worker.panePid + 1 }, () => {}), /ownership/);
  await assert.rejects(stopWorkerTerminal("wrong-directory", worker, () => {}), /ownership/);
  await assert.rejects(stopWorkerTerminal(dir, worker, () => { throw new Error("now running"); }), /now running/);
  run("has-session", "-t", "=pi-parent-w");
  await stopWorkerTerminal(dir, worker, () => {});
  assert.throws(() => run("has-session", "-t", "=pi-parent-w"));
  run("has-session", "-t", "=unrelated");
  assert.deepEqual(await liveSessions(), new Set(["unrelated"]));
  await stopWorkerTerminal(dir, worker, () => {}); // already absent
  // Reused name is not the owned pane and must never be killed.
  run("new-session", "-d", "-s", "pi-parent-w", "sleep 60");
  await assert.rejects(stopWorkerTerminal(dir, worker, () => {}));
  run("has-session", "-t", "=pi-parent-w");
  run("kill-session", "-t", "=pi-parent-w");
  run("kill-session", "-t", "=unrelated");
  await stopWorkerTerminal(dir, worker, () => {}); // no server
  assert.deepEqual(await liveSessions(), new Set());
});
