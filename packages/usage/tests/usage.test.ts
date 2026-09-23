import assert from "node:assert/strict";
import test from "node:test";
import codexUsage, { fetchUsage, formatUsage } from "../index.ts";
import { harness } from "../../../tests/harness.ts";

const token = `x.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
})).toString("base64url")}.x`;

test("formats Codex subscription windows and reset times", () => {
  const result = formatUsage({ plan_type: "plus", rate_limit: {
    primary_window: { used_percent: 22.6, reset_at: 1800000000, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 71, limit_window_seconds: 604800 },
  } });
  assert.match(result, /Codex usage \(plus\): 5h: 23% used, resets/);
  assert.match(result, /Weekly: 71% used/);
  assert.match(result, / UTC/);
  // The API may report only a weekly primary window (e.g. on Pro).
  assert.equal(formatUsage({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 604800 } } }),
    "Codex usage: Weekly: 30% used");
  assert.match(formatUsage({ rate_limit: { primary_window: { used_percent: 30 } } }), /Window \(duration unknown\)/);
  assert.throws(() => formatUsage({}), /no recognizable usage windows/);
});

test("uses authenticated Codex endpoint without exposing token", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string, options: RequestInit) => {
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal((options.headers as Record<string, string>)["ChatGPT-Account-Id"], "account-test");
      assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${token}`);
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25 } } }), { status: 200 });
    }) as typeof fetch;
    assert.equal((await fetchUsage(token)).rate_limit?.primary_window?.used_percent, 25);
    assert.rejects(fetchUsage("bad"), /OAuth token/);
  } finally { globalThis.fetch = original; }
});

test("command warns when OAuth is not configured", async () => {
  const h = harness("usage");
  (h.ctx.modelRegistry as any).getProviderAuth = async () => undefined;
  codexUsage(h.pi);
  await h.commands.get("usage").handler("", h.ctx);
  assert.match(h.notices.at(-1)!, /Log in/);
});
