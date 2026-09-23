# My Pi setup

Small, independent personal Pi packages.

| Package | What it does |
| --- | --- |
| [`orchestrator`](packages/orchestrator/README.md) | Your planning conversation delegates to ordinary Pi workers in tmux, receives reports, and continues workers in their original contexts. |
| [`keep-new-session-model`](packages/keep-new-session-model/README.md) | `/new` keeps the current model and thinking level. |
| [`message-timestamps`](packages/message-timestamps/README.md) | Shows TUI-only GMT+3 timestamps after messages, outside the model prompt. |
| [`usage`](packages/usage/README.md) | `/usage` shows available OpenAI Codex subscription usage windows. |

## Install

Requires the Node.js distribution of `@earendil-works/pi-coding-agent` (tested on **0.86.1**, Node 22). Orchestration also requires `tmux` on the machine running Pi. No runtime dependencies need installing separately: Pi provides its extension imports.

Install everything from a local checkout:

```sh
pi install /absolute/path/to/my_pi_setup
```

Or install only the packages you want:

```sh
pi install /absolute/path/to/my_pi_setup/packages/orchestrator
pi install /absolute/path/to/my_pi_setup/packages/keep-new-session-model
pi install /absolute/path/to/my_pi_setup/packages/message-timestamps
pi install /absolute/path/to/my_pi_setup/packages/usage
```

After publishing this directory as a GitHub repository:

```sh
pi install git:github.com/YOUR_NAME/my_pi_setup
```

Restart Pi or use its built-in `/reload` after installation. Do not also keep old loose copies of these extensions in `~/.pi/agent/extensions/`: different paths can load twice. Move those copies somewhere outside the auto-discovered extension directory first.

## Remove features by removing code

The root manifest discovers `packages/*/index.ts`. There is no feature registry, settings UI, or toggle command.

- **Whole-setup install:** remove an unwanted `packages/<name>/` directory, then reload Pi. No manifest edits needed.
- **Individual package install:** run `pi remove /absolute/path/to/my_pi_setup/packages/<name>` and remove its directory if desired.
- **Git-managed install:** make the deletion in your repository and use `pi update --extensions` on other machines. Pi may reset its managed clone during updates, so don't rely on edits made only inside `~/.pi/agent/git/` surviving.

Use a normal local Git checkout if you want to edit/remove packages locally and pull your changes yourself. Stop active orchestration before removing its code. Removing a package does **not** delete conversations or kill running tmux sessions.

## Develop and test

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests cover communication, parent isolation, yielding, continuation, resume deduplication, model retention, and timestamps. With tmux available, the smoke test starts **real Pi processes** on a private tmux server and uses a deterministic local model: no paid API calls or project edits. It verifies teardown of its own server. Without tmux, that smoke test is reported as skipped.

All runtime orchestration state stays under Pi's agent directory, not inside this repository. Do not commit Pi authentication, session transcripts, or orchestration mailboxes.
