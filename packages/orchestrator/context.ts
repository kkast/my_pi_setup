import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Report } from "./store.ts";

/** Read the full active branch, not the compacted context or other branches. */
export function contextHealth(branch: SessionEntry[], previous: Report | undefined, instructionId: string | undefined): NonNullable<Report["context_health"]> {
  const compactions = branch.filter((entry) => entry.type === "compaction");
  const priorIds = previous ? previous.context_health?.compaction_ids : [];
  const assignmentStart = instructionId === undefined ? -1 : branch.findIndex((entry) => entry.type === "custom_message" &&
    entry.customType === "my-pi-mail" && (entry.details as { messageId?: string } | undefined)?.messageId === instructionId);
  return {
    compaction_count: compactions.length,
    latest_compaction_at: compactions.at(-1)?.timestamp ?? null,
    compacted_since_previous_report: priorIds
      ? compactions.some((entry) => !priorIds.includes(entry.id)) : null,
    compacted_during_assignment: assignmentStart < 0 ? null
      : branch.slice(assignmentStart + 1).some((entry) => entry.type === "compaction"),
    // ExtensionContext does not expose the live SettingsManager. Reading a new
    // one from disk could miss in-memory overrides/toggles; do not guess.
    tokens_before_compaction: null,
    compaction_ids: compactions.map((entry) => entry.id),
  };
}

export function compactionNotice(report: Report): string {
  if (report.context_health?.compacted_during_assignment) {
    return "NOTICE: Context compaction occurred during this assignment. Reaffirm critical constraints before continuing.\n";
  }
  if (report.context_health?.compacted_since_previous_report) {
    return "NOTICE: Context compaction occurred since the prior published report (or before this first report). Reaffirm critical constraints before continuing.\n";
  }
  return "";
}
