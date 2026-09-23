import assert from "node:assert/strict";
import test from "node:test";
import lastReplyTime from "../index.ts";
import { harness } from "../../../tests/harness.ts";

test("timestamp is GMT+3, saved on settled text reply, restored on resume", async () => {
  const h = harness("session");
  lastReplyTime(h.pi);
  await h.start();
  assert.equal(h.statuses.get("last-reply-time"), undefined);
  await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done" }] } });
  assert.equal(h.statuses.get("last-reply-time"), undefined);
  await h.settle();
  assert.match(h.statuses.get("last-reply-time")!, /^Last reply: .+ GMT\+3$/);
  assert.equal(h.entries.length, 1);
  await h.settle();
  assert.equal(h.entries.length, 1);
  const resumed = harness("session", h.entries);
  lastReplyTime(resumed.pi);
  await resumed.start();
  assert.equal(resumed.statuses.get("last-reply-time"), h.statuses.get("last-reply-time"));
});

test("tool-only turns and invalid saved times do not produce a reply timestamp", async () => {
  const h = harness("session", [{ type: "custom", customType: "last-reply-time", data: { at: "invalid" } }]);
  lastReplyTime(h.pi);
  await h.start();
  await h.emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } });
  await h.settle();
  assert.equal(h.statuses.get("last-reply-time"), undefined);
  assert.equal(h.entries.length, 1);
});
