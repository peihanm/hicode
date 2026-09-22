# MCP configuration

## Files and precedence

Servers come from `~/.hicode/mcp.json`, then current-project `.mcp.json`, then `.hicode/mcp.json`, then SDK Host inline contributions. Later sources replace a server with the same name. Project files are read only at cwd, not from ancestor directories. Prefer `.hicode/mcp.json` for HiCode projects.

Files are JSON objects with one top-level `mcpServers` object. Current support is **stdio only**: no direct HTTP/SSE transport, OAuth flow, MCP Resources/Prompts or Elicitation. Do not copy a URL-only configuration from another client.

## Full server example

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "env": {"LOG_LEVEL": "warn"},
      "disabled": false,
      "timeoutMs": 10000,
      "toolTimeoutMs": 120000
    }
  }
}
```

This is a template; the referenced server must exist and speak MCP over stdin/stdout. HiCode does not create it from this declaration. For a third-party server, use its documented launch command and dependency setup. Validate the package/version separately before recommending installation.

| Field | Meaning |
| --- | --- |
| Server name | 1–64 characters: letters, digits, `_`, `-`, `.`; avoid names that collide after normalization. |
| `type` | Optional, defaults to `stdio`; no other value supported. |
| `command` | Required executable name/path, directly launched without shell evaluation. |
| `args` | Optional array of literal strings, default `[]`; shell quoting/operators do not become executable shell syntax. |
| `env` | Optional string-to-string map overlaying the restricted child environment. It is not a documented `${VAR}` substitution template. |
| `disabled` | Optional boolean, default false. |
| `timeoutMs` | Connection timeout, default 10000; allowed 1000–60000 milliseconds. |
| `toolTimeoutMs` | Per-call timeout, default 120000; allowed 1000–1800000 milliseconds. |

Each source file is limited to 1 MiB and 64 server entries. Server objects reject unknown fields. Files must be regular UTF-8 files; unsafe symlinks produce configuration issues.

Provider keys and sensitive environment names are filtered from child processes; an `env` entry cannot reintroduce blocked names. Do not assume every secret can be passed through this field. Consult the particular server's supported credential mechanism and HiCode's reported configuration error, without printing secrets or committing them.

## Approval and connection

Project and Host server declarations need authorization before process startup. Selected user-level declarations are treated as explicit user configuration. Do not move a project server into user configuration merely to evade review.

Project approval choices include allowing once, persistently allowing, or denying for the project. Esc skips the current request without creating a new persisted decision. Stored decisions live in `~/.hicode/mcp-approvals.json`; they bind canonical project, server name and configuration fingerprint. Changing command, arguments, environment or related connection settings can require approval again.

Use `/mcp` to distinguish pending approval, denied, connecting, connected, failed and disabled. For a known server use `/mcp reconnect <name>` to re-read its configuration and review/reconnect it. Restart after adding/removing servers. Connections do not automatically retry/replay failed tool calls. HiCode owns and closes its stdio children at shutdown.

## Tool discovery and permissions

The model sees tool names such as `mcp__local_tools__lookup`. It uses `tool_search` to discover a relevant tool and load its full schema for Function Calling. This does not start an unconfigured server or grant access. The loaded tool set has a bounded working set; an unused schema can later be unloaded and rediscovered.

A connected server's read-only tool is automatically allowed by default only when `readOnlyHint=true` and `destructiveHint` is not true. Missing/conflicting annotations or write/destructive tools use ordinary approval policy. Explicit deny/ask rules still apply. Approve for me can review these requests; Full Access does not bypass server-start approval. Plan and read-only children do not gain write tools.

For a deliberately trusted operation, use the offered persistent approval or an exact actual tool name in project-local rules. For example, replace the placeholder in this fragment with the name exposed by the connected server:

```json
{
  "permissions": {"allow": ["mcp__local_tools__lookup"]}
}
```

An allow for a tool name covers its ordinary calls, not just one current argument value. Discuss that scope before changing policy; do not broadly whitelist a server or manufacture annotations.

## Troubleshooting

- **Pending/denied:** resolve the startup approval, not the model prompt.
- **Executable missing:** check the command on the PATH used to launch HiCode and required server files.
- **Connection timeout:** check startup/dependency failure and protocol output before increasing timeout.
- **Tool absent:** check `/mcp` tool count, schema diagnostics and tool discovery; do not guess a name repeatedly.
- **Tool failed:** distinguish local validation, permission denial, remote tool error and connection loss using the saved output.
- **List changed:** servers may send `notifications/tools/list_changed`; HiCode refreshes definitions and invalidates changed ones. Unchanged discovered definitions remain available; a refreshed name alone is not proof of an identical schema.

See [Storage](storage.md) for logs and [Permissions](permissions.md) for approval categories.
