---
description: Explain how to install, update, configure, use and troubleshoot HiCode, including models, permissions, Skills, MCP, Hooks, subagents and session memory.
when_to_use: Use when the user asks about HiCode itself or explicitly requests its usage guide; not for ordinary coding tasks merely performed inside HiCode.
---

# HiCode Guide

Use the documentation shipped with this HiCode installation. Answer in the user's language. Start with the shortest useful answer and include concrete commands or configuration only when needed.

## Choose a reference

Read the one reference most relevant to the question, then another only if the answer requires it. Resolve these paths against this Skill's `resourceRoot`, not the user's project directory.

| Question | Reference |
| --- | --- |
| Install, update, source development, command not found | [Installation](references/installation.md) |
| API keys, endpoints, adding/removing models, saved model selection | [Models](references/models.md) |
| Configuration file locations, formats, fields, precedence and reload | [Configuration](references/configuration.md) |
| On-disk data, logs, memory files, backup and cleanup | [Storage](references/storage.md) |
| Slash commands, keyboard controls, running tasks, cancellation | [Commands and interaction](references/commands.md) |
| Approval profiles, network access, writable directories | [Permissions and network](references/permissions.md) |
| Skill installation, project instructions, choosing an extension | [Extensions](references/extensions.md) |
| Subagent definition fields, tools, model, delegation and followup | [Subagents](references/subagents.md) |
| MCP configuration, fields, approvals and tool discovery | [MCP](references/mcp.md) |
| Hook event names, configuration, handlers, outputs and trust | [Hooks](references/hooks.md) |
| SDK setup, Host configuration, storage and unattended execution | [SDK](references/sdk.md) |
| Resume, compaction, memory, logs and common failures | [Troubleshooting and storage](references/troubleshooting.md) |

## Answer and action boundaries

- For a usage question, explain the relevant behavior without changing configuration. If asked to set something up, inspect only the relevant configuration and use the normal tools and permission chain.
- Distinguish interactive CLI behavior from headless/SDK behavior. Slash commands are user input handled by the CLI, not Bash commands or tools the model can call directly.
- Never ask the user to paste an API key into chat. Prefer `/providers`; do not read or print credential file contents, tokens or complete process environments.
- Loading this guide does not grant filesystem access, network access, permission to execute scripts, or permission to start an MCP Server.
- Use the actual available tool list. Do not claim a Skill supplies a missing tool, that MCP is connected before checking its status, or that all providers support images/reasoning identically.
- Treat examples containing placeholder paths as templates. Resolve paths and confirm the intended scope before applying changes. Merge relevant configuration fields; do not overwrite unrelated settings.
- Use the installed version as the basis for answers. Do not invent commands, configuration fields or compatibility with another agent. If observed behavior disagrees with this guide, report the discrepancy and inspect the relevant implementation when available.
- Do not load every reference, scan all private storage, reinstall HiCode, weaken permissions or restart the application merely to answer a question.

Optional user request: $ARGUMENTS
