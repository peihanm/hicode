# MCP configuration

## Files and precedence

Servers come from `~/.hicode/mcp.json`, then current-project `.mcp.json`, then `.hicode/mcp.json`, then SDK Host inline contributions. Later sources replace a server with the same name. Project files are read only at cwd, not from ancestor directories. Prefer `.hicode/mcp.json` for HiCode projects.

Files are JSON objects with one top-level `mcpServers` object. HiCode supports local **stdio** and **Streamable HTTP** servers. A `command` selects stdio; a `url` selects HTTP. Explicit `type` is optional and must match. Legacy SSE transport, custom authentication headers, OAuth, MCP Resources/Prompts and Elicitation are not supported.

## Minimal server examples

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    },
    "remote-tools": {
      "url": "https://example.com/mcp"
    }
  }
}
```

These are templates: the local program or HTTP MCP endpoint must exist. HiCode does not create it from the declaration. For third-party servers, use their documented command or endpoint. Validate the package/version separately before recommending installation. Do not write optional defaults into examples or user configuration; preserve intentional timeout overrides for slow starts or long renders.

| Field | Meaning |
| --- | --- |
| Server name | 1–64 characters: letters, digits, `_`, `-`, `.`; avoid names that collide after normalization. |
| `type` | Optional: `stdio` with command, `http` with URL. Do not mix transport fields. |
| `command` | Required for stdio: executable name/path, directly launched without shell evaluation. |
| `url` | Required for HTTP: HTTP(S) MCP endpoint, without embedded username/password or fragment. Redirects are rejected. |
| `args` | Optional array of literal strings, default `[]`; shell quoting/operators do not become executable shell syntax. |
| `env` | Stdio-only string-to-string map overlaying the restricted child environment. No `${VAR}` substitution. |
| `disabled` | Optional boolean, default false. |
| `timeoutMs` | Connection timeout, default 10000; allowed 1000–60000 milliseconds. |
| `toolTimeoutMs` | Per-call timeout, default 120000; allowed 1000–1800000 milliseconds. |

Each source file is limited to 1 MiB and 64 server entries. Server objects reject unknown fields. Files must be regular UTF-8 files; unsafe symlinks produce configuration issues.

Provider keys and sensitive environment names are filtered from child processes; an `env` entry cannot reintroduce blocked names. Do not assume every secret can be passed through this field. Consult the particular server's supported credential mechanism and HiCode's reported configuration error, without printing secrets or committing them.

## Approval and connection

Project and Host server declarations need authorization before spawning a process or contacting an HTTP endpoint. HTTP approval displays the endpoint with query values hidden. Selected user-level declarations are treated as explicit user configuration. Do not move a project server into user configuration merely to evade review.

Startup offers Enable and Cancel. Enable remembers the server for this project and configuration, and current/future tools run automatically. Cancel or Esc leaves the server unapproved and does not start it. Use `/mcp` to require approval or block individual tools.

Connection progress appears above the prompt, not inside its placeholder. Successful connections clear the temporary status; failures keep a `/mcp` notice until recovery. The prompt becomes active after runtime initialization.

Use `/mcp` → Enter on a server to manage individual tools. Space cycles Allowed / Ask every time / Blocked; Enter saves. Allowed is the default and removes a stored restriction. There is no service-default selector. Esc goes back one level; Ctrl+C closes the panel without exiting HiCode. Unsaved changes are discarded; closing does not undo a save or reconnect already in progress. Settings deny/ask rules cannot be overridden here.

Enablement and tool restrictions live in the version 2 `~/.hicode/mcp-approvals.json`, bound to canonical project, server name and configuration fingerprint. Changing command, arguments, environment, HTTP URL or effective timeouts requires fresh enablement for project/Host servers. Unknown/old formats fail closed and are not migrated. Saving tool restrictions updates the connected runtime immediately. Existing child tool-name scopes do not expand; within that scope they use refreshed definitions and restrictions. Definitions changing during review require reopening the page.

Press r in the server list, or use `/mcp reconnect <name>`, to re-read configuration and review/reconnect a known server. Restart after adding/removing servers. Connections do not automatically replay failed calls. HiCode closes stdio children and HTTP streams at shutdown, and attempts bounded HTTP session termination. It does not stop the independent HTTP server.

## Tool discovery and permissions

The model receives a compact scoped server directory in runtime context. Use `tool_search` with `query` (optional `limit`, default 5, max 10) or `names` (up to 10 exact names) to read full tool descriptions and input schemas. Call `mcp_call` with `{tool: "mcp__local_tools__lookup", arguments: {...}}`. Search does not install tools or grant access. Specific MCP definitions never enter the model's tools array; known current names can be called without another search. Permissions, hooks and parameter validation apply to the real target. Large search results use the normal saved-output/read_file path. There is no loaded-tool list or LRU state.

Enabled servers allow tool calls by default, regardless of annotations. Explicit per-tool Ask/Blocked and Settings rules are handled by the normal permission pipeline. Ask mode requests user approval; Auto-review uses the reviewer; Full Access preauthorizes ordinary asks but does not bypass denies or server enablement.

Annotations only determine read-only eligibility and concurrency: `readOnlyHint=true` with `destructiveHint!=true` permits a tool in read-only scopes and concurrent batches. Missing/conflicting annotations and write tools stay unavailable to read-only children and execute serially. Do not manufacture annotations. Only change tool restrictions when the user requests that scope.

## Troubleshooting

- **Pending:** resolve the startup enablement, not the model prompt.
- **Executable missing:** check the command on the PATH used to launch HiCode and required server files.
- **HTTP endpoint/authentication:** use a Streamable HTTP MCP endpoint, not an ordinary web page or legacy SSE URL. HTTP 401/403 indicates a server-side access requirement; this version has no custom-header or OAuth configuration. Do not put passwords in URLs as a workaround.
- **Connection timeout:** check startup/dependency failure and protocol output before increasing timeout.
- **Tool absent:** check `/mcp` tool count, schema diagnostics and tool discovery; do not guess a name repeatedly.
- **Tool failed:** distinguish local validation, permission denial, remote tool error and connection loss using the saved output.
- **List changed:** servers may send `notifications/tools/list_changed`; HiCode refreshes definitions and invalidates changed ones. Unchanged discovered definitions remain available; a refreshed name alone is not proof of an identical schema.

See [Storage](storage.md) for logs and [Permissions](permissions.md) for approval categories.

Catalog refresh waits are isolated by server: local tools and healthy servers remain usable. Existing subagents can rediscover refreshed or reconnected tools within their original authorized names. Newly added names require a new delegation scope; reconnecting does not expand child permissions.
