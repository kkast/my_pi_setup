import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, validateToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import orchestrator from "../index.ts";
import { parentDirectory, readWorker, saveWorker } from "../store.ts";
import { launchArguments } from "../tmux.ts";
import { harness } from "../../../tests/harness.ts";

delete process.env.MY_PI_WORKER_DIR;

async function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-worker-settings-"));
  const modelsPath = join(root, "models.json");
  const provider = (ids: string[], authenticated = true) => ({
    baseUrl: "http://localhost:1/v1", api: "openai-completions",
    ...(authenticated ? { apiKey: "local-placeholder" } : {}),
    models: ids.map((id) => ({ id, reasoning: id !== "plain" })),
  });
  writeFileSync(modelsPath, JSON.stringify({ providers: {
    "worker-test-a": provider(["shared", "unique", "vendor/model:tag", "plain"]),
    "worker-test-b": provider(["shared"]),
    "worker-test-no-auth": provider(["locked"], false),
  } }));
  const runtime = await ModelRuntime.create({ modelsPath, modelsStorePath: join(root, "catalog.json"), credentials: new InMemoryCredentialStore() });
  const parent = harness("settings-parent");
  parent.ctx.model = { ...parent.ctx.model!, reasoning: true };
  const agents = [parent];
  const launches: Parameters<typeof launchArguments>[0][] = [];
  const overrides = { root, pollMs: 60_000, isAlive: async () => true, launch: async (options: Parameters<typeof launchArguments>[0]) => { launches.push(options); } };
  (parent.ctx as any).modelRegistry = new ModelRegistry(runtime);
  orchestrator(parent.pi, overrides);
  t.after(async () => {
    for (const agent of agents) await agent.close();
    rmSync(root, { recursive: true, force: true });
  });
  await parent.start();
  return { root, parent, launches, agents, overrides };
}

for (const [name, args, expected, effectiveThinking] of [
  ["defaults", {}, ["test", "model", "high"]],
  ["model only", { model: "worker-test-b/shared" }, ["worker-test-b", "shared", "high"]],
  ["thinking only", { thinking: "off" }, ["test", "model", "off"]],
  ["both", { model: "worker-test-a/unique", thinking: "low" }, ["worker-test-a", "unique", "low"]],
  ["unique bare ID", { model: "unique" }, ["worker-test-a", "unique", "high"]],
  ["slashes and colon in exact ID", { model: "worker-test-a/vendor/model:tag", thinking: "max" }, ["worker-test-a", "vendor/model:tag", "max"], "high"],
  ["non-reasoning model leaves clamping to Pi", { model: "worker-test-a/plain", thinking: "xhigh" }, ["worker-test-a", "plain", "xhigh"], "off"],
] as const) {
  test(`worker settings: ${name} forwarded to tmux CLI without changing parent`, async (t) => {
    const { parent, launches } = await setup(t);
    const result = await parent.call("spawn_worker", { task: "Check settings", ...args });
    const [options] = launches;
    assert.equal(result.content[0].text, `Worker: Check settings\nModel: ${expected[0]}/${expected[1]}\nThinking: ${effectiveThinking ?? expected[2]}\nFolder: ${options.dir}\nAttach: ${result.details.attach}`);
    assert.deepEqual([options.provider, options.model, options.thinking], expected);
    const command = launchArguments(options).at(-1)!;
    assert.ok(command.includes(`'--provider' '${expected[0]}' '--model' '${expected[1]}' '--thinking' '${expected[2]}'`));
    assert.deepEqual(parent.modelChanges, []);
    assert.deepEqual(parent.thinkingChanges, []);
    assert.equal(parent.ctx.model?.id, "model");
    assert.equal(parent.ctx.thinkingLevel, "high");
  });
}

test("worker settings: thinking fallback and every Pi enum level", async (t) => {
  const { parent, launches } = await setup(t);
  (parent.ctx as any).thinkingLevel = undefined;
  const fallback = await parent.call("spawn_worker", { task: "Fallback" });
  assert.match(fallback.content[0].text, /\nModel: test\/model\nThinking: medium\n/);
  assert.equal(launches[0].thinking, "medium");
  const tool = parent.tools.get("spawn_worker");
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const last = launches.at(-1)!;
    saveWorker(last.dir, { ...readWorker(last.dir), state: "waiting" });
    const args = validateToolCall([tool], { type: "toolCall", id: "test", name: "spawn_worker", arguments: { task: "Level", thinking } });
    await parent.call("spawn_worker", args);
    assert.equal(launches.at(-1)!.thinking, thinking);
  }
});

test("worker settings: invalid selections leave no metadata, mail, or launch", async (t) => {
  const { root, parent, launches } = await setup(t);
  const before = readdirSync(root, { recursive: true });
  for (const [args, error] of [
    [{ model: "missing" }, /Unknown worker model/],
    [{ model: "worker-test-a/uni" }, /Unknown worker model/],
    [{ model: "unique:high" }, /Unknown worker model/],
    [{ model: "shared" }, /Ambiguous worker model.*worker-test-a\/shared.*worker-test-b\/shared/],
    [{ model: "" }, /Unknown worker model/],
    [{ model: "worker-test-no-auth/locked" }, /Authentication is not configured/],
    [{ thinking: "ultra" }, /Invalid worker thinking/],
    [{ thinking: null }, /Invalid worker thinking/],
  ] as const) {
    await assert.rejects(parent.call("spawn_worker", { task: "Invalid", ...args }), error);
    assert.equal(launches.length, 0);
    assert.deepEqual(readdirSync(root, { recursive: true }), before);
    assert.equal(existsSync(parentDirectory(root, "settings-parent")), false);
  }
  assert.throws(() => validateToolCall([parent.tools.get("spawn_worker")], {
    type: "toolCall", id: "invalid", name: "spawn_worker", arguments: { task: "Invalid", thinking: "ultra" },
  }));
  await parent.call("spawn_worker", { task: "Still usable", model: "unique" });
  assert.equal(launches.length, 1);
});

test("worker settings: overrides preserve role isolation and continuation", async (t) => {
  const { parent, launches, agents, overrides } = await setup(t);
  const result = await parent.call("spawn_worker", { task: "Work", model: "unique", thinking: "low" });
  const child = harness(result.details.pi_session_id, [{ type: "custom", customType: "my-pi-worker", data: { directory: launches[0].dir } }]);
  agents.push(child);
  orchestrator(child.pi, overrides);
  await child.start();
  assert.deepEqual(child.pi.getActiveTools(), ["report_to_parent"]);
  await assert.rejects(child.call("spawn_worker", { task: "Nested", model: "unique", thinking: "low" }), /Workers cannot dispatch/);
  await child.call("report_to_parent", { status: "ready_for_review", summary: "Done", checks: [] });
  await child.settle();
  await parent.call("send_to_worker", { worker_id: result.details.worker_id, message: "Check once more" });
  assert.equal(launches.length, 1);
  assert.deepEqual(parent.modelChanges, []);
  assert.deepEqual(child.modelChanges, []);
  assert.deepEqual(child.thinkingChanges, []);
});
