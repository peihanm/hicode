# Configure and use subagents

## Built-in versus custom roles

| Role | Model | Intended work |
| --- | --- | --- |
| Worker | Main model captured when the thread is created | Bounded implementation or investigation. |
| Explore | Effective fast model, following main when no fast target is configured | Independent read-only code exploration using read_file and restricted Bash. |
| Custom role | Main model captured at thread creation | User-defined responsibility; tools inherit permitted capabilities unless narrowed. |

No custom role model tier or maximum-turn field is supported. Changing the Root model later does not reconfigure a live child's existing thread. Role definitions describe reusable behavior; each assignment still needs a concrete goal and file ownership.

## Where definitions live

```text
~/.hicode/agents/<name>.md          # user-wide
<cwd>/.hicode/agents/<name>.md      # current project
```

Names are case-insensitive for collisions. Project definitions override same-named user definitions; SDK Host inline definitions take precedence over both. Built-in names cannot be overridden. SDK file loading depends on its `fileSources` configuration.

Use `/agents` to create/edit/delete definitions or inspect loading issues. Creation defaults to project scope and offers user scope and read-only mode. The model-assisted authoring flow generates a preview; saving is a distinct step. `/agents reload` loads edited files without restarting Root. Existing child threads retain their previous state.

## Complete file format

Save this as `.hicode/agents/board-reviewer.md`:

```markdown
---
name: board-reviewer
description: Review task-board state changes, undo/redo and persistence consistency.
read_only: true
---

Inspect the assigned implementation and tests without changing files.
For each finding, provide the file location, trigger conditions and evidence.
Separate confirmed defects from uncertainty. If nothing is found, say so.
Return one self-contained final report to the parent.
```

| Field | Rules |
| --- | --- |
| `name` | Required; 1–64 characters; starts with a letter; letters, digits, `-`, `_` only. Keep filename and name aligned. |
| `description` | Required; 1–500 characters; helps Root decide when to use the role. |
| `read_only` | Optional boolean. `true` enforces read-only capability; omitted/false does not grant extra access. |
| `tools` | Optional YAML array, 1–128 exact tool names; further narrows permitted tools. Omit for ordinary usage. |
| Markdown body | Required role instructions; at most 40,000 characters. |

Each definition is a regular UTF-8 file of at most 64,000 bytes. Definition directories/files must not be symlinks. Unknown frontmatter fields produce warnings; do not add unsupported `model`, `max_turns` or worktree configuration. Invalid definitions, unknown tools and forbidden tool names are not activated.

Optional narrow tools example:

```yaml
tools:
  - read_file
  - bash
```

This fragment belongs in the frontmatter, alongside required fields. `bash` is constrained to supported read-only commands when `read_only: true`; merely listing it does not grant arbitrary command execution. MCP tools must use their actual loaded names and be available in the current runtime, so omit a custom list unless narrower capability is intentional.

## What children inherit

Workers/custom roles receive a scoped tool set, applicable instructions and Skill snapshots. Each child has separate conversation, file-read state, Todo and tool-result storage. Reading a file in Root does not authorize the child to edit it without reading it itself.

The parent-control tools `agent`, `agent_followup`, `ask_user` and the reserved `memory` name are excluded. Children may coordinate with the parent using `agent_message`, and can manage their own shell tasks when provided that capability; they cannot control sibling/parent tasks, close Root resources or obtain Root's memory-management access.

A child cwd does not authorize new filesystem locations. The directory must already be permitted by the parent. Worktrees, if needed, are created and managed through ordinary Git/Bash; there is no dedicated automatic worktree lifecycle.

## Assignment and continuation

A useful explicit request:

```text
Use two background Workers. First define the shared interfaces.
Assign state logic/tests to one and UI/styles to the other with separate files.
While they work, handle the entry point and build configuration.
Each Worker should validate its scope and report blockers through messages.
Collect both results, then run integration checks before the final answer.
```

Root chooses fresh or inherited context. Fresh requires a complete handoff; inherited background still needs a bounded assignment. Children update Todo for multi-step work and write the complete delivery report once as their final answer. Ordinary messages are for questions, blockers and useful intermediate findings, not a duplicate final report.

For another round, ask Root to continue the **same** Agents. `agent_followup` queues new work for an active child or starts another run on an idle existing thread, retaining History, FileState and cwd. `agent_message` only delivers/queues a message; it does not wake an idle Agent.

| Action | Result |
| --- | --- |
| Wait for delegated work | Event-driven wait; relevant completion/message/new user input wakes Root without minute-by-minute polling. |
| Root Esc | Cancels Root's current turn; background children can continue. |
| Interrupt a child | Ends the current run; the thread can receive followup. |
| Stop a child | Closes the thread; it cannot be followed up. |
| Exit HiCode | Closes owned tasks; later `/resume` restores records, not live child threads. |

`/tasks` exposes task status/output and stopping. Interrupt/followup are model tools, not extra slash commands. Foreground delegation is a one-call thread; same-thread followup applies to retained background Agents. Current headless/SDK Hosts do not allow background Agents, so do not promise identical parallel continuation there.

## Diagnose configuration or execution

Start with `/agents` loading issues and `/tasks` actual status. Role descriptions are not proof that a tool ran, a Todo was updated or a test passed. For followup investigations compare stable task/agent IDs, runCount, request history and task lifecycle records. See [Storage](storage.md) for their locations.
