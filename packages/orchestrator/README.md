# Orchestrator

Four tools, two-way file messages, and tmux. No dashboard, parallel scheduler, automatic retries, worktree management, or auto-commits.

## Use

Plan in a normal Pi conversation, then ask:

> Execute this plan as the orchestrator. Delegate focused steps to workers, evaluate their reports, and continue until complete or you need my decision.

The parent gets:

- `spawn_worker({ task, title?, model?, thinking? })`: start a fresh worker with a self-contained assignment. Include decisions, scope, acceptance criteria, and required checks. `title` is an optional short display label; it is not sent to the worker. Without it, the first task line is shortened at a word boundary.
- `send_to_worker({ worker_id, message, title? })`: continue a waiting worker in its **existing context**. The saved worker title is always shown; supply a concise `title` to append a full follow-up label. Long message bodies are never shown in the call header.

- `stop_worker({ worker_id })`: release a settled waiting worker's process memory when the parent expects no further follow-up. Closes only its verified owned tmux session; keeps saved sessions and reports. Unlike handoff tools, this does not end the parent's turn.

Each worker gets:

- `report_to_parent({ status, summary, checks, question? })`: submit a concise update and yield. Status is `ready_for_review`, `needs_input`, or `blocked`. Omit `question` when there is none.
- `/report`: optional manual shortcut asking the worker to summarize its current state using `report_to_parent`.

Workers do not get this extension's dispatch tools. They are instructed not to delegate or start other agents. This is a workflow restriction, not a sandbox: normal shell access remains available.

### Per-worker model and thinking

Both options are optional and independently inherit the orchestrator's current setting:

```js
spawn_worker({ task: "Review the diff and report findings." }) // inherit both
spawn_worker({ task: "Check edge cases.", model: "openai/gpt-5-mini", thinking: "high" })
spawn_worker({ task: "Run the targeted checks.", thinking: "low" }) // inherit model
```

`model` accepts an exact `provider/model` identifier (recommended), or an exact model ID only when unambiguous across Pi's current registry. Built-in and custom registered models are supported, including IDs containing slashes or colons. No fuzzy patterns or `:thinking` shorthand. Unknown/ambiguous IDs, overrides without configured authentication, and invalid thinking values fail before worker files or a terminal are created.

`thinking` accepts Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The requested/inherited level is passed to Pi, which clamps it to the selected model's capabilities (non-reasoning models use `off`; extended levels require model support). These options change only the new worker, not the orchestrator, defaults, or existing workers. `send_to_worker` does not reapply settings.

Authentication checks use Pi's configured-auth status, not a network credential test. As with inherited models, the worker must load the same provider configuration/extensions and credentials independently; parent-only runtime provider registrations or temporary API keys are not copied. The normal tmux environment limitations below still apply.

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

### Context-aware continuation

Settled reports also include runtime-only `context_health` (older reports may omit it):

- `compaction_count`, `latest_compaction_at`: successful compactions on the full active branch; timestamp is Pi's ISO string, or `null` if none. Other branches and branch summaries are not counted.
- `compacted_since_previous_report`: whether this branch contains compaction IDs absent from the prior published report; the first report compares against an empty baseline. `null` means the prior report predates this metadata.
- `compacted_during_assignment`: whether compaction follows the latest instruction's persisted receipt on this branch; `null` if that receipt is unavailable. A positive result adds an explicit text notice to the parent's report. Compaction since the prior report also gets a notice when assignment attribution is unavailable or false.
- `compaction_ids`: persisted comparison baseline, so reload/resume and equal-count branch changes do not lose detection. Publication retries retain the already-published snapshot.
- `tokens_before_compaction`: approximate headroom before Pi's effective automatic compaction threshold; currently **`null` (unknown)**. Pi 0.86.1 exposes usage but not its live SettingsManager to extensions. A separately loaded SettingsManager can resolve global/project/per-model settings, but may miss live overrides or toggles. We therefore do not read user settings or assume the default reserve. This is not raw unused context-window space.

Parent prompt guidance is advisory, not a dispatch gate:

