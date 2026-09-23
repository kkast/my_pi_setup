import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compactionNotice, contextHealth } from "../context.ts";
import type { Report } from "../store.ts";

const report: Report = { status: "ready_for_review", summary: "Done", checks: [] };
const compact = (id: string): SessionEntry => ({
  type: "compaction", id, parentId: null, timestamp: "2026-01-02T03:04:05.000Z",
  summary: "Summary", firstKeptEntryId: "start", tokensBefore: 10,
});
const instruction: SessionEntry = {
  type: "custom_message", id: "start", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
  customType: "my-pi-mail", content: "Work", display: true, details: { messageId: "assignment" },
};

test("branch compaction metadata includes persisted IDs and distinguishes assignment from report interval", () => {
  const health = contextHealth([compact("old"), instruction, compact("new")], undefined, "assignment");
  assert.deepEqual(health, {
    compaction_count: 2, latest_compaction_at: "2026-01-02T03:04:05.000Z",
    compacted_since_previous_report: true, compacted_during_assignment: true,
    tokens_before_compaction: null, compaction_ids: ["old", "new"],
  });
  const published = JSON.parse(JSON.stringify({ ...report, context_health: health }));
  assert.equal(contextHealth([compact("old"), compact("new"), instruction], published, "assignment").compacted_since_previous_report, false);
  assert.equal(contextHealth([compact("old"), instruction], undefined, "assignment").compacted_during_assignment, false);
  // Equal counts on different branches must not mask a new compaction ID.
  assert.equal(contextHealth([compact("other"), compact("new")], published, "assignment").compacted_since_previous_report, true);
  assert.match(compactionNotice(published), /occurred during this assignment.*Reaffirm critical constraints/);
});

test("empty branches, legacy reports and missing assignment receipts preserve unknowns", () => {
  assert.deepEqual(contextHealth([], undefined, undefined), {
    compaction_count: 0, latest_compaction_at: null, compacted_since_previous_report: false,
    compacted_during_assignment: null, tokens_before_compaction: null, compaction_ids: [],
  });
  assert.equal(contextHealth([compact("a")], report, "absent").compacted_since_previous_report, null);
  assert.equal(compactionNotice(report), "");
  assert.match(compactionNotice({ ...report, context_health: contextHealth([compact("a")], undefined, "absent") }), /since the prior published report/);
});
