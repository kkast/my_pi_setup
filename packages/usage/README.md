# Usage

Run `/usage` in Pi to fetch your current OpenAI Codex subscription usage percentages and reset times. Windows are labeled using the duration returned by OpenAI (for example, `5h` or `Weekly`); some accounts report only one window. Reset times are shown in unambiguous UTC. Requires `/login openai-codex` (OAuth); API keys do not provide subscription usage. This is **account quota**, not session context-window usage.

The command obtains the current token from Pi's model registry (including refreshed credentials), reads its account ID from the OAuth JWT, and queries `https://chatgpt.com/backend-api/wham/usage`. Neither the token nor account ID is printed or saved by this extension. No background polling or extra model calls; each invocation makes one request. Availability and response shape of this undocumented endpoint are controlled by OpenAI and may change.