- Target zero worker compactions through bounded assignments; compaction is a fallback, not the normal strategy.
- After one or more compactions, prefer a fresh worker with an explicit handoff for substantial follow-up, even if reported context usage is now low. A small correction or final check is an exception; reaffirm critical constraints. Do not discard completed work.
- Uncompacted worker, same unfinished task and under 60%: generally continue.
- 60–80%: only a bounded follow-up; above 80%: prefer fresh context for substantial work.
- Unrelated work, a new phase, or independent review: fresh worker. Topic similarity alone is insufficient.
- Consider the next task's size and unknown estimates. After compaction, reaffirm critical constraints in follow-up guidance.

No context percentage kills, automatically replaces, or prevents continuing a worker. Decisions wait for the settled report, never interrupting mid-edit. Assignment notices describe compactions still on the active branch; abandoned branches are not an all-session event log.

If a worker settles with a normal final reply instead of calling `report_to_parent`, the parent receives a durable **MISSING WORKER REPORT** notification through the same idle-only mailbox delivery. It includes at most 8,000 characters of the final reply, explicitly labeled **unverified worker output**, not a structured report or task acceptance. The worker stays available; the parent can use `send_to_worker` to request a proper report or more work. Notifications are deduplicated per assignment and survive parent reload/resume. Interrupted/error runs, shutdown, and old finals found only on worker reload do not generate this notification. No worker retry, model wakeup, or timeout is added.

Reload the parent **and each waiting worker** (or restart/resume them) to enable this behavior; do not interrupt active workers just to update. Already missed completions are not backfilled: inspect the saved worker session, and ask a live waiting worker for a report via `send_to_worker` (or `/report` in its terminal). A closed worker needs deliberate manual recovery, not metadata edits.

Role/reporting and parent orchestration guidance is supplied as one request-local `orchestration_guidance` system section through Pi's supported `context` hook. It applies to mailbox-triggered and ordinary user turns without adding entries to session history or replacing the existing base prompt/tool declarations. The parent section includes the current worker roster. Pi 0.86.1's initial custom-message-triggered turn bypasses `before_agent_start` and initial standard base-prompt preparation; this extension supplies its own role rules, **not** the missing whole standard Pi prompt. The normal structured-report protocol remains required even with the missing-report fallback.

The extension does not copy worker transcripts into the parent, except for this bounded missing-report final reply. It does not copy the planning conversation into workers either; workers receive the assigned brief plus normal Pi/project context.

## Inspect or guide a worker

`spawn_worker` saves and displays the full supplied title (up to 80 characters), or a shortened first-line fallback. `send_to_worker` displays that same worker title plus an optional full follow-up title, never a clipped piece of the message. Both also display the worker folder (its final path segment is the worker ID), and `tmux attach -t <name>`. Titles and paths wrap in both collapsed and expanded tool rows; neither tool shows a tool-name header or JSON arguments. Older workers without a saved title use their worker ID instead of a clipped follow-up message. Their structured tool details retain the IDs and metadata paths for programmatic use. The exact session file is filled into metadata when Pi starts.

After updating the extension, run `/reload` in the parent (or restart/resume Pi). Tool definitions are registered during extension loading so Pi can render restored history before `session_start`; only tool activation depends on the parent/worker role. Existing saved result text is preserved, so titles already shortened in older results cannot be recovered by re-rendering.

Attach to see the **same live Pi process**. Interrupt or guide it normally. Detach with tmux's default `Ctrl+B`, then `D`; Pi continues running. A pending, not-yet-sent report is invalidated if queued human guidance starts another agent run first.

Do not resume a running worker's session in a second Pi process. Do not manually start another worker while one is executing; the dispatch guard does not police human terminal input. Once a report has been sent, the parent may already have advanced—intervening then requires coordinating with the parent.

Workers stay open after reporting. Keep helpful waiting workers for likely follow-ups; when no further follow-up is expected, the parent should call `stop_worker` to free process memory. Reporting never stops them automatically. `/new`, `/resume`, `/fork`, and `/clone` inside a worker terminal are blocked to preserve identity. Manual `/quit` remains available.

