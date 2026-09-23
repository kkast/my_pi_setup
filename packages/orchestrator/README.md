# Orchestrator

Three tools, two-way file messages, and tmux. No dashboard, parallel scheduler, automatic retries, worktree management, or auto-commits.

## Use

Plan in a normal Pi conversation, then ask:

> Execute this plan as the orchestrator. Delegate focused steps to workers, evaluate their reports, and continue until complete or you need my decision.

The parent gets:

- `spawn_worker({ task })`: start a fresh worker with a self-contained assignment. Include decisions, scope, acceptance criteria, and required checks.
- `send_to_worker({ worker_id, message })`: continue a waiting worker in its **existing context**.

Each worker gets:

- `report_to_parent({ status, summary, checks, question? })`: submit a concise update and yield. Status is `ready_for_review`, `needs_input`, or `blocked`. Omit `question` when there is none.
- `/report`: optional manual shortcut asking the worker to summarize its current state using `report_to_parent`.

Workers do not get this extension's dispatch tools. They are instructed not to delegate or start other agents. This is a workflow restriction, not a sandbox: normal shell access remains available.

## The handoff

```text
Parent spawns A → parent idle
A asks a question → A idle → parent wakes
Parent spawns B to investigate → parent idle
B reports findings → B idle → parent wakes
Parent sends findings to A → A resumes in its same session
A reports results → A idle → parent evaluates
```

Reporting does not close a worker or declare a step accepted. The parent makes that decision. Once the worker settles, the extension adds a Pi runtime `context_usage` snapshot to the report (`provider`, `model`, estimated `tokens`, `context_window`, `percent`). This is not something the worker model is asked to calculate. Usage may be `null` when unavailable, and tokens/percent may be `null` when Pi cannot yet estimate them (for example, just after compaction). Use it to inform whether to continue that worker or start fresh, not as an automatic cutoff. Multiple workers can exist, but the dispatch tools allow only one queued/running worker per orchestrator. Call each handoff tool **alone** in a turn; successful calls terminate that agent run. Reports are published only after the worker settles, so the parent cannot advance while the worker is still finishing its tool call.

The extension does not copy worker transcripts into the parent. It does not copy the planning conversation into workers either; workers receive the assigned brief plus normal Pi/project context.

## Inspect or guide a worker

`spawn_worker` displays:

- Worker ID and Pi session ID.
- Session directory and metadata file; the exact session file is filled into metadata when Pi starts.
- `tmux attach -t <name>`.

Attach to see the **same live Pi process**. Interrupt or guide it normally. Detach with tmux's default `Ctrl+B`, then `D`; Pi continues running. A pending, not-yet-sent report is invalidated if queued human guidance starts another agent run first.

Do not resume a running worker's session in a second Pi process. Do not manually start another worker while one is executing; the dispatch guard does not police human terminal input. Once a report has been sent, the parent may already have advanced—intervening then requires coordinating with the parent.

Workers stay open after reporting. `/new`, `/resume`, `/fork`, and `/clone` inside a worker terminal are blocked to preserve its identity. Exit the worker with `/quit` when it is no longer needed. No automatic terminal cleanup is performed.

## Storage and lifecycle

```text
~/.pi/agent/orchestration/<parent-session-id>/
  workers/<worker-id>/
    metadata.json
    to-worker/<message-id>.json
    to-parent/<message-id>.json
    sessions/<pi-session>.jsonl
```

`PI_CODING_AGENT_DIR` changes the base agent directory. Message files are private, atomically written JSON. The extension polls once per second and injects one message when the receiving agent is idle. The actual delivered custom messages are recorded in Pi's transcript; their IDs prevent normal polling or resume from replaying them. Mail files remain as a small audit trail.

A temporary `pending-report.json` bridges reporting and worker settlement. Worker linkage is also saved in its Pi session, so resuming the saved session with this extension installed restores the worker role without needing launch environment variables.

- The parent is **idle**, not blocked inside a tool or model request while waiting. There is no worker-duration timeout.
- Closing the parent stops its poller, not its workers. Resume that same parent session to collect waiting reports.
- `/reload` cleans up the old poller and restores state from disk.
- Each orchestrator has its own namespace and unique tmux names. A forked/new parent gets a different namespace; it does not adopt the original parent's workers.
- Separate orchestrators should use **separate checkouts/worktrees**. Message isolation is not filesystem isolation.

## Requirements and deliberate limits

- `pi` and `tmux` must be on PATH on the same machine. Workers inherit the parent's selected provider/model/thinking level, working directory, agent config directory, and effective project trust decision.
- Prefer Pi's normal saved `/login` credentials. Arbitrary shell-only API-key environment variables are **not** copied into worker launch arguments; an existing tmux server can have a different environment. Configure credentials in Pi before using workers.
- Only interactive/RPC parent sessions are supported; workers are ordinary interactive Pi, not print/JSON processes.
- The parent must remain running for immediate delivery, possibly in its own persistent terminal. tmux protects workers from terminal disconnection, not host reboot or process crashes.
- A missing report is not success. An unexpected crash can leave metadata marked running. Recovery is manual in v1: resume the saved worker in its original named tmux session, then guide it or use `/report`. For example, after verifying the old process is gone:

  ```sh
  tmux new-session -s <original-name> 'pi --session /absolute/path/to/worker-session.jsonl'
  ```

  If you loaded the package only temporarily with `-e`, include its extension path on the resumed command too. Metadata names the original terminal and session file. Do not fabricate an acceptance report to clear a failed task.
- This is not an exactly-once distributed job system. Reports delivered immediately before a hard crash may require a manual parent prompt to continue. No automatic model-error retries, watchdog, or crash-recovery engine is added by this package.
- Do not rewind session history to try to undo external work. Mail receipts and filesystem changes are not rolled back by Pi's tree navigation.

## Implementation map

- `index.ts`: role-specific tools, lifecycle hooks, mailbox polling, message injection.
- `store.ts`: private JSON storage and worker namespace checks.
- `tmux.ts`: launching/checking worker terminals and shell quoting.
