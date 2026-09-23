import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Report = {
  status: "ready_for_review" | "needs_input" | "blocked";
  summary: string;
  checks: string[];
  question?: string;
  /** Pi runtime snapshot, attached after the worker settles; never supplied by the model. */
  context_usage?: {
    provider: string;
    model: string;
    tokens: number | null;
    context_window: number;
    percent: number | null;
  } | null;
};

export type Worker = {
  id: string;
  parentId: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  tmux: string;
  state: "queued" | "running" | "waiting" | "stopped";
};

export type Message = {
  id: string;
  parentId: string;
  workerId: string;
} & ({ kind: "instruction"; text: string } | { kind: "report"; report: Report });

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error(`Invalid ID: ${id}`);
  return id;
}

export function parentDirectory(root: string, parentId: string): string {
  return join(root, safeId(parentId));
}

export function workerDirectory(parentDir: string, workerId: string): string {
  return join(parentDir, "workers", safeId(workerId));
}

export function atomicJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readWorker(dir: string): Worker {
  const worker = readJson<Worker>(join(dir, "metadata.json"));
  safeId(worker.id);
  safeId(worker.parentId);
  safeId(worker.sessionId);
  return worker;
}

export function saveWorker(dir: string, worker: Worker): void {
  atomicJson(join(dir, "metadata.json"), worker);
}

export function workers(parentDir: string): Array<{ dir: string; worker: Worker }> {
  const base = join(parentDir, "workers");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = workerDirectory(parentDir, entry.name);
      return { dir, worker: readWorker(dir) };
    });
}

export function assertAvailable(parentDir: string): void {
  const busy = workers(parentDir).find(({ worker }) => worker.state === "queued" || worker.state === "running");
  if (busy) {
    throw new Error(`Worker ${busy.worker.id} is ${busy.worker.state}. Wait for its report or inspect it: tmux attach -t ${busy.worker.tmux}`);
  }
}

export function message(worker: Worker, payload: { kind: "instruction"; text: string } | { kind: "report"; report: Report }): Message {
  return {
    id: `${Date.now()}-${randomUUID()}`,
    parentId: worker.parentId,
    workerId: worker.id,
    ...payload,
  };
}

export function publish(dir: string, msg: Message): void {
  const inbox = msg.kind === "instruction" ? "to-worker" : "to-parent";
  atomicJson(join(dir, inbox, `${safeId(msg.id)}.json`), msg);
}

export function messages<K extends Message["kind"]>(dir: string, kind: K): Array<Extract<Message, { kind: K }>> {
  const inbox = join(dir, kind === "instruction" ? "to-worker" : "to-parent");
  if (!existsSync(inbox)) return [];
  const worker = readWorker(dir);
  return readdirSync(inbox).filter((file) => file.endsWith(".json")).sort().map((file) => {
    const msg = readJson<Extract<Message, { kind: K }>>(join(inbox, file));
    if (msg.kind !== kind || msg.parentId !== worker.parentId || msg.workerId !== worker.id || file !== `${safeId(msg.id)}.json`) {
      throw new Error(`Message does not belong to this worker: ${file}`);
    }
    return msg;
  });
}
