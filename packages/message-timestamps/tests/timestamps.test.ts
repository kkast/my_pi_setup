import assert from "node:assert/strict";
import test from "node:test";
import messageTimestamps from "../index.ts";
import { harness } from "../../../tests/harness.ts";

test("each visible message gets an ordered TUI-only timestamp", async () => {
  const h = harness("stamps");
  messageTimestamps(h.pi);
  await h.start();
  assert.ok(h.entryRenderers.has("message-timestamp"));
  const msg = (role: string, timestamp: number) => ({ role, timestamp, content: [{ type: "text", text: "hello" }] });
  await h.emit("message_start", { message: msg("user", 1) });
  await h.emit("message_end", { message: msg("user", 1) });
  assert.equal(h.entries.length, 0, "wait until the user message is saved");
  await h.emit("message_start", { message: msg("assistant", 2) });
  assert.deepEqual(h.entries[0], { type: "custom", customType: "message-timestamp", data: { role: "user", at: 1 } });
  await h.emit("message_end", { message: msg("assistant", 2) });
  await h.settle();
  assert.deepEqual(h.entries[1], { type: "custom", customType: "message-timestamp", data: { role: "assistant", at: 2 } });
  await h.settle();
  assert.equal(h.entries.length, 2, "no duplicate stamps");
});

test("tool-call-only assistant messages get one stamp, not a second tool stamp", async () => {
  const h = harness("stamps");
  messageTimestamps(h.pi);
  await h.start();
  await h.emit("message_end", { message: { role: "custom", timestamp: 3, content: "message" } });
  await h.emit("message_start", { message: { role: "assistant", timestamp: 4 } });
  await h.emit("message_end", { message: { role: "assistant", timestamp: 4, content: [{ type: "toolCall", name: "report_to_parent" }] } });
  await h.emit("message_start", { message: { role: "toolResult", timestamp: 5 } });
  await h.emit("message_end", { message: { role: "toolResult", timestamp: 5 } });
  await h.close("reload");
  assert.deepEqual(h.entries.map((e) => e.data.role), ["custom", "assistant"]);
  const resumed = harness("stamps", h.entries);
  messageTimestamps(resumed.pi);
  await resumed.start();
  await resumed.settle();
  assert.equal(resumed.entries.length, 2);
});
