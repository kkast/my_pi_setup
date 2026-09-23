import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { atomicJson, messages, parentDirectory, readWorker, workers } from "../store.ts";
import { shellQuote } from "../tmux.ts";
import { until } from "../../../tests/harness.ts";

const setupRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let tmux: string | undefined;
try { tmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); } catch { /* skipped below */ }

test("real Pi + private tmux: spawn, report, investigate, continue, persist", { skip: !tmux, timeout: 90_000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "my-pi-smoke-"));
  const socket = `my-pi-test-${randomUUID()}`;
  const parentId = randomUUID();
  const config = join(temp, "agent");
  const bin = join(temp, "bin");
  mkdirSync(config); mkdirSync(bin);
  // All parent/worker tmux operations stay on an owned server, not the user's.
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexec ${shellQuote(tmux!)} -L ${shellQuote(socket)} "$@"\n`, { mode: 0o700 });
  const path = `${bin}:${join(setupRoot, "node_modules", ".bin")}:${process.env.PATH}`;
  const run = (...args: string[]) => execFileSync(tmux!, ["-L", socket, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    try { run("kill-server"); } catch { /* already gone */ }
    assert.throws(() => run("list-sessions"), "owned test tmux server must be stopped");
    rmSync(temp, { recursive: true, force: true });
  });
  atomicJson(join(config, "settings.json"), {
    packages: [setupRoot],
    extensions: [join(setupRoot, "packages", "orchestrator", "tests", "fixtures", "smoke-provider.ts")],
    defaultProvider: "my-pi-smoke", defaultModel: "mock", defaultThinkingLevel: "off",
    lastChangelogVersion: "0.86.1", enableInstallTelemetry: false,
    retry: { enabled: false },
  });
  const command = [
    "pi", "--session-id", parentId, "--session-dir", join(temp, "parent-sessions"),
    "--provider", "my-pi-smoke", "--model", "mock", "--thinking", "off", "--no-approve",
    "--", "Run the local orchestration smoke test",
  ].map(shellQuote).join(" ");
  run("new-session", "-d", "-s", "smoke-parent", "-c", temp,
    "-e", `PATH=${path}`, "-e", `PI_CODING_AGENT_DIR=${config}`, "-e", "PI_OFFLINE=1", "-e", "PI_TELEMETRY=0",
    `exec ${command}`);
  try {
    await until(() => existsSync(join(config, "success")), 60_000);
    const registry = workers(parentDirectory(join(config, "orchestration"), parentId));
    assert.equal(registry.length, 2);
    for (const { dir, worker } of registry) {
      assert.equal(worker.state, "waiting");
      assert.ok(worker.sessionFile && existsSync(worker.sessionFile));
      const transcript = readFileSync(worker.sessionFile!, "utf8");
      assert.ok(transcript.includes('"customType":"my-pi-worker"'));
      assert.ok(transcript.includes('"customType":"my-pi-mail"'));
      run("has-session", "-t", `=${worker.tmux}`);
      assert.equal(readWorker(dir).sessionId, worker.id);
    }
    const calls = readFileSync(join(config, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => !call.worker).length, 4);
    assert.equal(calls.filter((call) => call.worker).length, 3);
    assert.equal(registry.reduce((n, { dir }) => n + messages(dir, "report").length, 0), 3);
    const parentFile = readFileSync(join(config, "success"), "utf8");
    const parentTranscript = readFileSync(parentFile, "utf8");
    assert.ok(parentTranscript.includes("ORCHESTRATION_SMOKE_OK"));
    if (existsSync(join(setupRoot, "packages", "last-reply-time", "index.ts"))) {
      assert.ok(parentTranscript.includes('\"customType\":\"last-reply-time\"'), "timestamp package loaded through root manifest");
    }
    assert.equal(readdirSync(join(temp, "parent-sessions")).length, 1);

    // Resume real saved sessions, without the worker launch environment.
    // Old mail must not retrigger model calls or turn a worker into a parent.
    const firstWorker = registry[0].worker;
    for (const target of [
      { name: "smoke-parent", id: parentId, file: parentFile },
      { name: firstWorker.tmux, id: firstWorker.sessionId, file: firstWorker.sessionFile! },
    ]) {
      run("kill-session", "-t", `=${target.name}`);
      unlinkSync(join(config, `${target.id}.ready`));
      const resume = ["pi", "--session", target.file, "--no-approve"].map(shellQuote).join(" ");
      run("new-session", "-d", "-s", target.name, "-c", temp,
        "-e", `PATH=${path}`, "-e", `PI_CODING_AGENT_DIR=${config}`, "-e", "PI_OFFLINE=1", "-e", "PI_TELEMETRY=0",
        `exec ${resume}`);
      await until(() => existsSync(join(config, `${target.id}.ready`)), 10_000);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const callsAfterResume = readFileSync(join(config, "calls.jsonl"), "utf8").trim().split("\n");
    assert.equal(callsAfterResume.length, calls.length, "resume must not replay consumed messages");
    assert.equal(readWorker(registry[0].dir).state, "waiting");
  } catch (error) {
    let diagnostics = "";
    try {
      const sessions = run("list-sessions", "-F", "#{session_name}").trim().split("\n");
      for (const name of sessions) diagnostics += `\n${name}:\n${run("capture-pane", "-p", "-S", "-100", "-t", name)}`;
    } catch { /* launch failure */ }
    throw new Error(`${String(error)}\n${diagnostics}`);
  }
});
