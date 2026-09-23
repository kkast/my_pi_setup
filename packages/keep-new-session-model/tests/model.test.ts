import assert from "node:assert/strict";
import test from "node:test";
import keepModel from "../index.ts";
import { harness } from "../../../tests/harness.ts";

test("/new carries model and thinking across extension instances once", async () => {
  const oldSession = harness("old");
  keepModel(oldSession.pi);
  await oldSession.emit("session_before_switch", { reason: "new" });
  const newSession = harness("new");
  keepModel(newSession.pi);
  await newSession.emit("session_start", { reason: "new" });
  assert.deepEqual(newSession.modelChanges, [{ provider: "test", id: "model" }]);
  assert.deepEqual(newSession.thinkingChanges, ["high"]);
  await newSession.emit("session_start", { reason: "new" });
  assert.equal(newSession.modelChanges.length, 1);
});

test("resume does not overwrite the resumed session's model", async () => {
  const oldSession = harness("old");
  keepModel(oldSession.pi);
  await oldSession.emit("session_before_switch", { reason: "resume" });
  const resumed = harness("resumed");
  keepModel(resumed.pi);
  await resumed.emit("session_start", { reason: "resume" });
  assert.equal(resumed.modelChanges.length, 0);
});
