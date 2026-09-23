import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// A small lifecycle double; tmux/real Pi are covered separately by the smoke test.
export function harness(id: string, entries: any[] = []) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  let activeTools: string[] = [];
  const commands = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const delivered: any[] = [];
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  let idle = true;
  const ctx = {
    mode: "tui", cwd: "/tmp", model: { provider: "test", id: "model" }, thinkingLevel: "high",
    isIdle: () => idle,
    getContextUsage: () => undefined,
    isProjectTrusted: () => false,
    waitForIdle: async () => { if (!idle) throw new Error("Test agent not idle"); },
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/tmp/${id}.jsonl`,
      getEntries: () => entries,
      getBranch: () => entries,
    },
    modelRegistry: { find: (provider: string, modelId: string) => ({ provider, id: modelId }) },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
    },
  } as unknown as ExtensionContext;

  async function emit(name: string, event: unknown = {}) {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  }
  const modelChanges: any[] = [];
  const thinkingChanges: any[] = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: any) => { tools.set(tool.name, tool); activeTools.push(tool.name); },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer: (name: string, renderer: any) => entryRenderers.set(name, renderer),
    getThinkingLevel: () => "medium",
    setModel: async (model: any) => { modelChanges.push(model); return true; },
    setThinkingLevel: (level: any) => thinkingChanges.push(level),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (msg: any, options: any) => {
      delivered.push(msg);
      entries.push({ type: "custom_message", ...msg });
      void emit("message_end", { message: { role: "custom", ...msg } });
      if (options?.triggerTurn) {
        idle = false;
        void emit("agent_start");
      }
    },
    sendUserMessage: (content: unknown) => delivered.push({ content }),
  } as unknown as ExtensionAPI;

  return {
    pi, ctx, entries, tools, commands, entryRenderers, delivered, notices, statuses, modelChanges, thinkingChanges, emit,
    async start() { await emit("session_start", { reason: "startup" }); },
    async settle() { idle = true; await emit("agent_settled"); },
    async close(reason = "quit") { await emit("session_shutdown", { reason }); },
    setIdle(value: boolean) { idle = value; },
    call(name: string, args: unknown, signal = new AbortController().signal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute("test-call", args, signal, undefined, ctx);
    },
  };
}

export async function until(predicate: () => boolean, timeout = 2_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
