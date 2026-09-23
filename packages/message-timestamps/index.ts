import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const entryType = "message-timestamp";
const clock = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "Etc/GMT-3",
});
type Stamp = { at: number; role: string };

export default function messageTimestamps(pi: ExtensionAPI) {
  let pending: Stamp | undefined;
  // Custom entries are displayed in the transcript but excluded from model context.
  pi.registerEntryRenderer<Stamp>(entryType, (entry, _options, theme) =>
    new Text(theme.fg("dim", `${entry.data?.role ?? "message"} · ${clock.format(entry.data?.at ?? Date.now())} GMT+3`), 0, 0),
  );

  function flush() {
    if (pending) pi.appendEntry(entryType, pending);
    pending = undefined;
  }

  pi.on("session_start", () => { pending = undefined; });
  // message_end fires *before* Pi persists the message. Flush when the next
  // message starts, after Pi has saved the previous one, to keep their order.
  pi.on("message_start", flush);
  pi.on("message_end", (event) => {
    const { role, timestamp } = event.message;
    if (role !== "user" && role !== "assistant" && role !== "custom") return;
    if (role === "custom" && event.message.display === false) return;
    pending = { role, at: typeof timestamp === "number" ? timestamp : Date.now() };
  });
  pi.on("agent_settled", flush);
  pi.on("session_shutdown", flush);
}
