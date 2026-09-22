# Troubleshooting, history and memory

## Three different continuity mechanisms

| Mechanism | What it does |
| --- | --- |
| `/resume` or CLI `--continue` | Restore a stored conversation. Does not roll back project files or recreate live processes. |
| `/compact` | Reduce the current model context by summarizing it. Does not mean every original detail remains in the next prompt. |
| Project Memory | Retain selected reusable information across sessions. Not a copy of the entire conversation. |

Use `/memory` to see current status and the actual memory directory. `/memory list`, `/memory show <key>` and `/memory maintain` are supported. Types are `user`, `feedback`, `project`, `reference`.

Memory is enabled by default, but automatic extraction is off by default. Do not promise that merely chatting automatically creates a permanent memory. The settings are `memory.enabled` and `memory.autoExtract`.

Formal memory bodies live in `memory/topics/<topic-key>.md` and can be edited or removed as ordinary files through authorized tools. Use the directory reported by `/memory`, not a guessed project hash. `MEMORY.md` is a generated index; deleting only its entry does not delete the topic. Do not manually edit workflow state or delete the entire project storage directory to forget one topic. There is no `/memory forget` command.

## Where to look

The CLI uses `~/.hicode`; an SDK Host can provide another storage root. Locate the correct project using `projects/<project-key>/project.json`, then the session with `sessions/session-<hash>/identity.json`. Hash filenames do not encode readable original IDs.

Within that session:

| Path | Evidence |
| --- | --- |
| `snapshot.json` and referenced `content/` | Current persisted conversation/UI state. Back up both. |
| `input-history.jsonl` | Input-box history, not the full conversation. |
| `debug/requests/run-<hash>/run.json` | Model-run trace, pending/finished status and logging gaps. |
| JSON files beside `run.json` | Recorded model requests/responses, possibly including returned reasoning. |
| `tasks/events.jsonl` | Background task lifecycle/notifications. |
| `subagents/<agent-hash>/state.json` and `events.jsonl` | Child history and execution state. Not a restartable live thread. |
| `tool-results/` | Stored large tool outputs and image artifacts referenced by history. |

Child model requests are traced under the parent session's `debug/requests/`; use agent/run IDs to distinguish them. Child tool artifacts may use an independent child session; follow the recorded reference. Do not guess a different project from the child's cwd.

Reasoning text exists only when the provider actually returned it and logging captured it. Lack of a recorded reasoning body does not prove the model did no internal reasoning. Logs can contain source code and user/model content; inspect only relevant records and redact before sharing.

## Common diagnoses

| Symptom | First checks |
| --- | --- |
| Skill missing | `/skills`; directory name and `SKILL.md`; supported frontmatter; source precedence; restart after edits. |
| MCP unavailable | `/mcp`; authorization vs launch/connection failure; real command/path and dependencies; reconnect the named server. |
| Repeated permission prompts | Identify file/network/host-command/MCP/Hook category before changing policy. See [Permissions](permissions.md). |
| Model fails immediately | Selected source, model ID, API endpoint, credential source, provider entitlement and reported API error. See [Models](models.md). |
| Long apparent wait | Distinguish permission wait, active model stream, running shell/child and runtime error using task status and request timestamps. Token totals are not wall-clock time. |
| Child completed but parent appears idle | Correlate task completion, queued notification and next Root request. Check whether Root was cancelled; do not assume missing context from UI alone. |
| Local server no longer reachable after exit | Background processes are not guaranteed across program exit. Check whether the service still runs and restart it if requested. |
| Missing resume entry | Check session index versus identity/snapshot files. Missing index metadata is not proof that conversation content was deleted. |

For a failed command, read its saved full output where available instead of rerunning it repeatedly with different `tail`/`grep` filters. Distinguish model-authored code errors from tool/runtime/permission failures; a nonzero test exit alone does not establish a framework bug.

## Storage maintenance

CLI-only inspection, with no model request:

```sh
hicode --storage projects
hicode --storage inspect
hicode --storage preview
```

`hicode --storage clean` and `hicode --storage repair-index` are explicit maintenance operations, not routine debugging steps. Inspect their scope first and close active HiCode Roots for the affected project before running them. They are not a blanket command to delete all conversation history or memory.

Do not clean real user storage while diagnosing a read-only question. Prefer a targeted report showing the exact error, affected run, evidence and next action.
