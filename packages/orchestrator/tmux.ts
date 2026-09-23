import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Worker } from "./store.ts";

const exec = promisify(execFile);

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function launchArguments(options: {
  dir: string;
  worker: Worker;
  extension: string;
  provider: string;
  model: string;
  thinking: string;
  trusted: boolean;
  env: NodeJS.ProcessEnv;
}): string[] {
  const { dir, worker, extension, provider, model, thinking, trusted, env } = options;
  // Pass explicitly: an existing tmux server may have an old PATH/config env.
  const environment = ["MY_PI_WORKER_DIR=" + dir, "PATH=" + (env.PATH ?? "")];
  for (const name of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"]) {
    if (env[name] !== undefined) environment.push(`${name}=${env[name]}`);
  }
  const command = [
    "pi", "--session-dir", join(dir, "sessions"), "--session-id", worker.sessionId,
    "--name", `Worker ${worker.id}`, "--provider", provider, "--model", model,
    "--thinking", thinking, trusted ? "--approve" : "--no-approve",
    "--extension", extension,
  ];
  return [
    "new-session", "-d", "-s", worker.tmux, "-c", worker.cwd,
    ...environment.flatMap((entry) => ["-e", entry]),
    `exec ${command.map(shellQuote).join(" ")}`,
  ];
}

export async function launch(options: Parameters<typeof launchArguments>[0]): Promise<number | undefined> {
  await exec("tmux", launchArguments(options), { timeout: 10_000 });
  try {
    const { stdout } = await exec("tmux", ["display-message", "-p", "-t", `=${options.worker.tmux}:0.0`, "#{pane_pid}"], { timeout: 5_000 });
    const pid = Number(stdout.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    // A very short-lived Pi may already have closed the pane; the parent poller diagnoses it.
    return undefined;
  }
}

// Fail closed: only a positively identified, single-pane worker terminal may
// be destroyed. Session IDs avoid tmux's prefix matching and name reuse.
export async function stopWorkerTerminal(dir: string, worker: Worker, beforeKill: () => void): Promise<void> {
  if (worker.tmux !== `pi-${worker.parentId.slice(0, 12)}-${worker.id}`) {
    throw new Error("Worker terminal name does not match its ownership metadata.");
  }
  const run = async (args: string[]) => (await exec("tmux", args, { timeout: 5_000 })).stdout.trim();
  let sessions: string;
  try {
    sessions = await run(["list-sessions", "-F", "#{session_name}\t#{session_id}"]);
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string };
    // These are the only absence cases; permission/timeout/binary errors fail.
    if (failure.code === 1 && /^(no server running on |error connecting to .* \(No such file or directory\))/.test(failure.stderr ?? "")) return;
    throw error;
  }
  const session = sessions.split("\n").map((line) => line.split("\t")).find(([name]) => name === worker.tmux)?.[1];
  if (!session) return;
  if (!/^\$\d+$/.test(session)) throw new Error("Invalid tmux session identity.");
  const panes = await run(["list-panes", "-s", "-t", session, "-F", "#{pane_pid}"]);
  const environment = await run(["show-environment", "-t", session, "MY_PI_WORKER_DIR"]);
  if (!worker.panePid || panes !== String(worker.panePid) || environment !== `MY_PI_WORKER_DIR=${dir}`) {
    throw new Error("Cannot verify exclusive ownership of worker terminal; inspect it manually.");
  }
  beforeKill();
  await run(["kill-session", "-t", session]);
}

// One asynchronous snapshot per parent poll, independent of roster size.
export async function liveSessions(): Promise<Set<string>> {
  try {
    const { stdout } = await exec("tmux", ["list-sessions", "-F", "#{session_name}"], { timeout: 5_000 });
    return new Set(stdout.trim().split("\n").filter(Boolean));
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string };
    if (failure.code === 1 && /^(no server running on |error connecting to .* \(No such file or directory\))/.test(failure.stderr ?? "")) return new Set();
    throw error;
  }
}

export async function isAlive(name: string): Promise<boolean> {
  try {
    await exec("tmux", ["has-session", "-t", `=${name}`], { timeout: 5_000 });
    return true;
  } catch (error) {
    // A missing tmux binary is not the same as a missing worker session.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    return false;
  }
}
