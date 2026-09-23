import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const endpoint = "https://chatgpt.com/backend-api/wham/usage";

type Window = { used_percent?: unknown; reset_at?: unknown; limit_window_seconds?: unknown };
type Report = {
  rate_limit?: { primary_window?: Window; secondary_window?: Window };
  plan_type?: unknown;
};

function windowText(window: Window | undefined): string | undefined {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return;
  const seconds = window.limit_window_seconds;
  const label = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds === 604800 ? "Weekly" : seconds % 86400 === 0 ? `${seconds / 86400}-day`
      : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)}m`
    : "Window (duration unknown)";
  const resetDate = typeof window.reset_at === "number" ? new Date(window.reset_at * 1000) : undefined;
  const reset = resetDate && Number.isFinite(resetDate.getTime())
    ? `, resets ${resetDate.toISOString().replace("T", " ").slice(0, 16)} UTC` : "";
  return `${label}: ${Math.round(window.used_percent)}% used${reset}`;
}

export function formatUsage(report: Report): string {
  const windows = report.rate_limit;
  const lines = [windowText(windows?.primary_window), windowText(windows?.secondary_window)].filter((x): x is string => !!x);
  if (!lines.length) throw new Error("Codex returned no recognizable usage windows");
  return `Codex usage${typeof report.plan_type === "string" ? ` (${report.plan_type})` : ""}: ${lines.join(" | ")}`;
}

export async function fetchUsage(token: string, signal?: AbortSignal): Promise<Report> {
  // account id is supplied by Pi's OAuth token; never read or expose auth.json.
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Codex OAuth token is required; log in with /login openai-codex");
  let accountId: unknown;
  try {
    accountId = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch { throw new Error("Could not read Codex account from OAuth token"); }
  if (typeof accountId !== "string" || !accountId) throw new Error("Codex OAuth token has no account id");
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status})`);
  return await response.json() as Report;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show current OpenAI Codex 5-hour and weekly usage limits",
    handler: async (_args, ctx) => {
      try {
        const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
        const token = result?.auth.apiKey;
        if (!token || result?.source !== "OAuth") {
          ctx.ui.notify("Log in with /login openai-codex to see subscription usage", "warning");
          return;
        }
        ctx.ui.notify(formatUsage(await fetchUsage(token)), "info");
      } catch (error) {
        // Do not include response bodies or tokens in user-visible errors.
        ctx.ui.notify(error instanceof Error ? error.message : "Codex usage unavailable", "warning");
      }
    },
  });
}
