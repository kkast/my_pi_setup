import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Worker } from "./store.ts";

const exec = promisify(execFile);
type Process = { pid: number; ppid: number; pgid: number; command: string };

export function lastActivity(worker: Worker): string {
  if (!worker.sessionFile || !existsSync(worker.sessionFile)) return "No saved session activity available";
  try {
    const lines = readFileSync(worker.sessionFile, "utf8").trimEnd().split("\n").slice(-100).reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;
      const msg = entry.message;
      const tools = msg?.content?.filter((part: any) => part.type === "toolCall").map((part: any) => part.name);
      const text = msg?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join(" ");
      if (tools?.length || text) return `${msg.role}: ${tools?.length ? `tools ${tools.join(", ")}; ` : ""}${(text ?? "").replace(/\s+/g, " ").slice(0, 240)}`;
    }
  } catch { return "Saved session activity unreadable"; }
  return "No saved session activity available";
}

// Retain descendants seen while Pi is alive: after its exit they may be reparented.
export async function childProcesses(worker: Worker, seen: Set<number>): Promise<string> {
  if (!worker.panePid) return "Unknown (pane PID unavailable)";
  try {
    const { stdout } = await exec("ps", ["-eo", "pid=,ppid=,pgid=,args="], { timeout: 5_000 });
    const processes: Process[] = stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], command: match[4] }] : [];
    });
    const related = new Set([worker.panePid, ...seen]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const proc of processes) {
        if (!related.has(proc.pid) && (related.has(proc.ppid) || proc.pgid === worker.panePid)) {
          related.add(proc.pid); changed = true;
        }
      }
    }
    for (const pid of related) if (pid !== worker.panePid) seen.add(pid);
    const alive = processes.filter((proc) => proc.pid !== worker.panePid && related.has(proc.pid));
    return alive.length ? alive.map((proc) => `${proc.pid} ${proc.command.slice(0, 160)}`).join("; ").slice(0, 2_000) : "None observed";
  } catch { return "Unable to inspect processes"; }
}
