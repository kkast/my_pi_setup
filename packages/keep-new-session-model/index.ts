import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi reloads extension instances when replacing a session. Keep the handoff in
// process memory (not on disk) so the new instance can consume it exactly once.
const key = Symbol.for("pi.keep-new-session-model.pending");
type Handoff = {
  provider: string;
  modelId: string;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
};
const shared = globalThis as typeof globalThis & { [key]: Handoff | undefined };

export default function (pi: ExtensionAPI) {
  pi.on("session_before_switch", (event, ctx) => {
    shared[key] = event.reason === "new" && ctx.model
      ? {
          provider: ctx.model.provider,
          modelId: ctx.model.id,
          thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
        }
      : undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    const handoff = shared[key];
    shared[key] = undefined;
    if (event.reason !== "new" || !handoff) return;

    const model = ctx.modelRegistry.find(handoff.provider, handoff.modelId);
    if (!model || !(await pi.setModel(model))) {
      ctx.ui.notify(`Could not restore ${handoff.provider}/${handoff.modelId} in the new session`, "warning");
      return;
    }
    pi.setThinkingLevel(handoff.thinkingLevel);
  });
}
