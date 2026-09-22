# Commands and interaction

Slash commands below are typed into the HiCode input box, not the operating-system shell. `/help` lists commands in the running version. Unknown commands should not be guessed from another coding agent.

## Command reference

| Command | Purpose |
| --- | --- |
| `/help` | List available commands. |
| `/plan` | Switch to exploration/planning without implementation writes. |
| `/build` | Execute work under the selected permission profile. |
| `/providers` | Configure provider keys, endpoints and model lists. |
| `/model` | Select and persist the primary model. |
| `/permissions` | Select Ask for approval, Approve for me or Full Access. |
| `/sandbox` | Inspect sandbox status and configure its network policy; restart to apply a changed policy. |
| `/add-dir` | List writable directories for this session. |
| `/add-dir <path>` | Authorize an existing directory for this session. |
| `/add-dir --project <path>` | Persist a directory grant for this project and apply it now. |
| `/skills` | View the actual loaded Skill list, origins and locations. |
| `/mcp` | Show MCP connection status. |
| `/mcp reconnect <server-name>` | Reconnect a known server and review its authorization/configuration. |
| `/agents` | Manage custom Agent definitions and inspect available Agents. |
| `/agents reload` | Reload Agent definitions. |
| `/hooks` | Inspect Hook definitions, approvals and recent runs. |
| `/hooks reload` | Reload Hooks when runtime state permits it. |
| `/tasks` | Inspect this session's background tasks and their output. |
| `/diff` | View current Git uncommitted changes, including untracked files. |
| `/resume` | Choose a stored session to resume. |
| `/compact [summary instructions]` | Compact current model context, optionally specifying what to preserve. |
| `/memory` | Show project memory status and location. |
| `/memory list [type]` | List topics; optional types: user, feedback, project, reference. |
| `/memory show <key>` | Read a memory topic. |
| `/memory maintain` | Run memory extraction/consolidation when enabled and allowed. |

`/diff` does not rewind code or browse per-turn code snapshots. There is no `/rewind`, `/memory forget`, `/attach`, `/detach` or `/paste-image` command in this command registry.

## Input and keyboard controls

- **Enter:** submit. **Shift+Enter:** newline when the terminal sends a distinguishable key sequence.
- **Shift+Tab:** switch Build/Plan. This is separate from the permission profile.
- **Ctrl+O:** toggle expanded transcript/tool output; press again to return.
- **@:** suggest workspace file paths. Insert a selected path with Tab/Enter. A file mention is not proof that the model has read the file contents.
- Paste a supported local image path into the input to prepare an image attachment, or use CLI `--image`. The model must support images. Do not claim an attached image was understood until the model receives it.
- During a turn, **Esc** cancels the current Root turn, unless an active input suggestion/dialog consumes the key first. **Ctrl+C** also cancels active work. When idle, Ctrl+C first clears a draft; with no draft it requests application exit.
- Type `exit` or `quit` as the entire input to close the application cleanly.

## Adding requirements while work runs

Ordinary input submitted during a turn is queued for the next safe boundary after the current tool batch. It does not splice text into half-written tool arguments or interrupt an in-progress file commit.

Local commands have individual busy policies: for example `/tasks`, `/skills` and `/help` can be handled while work runs; configuration commands may wait for the current turn to finish. Cancelling a turn is not the same as deleting queued requirements.

## Background tasks and subagents

`/tasks` shows running and finished Shell/Agent tasks. Use the panel's displayed controls: arrows to select/scroll, Enter to open output, `s` to stop a running task, `r` to refresh, Esc to return/close.

Cancelling Root work does not mean every background child has stopped. Check `/tasks` and stop a specific task when needed. Clean application shutdown closes owned background resources. Resuming a stored conversation does not resurrect old shell processes or live child threads.

To continue a child Agent in the same live session, ask naturally: “Have the same board Agent continue with the next change, preserving its previous context.” The model uses `agent_followup` when available; users do not type a `task followup` slash command.

## CLI options

Run `hicode --help` in the terminal for the installed CLI flags. Common examples:

```sh
hicode --continue
hicode --resume
hicode --resume <session-id>
hicode --collaboration-mode plan
hicode -p 'Explain the project structure' --output-format json
hicode --image /absolute/path/screenshot.png
```

Headless execution has no TUI approval buttons. Configure the Host/CLI policy appropriately; do not assume an unattended run can grant itself extra access. SDK hosts use the SDK's configuration and permission callbacks rather than interactive menus.
