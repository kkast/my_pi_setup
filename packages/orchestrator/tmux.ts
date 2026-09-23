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

export async function launch(options: Parameters<typeof launchArguments>[0]): Promise<void> {
  await exec("tmux", launchArguments(options), { timeout: 10_000 });
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
