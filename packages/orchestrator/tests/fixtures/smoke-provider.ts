// Test-only deterministic model. Never installed by the package manifest.
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAssistantMessageEventStream, getCurrentTools,
  type AssistantMessage, type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const directory = process.env.PI_CODING_AGENT_DIR!;
  let calls = 0;
  pi.registerProvider("my-pi-smoke", {
    baseUrl: "http://unused.invalid", apiKey: "local-test-only", api: "my-pi-smoke-api",
    models: [{
      id: "mock", name: "Local test model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    }],
    streamSimple(model, context) {
      calls++;
      const stream = createAssistantMessageEventStream();
      const isWorker = Boolean(process.env.MY_PI_WORKER_DIR);
      const transcript = JSON.stringify(context.messages);
      const toolNames = getCurrentTools(context.messages).map((tool) => tool.name);
      appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({
        worker: process.env.MY_PI_WORKER_DIR ?? null, calls, toolNames, transcript,
      }) + "\n");
      const output: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "pending", content: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        try {
          let call: Pick<ToolCall, "name" | "arguments"> | undefined;
          if (isWorker) {
            assert.ok(toolNames.includes("report_to_parent"));
            assert.ok(!toolNames.includes("spawn_worker"));
            assert.ok(!toolNames.includes("send_to_worker"));
            const isA = transcript.includes("Implement step A");
            const summary = isA ? (calls === 1 ? "Need clarification" : "A finished with preserved context") : "B found clarification";
            if (isA && calls === 2) {
              assert.ok(transcript.includes("Need clarification"));
              assert.ok(transcript.includes("Use B findings"));
            }
            call = { name: "report_to_parent", arguments: {
              status: isA && calls === 1 ? "needs_input" : "ready_for_review", summary, checks: ["Local smoke fixture"],
            } };
          } else {
            assert.ok(toolNames.includes("spawn_worker"));
            assert.ok(!toolNames.includes("report_to_parent"));
            if (calls === 1) call = { name: "spawn_worker", arguments: { task: "Implement step A" } };
            else if (calls === 2) {
              assert.ok(transcript.includes("Need clarification"));
              call = { name: "spawn_worker", arguments: { task: "Investigate step B" } };
            } else if (calls === 3) {
              assert.ok(transcript.includes("B found clarification"));
              const spawn = context.messages.find((msg) => msg.role === "toolResult" && msg.toolName === "spawn_worker");
              assert.ok(spawn && spawn.role === "toolResult");
              const content = spawn.content[0];
              assert.equal(content.type, "text");
              const folder = /^Folder: (.+)$/m.exec(content.type === "text" ? content.text : "")?.[1];
              assert.ok(folder, "spawn output includes worker folder");
              const workerId = folder.split("/").at(-1)!;
              call = { name: "send_to_worker", arguments: { worker_id: workerId, message: "Use B findings and finish step A" } };
            } else {
              assert.equal(calls, 4, "extra model turn: handoff failed to yield");
              assert.ok(transcript.includes("A finished with preserved context"));
            }
          }
          stream.push({ type: "start", partial: output });
          if (call) {
            const block: ToolCall = { type: "toolCall", id: `call-${calls}`, ...call };
            output.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
            output.stopReason = "toolUse";
          } else {
            output.content.push({ type: "text", text: "ORCHESTRATION_SMOKE_OK" });
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "ORCHESTRATION_SMOKE_OK", partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: "ORCHESTRATION_SMOKE_OK", partial: output });
            output.stopReason = "stop";
          }
          stream.push({ type: "done", reason: output.stopReason, message: output });
          stream.end();
        } catch (error) {
          output.stopReason = "error";
          output.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
        }
      });
      return stream;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    writeFileSync(join(directory, `${ctx.sessionManager.getSessionId()}.ready`), "ready");
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!process.env.MY_PI_WORKER_DIR && calls === 4) {
      const branch = JSON.stringify(ctx.sessionManager.getBranch());
      if (branch.includes("ORCHESTRATION_SMOKE_OK")) {
        writeFileSync(join(directory, "success"), ctx.sessionManager.getSessionFile()!);
      }
    }
  });
}
