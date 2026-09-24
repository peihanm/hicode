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

Startup offers Connect for this session, Always connect and allow tools, Always connect; keep tool approvals, and Block this server. Allow tools explicitly permits current and future tools by default, including code execution. Keep tool approvals remembers the connection while retaining tool checks. Esc skips without changing stored decisions.

Connection progress appears above the prompt, not inside its placeholder. Successful connections clear the temporary status; failures keep a `/mcp` notice until recovery. The prompt becomes active after runtime initialization.

Use `/mcp` → Enter on a server to manage permissions. Space changes the Default row between Allow tools and Ask when needed. On a tool row, Space cycles Default / Ask every time / Blocked / Allowed. Enter saves the policy and exceptions together. Esc goes back one level; Ctrl+C closes the panel and returns to the prompt without exiting HiCode. Unsaved changes are discarded; closing does not undo a save or reconnect already in progress. Settings deny/ask rules cannot be overridden here. An existing exact tool allow in Settings is shown; select an Ask exception to require approval instead. Ask when needed preserves read-only defaults and existing precise grants.

Policies and connection approvals live in `~/.hicode/mcp-approvals.json`, bound to canonical project, server name and configuration fingerprint. Old connection-only records do not imply server trust. Changing command, arguments, environment, HTTP URL or effective timeouts invalidates the old service policy. Omitting an explicit default does not change the fingerprint. Saving updates the connected runtime without a restart. Existing child tool-name scopes do not expand; within that scope they use refreshed definitions and policy. Definitions changing during review require reopening the page.

Press r in the server list, or use `/mcp reconnect <name>`, to re-read configuration and review/reconnect a known server. Restart after adding/removing servers. Connections do not automatically replay failed calls. HiCode closes stdio children and HTTP streams at shutdown, and attempts bounded HTTP session termination. It does not stop the independent HTTP server.

## Tool discovery and permissions

The model sees tool names such as `mcp__local_tools__lookup`. It uses `tool_search` to discover a relevant tool and load its full schema for Function Calling. This does not start an unconfigured server or grant access. The loaded tool set has a bounded working set; an unused schema can later be unloaded and rediscovered.

Without service trust, a connected server's read-only tool is allowed by default only when `readOnlyHint=true` and `destructiveHint` is not true. Missing/conflicting annotations or write/destructive tools use ordinary approval policy. Settings deny/ask rules still apply. Approve for me can review requests; Full Access preauthorizes ordinary asks but does not bypass denies or server-start approval. Plan and read-only children do not gain write tools.

For a deliberately trusted operation, use the offered persistent approval or an exact actual tool name in project-local rules. For example, replace the placeholder in this fragment with the name exposed by the connected server:

```json
{
  "permissions": {"allow": ["mcp__local_tools__lookup"]}
}
```

An allow for a tool name covers its ordinary calls, not just one current argument value. Only change service trust or exceptions when the user requests that scope. Do not manufacture read-only annotations.

## Troubleshooting

- **Pending/denied:** resolve the startup approval, not the model prompt.
- **Executable missing:** check the command on the PATH used to launch HiCode and required server files.
- **HTTP endpoint/authentication:** use a Streamable HTTP MCP endpoint, not an ordinary web page or legacy SSE URL. HTTP 401/403 indicates a server-side access requirement; this version has no custom-header or OAuth configuration. Do not put passwords in URLs as a workaround.
- **Connection timeout:** check startup/dependency failure and protocol output before increasing timeout.
- **Tool absent:** check `/mcp` tool count, schema diagnostics and tool discovery; do not guess a name repeatedly.
- **Tool failed:** distinguish local validation, permission denial, remote tool error and connection loss using the saved output.
- **List changed:** servers may send `notifications/tools/list_changed`; HiCode refreshes definitions and invalidates changed ones. Unchanged discovered definitions remain available; a refreshed name alone is not proof of an identical schema.

See [Storage](storage.md) for logs and [Permissions](permissions.md) for approval categories.

Catalog refresh waits are isolated by server: local tools and healthy servers remain usable. Existing subagents can rediscover refreshed or reconnected tools within their original authorized names. Newly added names require a new delegation scope; reconnecting does not expand child permissions.
