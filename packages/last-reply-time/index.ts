import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const entryType = "last-reply-time";
const statusKey = "last-reply-time";

const gmtPlus3 = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Etc/GMT-3", // IANA's Etc/GMT signs are reversed.
});

function showTime(ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }, at?: number) {
  ctx.ui.setStatus(statusKey, at === undefined ? undefined : `Last reply: ${gmtPlus3.format(at)} GMT+3`);
}

export default function (pi: ExtensionAPI) {
  let replied = false;

  pi.on("session_start", (_event, ctx) => {
    replied = false;
    const last = [...ctx.sessionManager.getBranch()].reverse().find(
      (entry) => entry.type === "custom" && entry.customType === entryType,
    );
    const at = last?.type === "custom" ? (last.data as { at?: unknown })?.at : undefined;
    showTime(ctx, typeof at === "number" && Number.isFinite(at) ? at : undefined);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && event.message.content.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )) replied = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!replied) return;
    replied = false;
    const at = Date.now();
    pi.appendEntry(entryType, { at });
    showTime(ctx, at);
  });
}
