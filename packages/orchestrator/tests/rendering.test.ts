import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
// Deliberately exercise Pi's real row composition, not just renderCall in isolation.
import { ToolExecutionComponent } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import orchestrator from "../index.ts";

// This synthetic parent must never adopt the test runner's live worker linkage.
delete process.env.MY_PI_WORKER_DIR;

test("Pi restores handoff rows before session_start without generic JSON fallback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-rendering-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => orchestrator(pi, { root })],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json"),
  });
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, resourceLoader: loader, settingsManager, modelRuntime,
    sessionManager: SessionManager.inMemory(root),
  });
  t.after(() => session.dispose());
  initTheme("dark");
  // InteractiveMode's reload/replacement flow renders history before binding
  // extensions (and thus before session_start). It captures this definition once.
  for (const name of ["spawn_worker", "send_to_worker"]) {
    const definition = session.getToolDefinition(name);
    assert.ok(definition, `${name} must be available before session_start`);
    const title = "Complete API ownership and test fixture follow-up without losing context";
    const followUp = "Verify fixture registration and final compatibility checks across worker sessions";
    const label = name === "spawn_worker" ? `Worker: ${title}` : `Continuing: ${title} — ${followUp}`;
    const settings = name === "spawn_worker"
      ? "\nModel: custom-provider/vendor/long-model-identifier:version\nThinking: high"
      : "";
    const body = `${label}${settings}\nFolder: /tmp/orchestration/parent/workers/worker-id\nAttach: tmux attach -t pi-parent-worker-id`;
    const args = { title, task: "PRIVATE_TASK ".repeat(1000), message: "PRIVATE_MESSAGE ".repeat(1000), worker_id: "worker-id" };
    const row = new ToolExecutionComponent(name, "call", {}, {}, definition, { requestRender() {} } as unknown as TUI, root);
    row.updateArgs(args);
    row.setArgsComplete();
    row.markExecutionStarted();
    assert.equal(row.render(40).map(stripVTControlCharacters).join("").trim(), "");
    row.updateResult({ content: [{ type: "text", text: body }], details: {}, isError: false });
    for (const expanded of [false, true]) {
      row.setExpanded(expanded);
      for (const width of [24, 40, 80, 120]) {
        row.invalidate();
        const lines = row.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        // Ignore only wrapping/padding whitespace; every visible character must survive.
        const rendered = lines.map(stripVTControlCharacters).join("").replace(/\s/g, "");
        assert.equal(rendered, body.replace(/\s/g, ""));
      }
    }
    row.updateResult({ content: [{ type: "text", text: "Worker terminal is not running." }], isError: true });
    assert.match(row.render(80).map(stripVTControlCharacters).join("\n"), /Worker terminal is not running\./);
  }

  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error) });
  const assertParentTools = () => {
    const active = session.getActiveToolNames();
    assert.ok(active.includes("spawn_worker"));
    assert.ok(active.includes("send_to_worker"));
    assert.ok(active.includes("read"), "role filtering must preserve other tools");
    assert.ok(!active.includes("report_to_parent"));
  };
  assertParentTools();
  let restored = false;
  await session.reload({ beforeSessionStart: async () => {
    restored = true;
    for (const name of ["spawn_worker", "send_to_worker"]) {
      const definition = session.getToolDefinition(name);
      assert.equal(typeof definition?.renderCall, "function");
      assert.equal(typeof definition?.renderResult, "function");
    }
  } });
  assert.ok(restored, "real reload must expose definitions before session_start");
  assertParentTools();
  assert.deepEqual(errors, []);
});