Stopping rejects queued/running workers and any `pending-report.json` awaiting publication. Published reports remain deliverable even if the parent has not consumed them. Ownership checks require the generated tmux name, the original pane PID, a single pane, and the worker-directory environment linkage; older or manually recreated terminals that cannot be verified must be inspected/closed manually. The state is rechecked immediately before termination. Coordinate human terminal input with the parent: do not start new work while it is stopping a worker. No process-name killing, broad cleanup, or idle timeout is used.

`closed` means explicitly retired by the parent, not task acceptance or orchestration failure. Repeated stops are harmless and do not touch tmux again. `stopped` continues to mean an ordinary exit/crash (or failed launch), which may require failure diagnosis. `send_to_worker` rejects both states; manual resume of the saved session restores the waiting worker role. A failed stop throws an error rather than claiming success; inspect the terminal/metadata before retrying. On-disk sessions, reports, and metadata are never deleted.

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

- The parent is **idle**, not blocked inside a tool or model request while waiting. Its Pi status area shows `Orchestrator: waiting on worker` while a worker is queued/running, and `Orchestrator: idle` otherwise, followed by `| Live Workers: N`. The count is this parent's registered workers with live named tmux sessions, including waiting workers that still consume memory, not historical metadata entries. It updates immediately on launch/stop and on the existing one-second poll for external exits/resumes. One asynchronous tmux snapshot per poll is shared with failure detection; rendering never launches subprocesses. Counting does not change workers or their metadata. There is no worker-duration timeout.
- Closing the parent stops its poller, not its workers. Resume that same parent session to collect waiting reports.
- `/reload` cleans up the old poller and restores state from disk.
- Each orchestrator has its own namespace and unique tmux names. A forked/new parent gets a different namespace; it does not adopt the original parent's workers.
- Separate orchestrators should use **separate checkouts/worktrees**. Message isolation is not filesystem isolation.

## Requirements and deliberate limits

- `pi` and `tmux` must be on PATH on the same machine. Workers inherit the parent's selected provider/model/thinking level unless overridden at spawn, plus its working directory, agent config directory, and effective project trust decision.
- Prefer Pi's normal saved `/login` credentials. Arbitrary shell-only API-key environment variables are **not** copied into worker launch arguments; an existing tmux server can have a different environment. Configure credentials in Pi before using workers.
- Only interactive/RPC parent sessions are supported; workers are ordinary interactive Pi, not print/JSON processes.
- The parent must remain running for immediate delivery, possibly in its own persistent terminal. tmux protects workers from terminal disconnection, not host reboot or process crashes.
- A missing report is not success. The parent checks assigned workers' tmux sessions every second; if a worker stops without reporting, it marks the assignment failed, alerts the parent immediately (even while busy), and queues a durable failure message for the parent's next idle turn. The alert includes the last saved Pi activity and any child processes still observed (or explains when process inspection is unavailable). It is not an acceptance report. The parent must remain running for immediate notification; on resume it will detect and deliver outstanding failures. Recovery is manual: resume the saved worker in its original named tmux session, then guide it or use `/report`. For example, after verifying the old process is gone:

  ```sh
  tmux new-session -s <original-name> 'pi --session /absolute/path/to/worker-session.jsonl'
  ```

  If you loaded the package only temporarily with `-e`, include its extension path on the resumed command too. Metadata names the original terminal and session file. Do not fabricate an acceptance report to clear a failed task.
- This is not an exactly-once distributed job system. Reports delivered immediately before a hard crash may require a manual parent prompt to continue. No automatic model-error retries, watchdog, or crash-recovery engine is added by this package.
- Do not rewind session history to try to undo external work. Mail receipts and filesystem changes are not rolled back by Pi's tree navigation.

## Implementation map

- `index.ts`: role-specific tools, lifecycle hooks, mailbox polling, message injection.
- `store.ts`: private JSON storage and worker namespace checks.
- `context.ts`: branch-derived compaction metadata and report notices.
- `tmux.ts`: launching/checking worker terminals, ownership-checked stopping, and shell quoting.
