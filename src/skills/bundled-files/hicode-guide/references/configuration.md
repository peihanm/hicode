# Configuration files

Paths below describe the CLI. `<cwd>` is the directory where HiCode starts. SDK hosts choose their own data root and enabled file sources; see [SDK](sdk.md).

## Locate the right file

| File | Format | Purpose and scope |
| --- | --- | --- |
| `~/.hicode/settings.json` | JSON | User defaults, provider connections and model lists, optional permissions/context/memory/Hooks/sandbox settings. |
| `<cwd>/.hicode/settings.json` | JSON | Shared project settings; can be version-controlled when free of secrets and machine-specific paths. |
| `<cwd>/.hicode/settings.local.json` | JSON | Machine-local project overrides and remembered permission grants; exclude from Git. |
| `~/.hicode/.env` | dotenv | User provider credentials. Never commit. |
| `<cwd>/.env` | dotenv | Optional project credentials. Never commit. |
| `~/.hicode/mcp.json` | JSON | User MCP servers. |
| `<cwd>/.hicode/mcp.json` | JSON | Project MCP servers. A project `.mcp.json` is also read at lower precedence. |
| `~/.hicode/HICODE.md` | Markdown | User instructions. |
| `HICODE.md`, `.hicode/HICODE.md`, `HICODE.local.md` along the project discovery path | Markdown | Project instructions; local files should not be committed. |
| `~/.hicode/skills/<name>/SKILL.md`, `<cwd>/.hicode/skills/<name>/SKILL.md` | Markdown with simple frontmatter | Skill entry points. |
| `~/.hicode/agents/<name>.md`, `<cwd>/.hicode/agents/<name>.md` | Markdown with YAML frontmatter | Custom Agent definitions. |
| `<cwd>/.hicode/hooks/` | Scripts referenced by Settings | Suggested Hook script location; this directory is not scanned automatically. |

You do not need to create every file. Missing optional files use defaults; use `/providers` for initial model setup. Settings, Skills, Agent and MCP project sources use the current cwd, unlike ancestor instruction discovery. Starting in a subdirectory may therefore select different project configuration and project storage.

## Settings fields

Settings are JSON objects, not JSONC/YAML. Use valid JSON without comments or trailing commas. These are the supported top-level groups:

| Group | Fields and meaning |
| --- | --- |
| `sources.<source>` | `label`, `apiKeyEnv`, `baseUrl`, `models: [{id, label}]`. Connection directories only take effect from user settings or SDK Host overrides. Source keys: `qwen`, `glm`, `deepseek`, `openrouter`. |
| `models` | `primary`, optional `fast`, optional `reviewer`; each target identifies `source` and `model`. The model must exist in that source's list. Reviewer requires both fields and cannot be set by project/local settings. |
| `permissions` | `defaultMode`, `additionalDirectories`, `allow`, `ask`, `deny`. Modes: `ask`, `auto-review`, `full-access`; project/local settings cannot grant Full Access. |
| `sandbox.filesystem` | `denyRead`, `denyWrite`: arrays of paths, resolved at startup. |
| `sandbox.network` | `mode: open\|restricted`, `allowedDomains`, `allowLocalBinding`. |
| `memory` | `enabled`, `autoExtract` booleans. Recall defaults on; automatic extraction defaults off. |
| `context` | `windowTokens`, `autoCompactTokenLimit`: positive integer token budgets. Window is at least 4096; compaction threshold must leave the runtime's output reserve. |
| `hooks` | Event name → matcher-group array; see [Hooks](hooks.md) for the nested schema. |

Context defaults are `windowTokens=500000`, `autoCompactTokenLimit=450000`. A configured context window is a local budget, not proof that the remote model supports that size. Do not raise it without checking provider limits. The runtime reserves `min(20000, floor(windowTokens × 0.2))` tokens; the compaction limit cannot exceed the remaining input budget.

Do not add `sandbox.enabled`, a top-level permission `mode`, custom provider source keys, or arbitrary fields copied from another agent. Unknown file fields can produce diagnostics; unsupported fields do not become functional settings. Invalid known fields can reject a source, and invalid permission/context configuration stops loading. Inspect the actual issue rather than assuming a broken file was applied.

## Small, usable examples

User settings with an explicit source model list and default model (obtain a matching key through `/providers`):

```json
{
  "sources": {
    "qwen": {
      "label": "Alibaba Bailian",
      "apiKeyEnv": "DASHSCOPE_API_KEY",
      "models": [{"id": "qwen3.8-flash", "label": "Qwen 3.8 Flash"}]
    }
  },
  "models": {"primary": {"source": "qwen", "model": "qwen3.8-flash"}}
}
```

Omitting `fast` keeps it following the main model. Add `baseUrl` under the source only when necessary, using the actual provider API base URL. `apiKeyEnv` is a variable name, not a key value. Editing a `models` array replaces that source's model list, so preserve any models still needed.

Project-local settings for restricted network and a remembered no-push policy:

```json
{
  "permissions": {
    "defaultMode": "ask",
    "deny": ["bash(git push:*)"]
  },
  "sandbox": {"network": {"mode": "restricted"}},
  "memory": {"enabled": true, "autoExtract": false}
}
```

This Bash rule matches that parsed command prefix; it is not proof against every alternative executable/path/program capable of pushing. Do not describe command rules as a complete OS-level capability boundary.

## Precedence and merging

For scalar settings: built-in → user → project → project-local → SDK Host overrides, with applicable CLI flags highest. Important exceptions:

- `sources` applies only from user/Host; project files select models without redirecting provider keys or endpoints.
- Permission `allow`/`ask`/`deny` entries combine across selected sources. Deny takes precedence; a later allow does not erase an earlier deny.
- `additionalDirectories` is a union. Grants remain subject to canonical path validation and the Host boundary.
- Hook groups append across sources; duplicate handlers can therefore run more than once.
- Explicit source model lists and sandbox path/domain arrays replace lower-priority arrays.
- If any selected source explicitly disables `memory.enabled` or `memory.autoExtract`, higher-priority sources cannot turn that field back on.
- CLI permission mode overrides a resumed session's mode, which overrides Settings defaults. Build/Plan is separate session state, not a Settings field.
- Resume restores the conversation; the old session's model metadata does not override the currently selected startup model.

Never write a fully merged configuration back to one file: that can copy private user defaults into a shared project file. Read the chosen source, update just the requested fields, and preserve unrelated entries.

## When changes take effect

| Change | Apply it |
| --- | --- |
| `/providers` or `/model` | UI changes apply after a successful save. |
| Manually edited settings or `.env` | Restart HiCode. Exported environment values still take precedence over credential files. |
| `/sandbox` | Saves the choice; restart to change active network policy. |
| `/add-dir` | Applies the grant now; `--project` also persists it. |
| HICODE.md or Skill files | Restart; startup snapshots are not automatically refreshed. |
| Agent definitions | `/agents reload`, or restart. Already-running children retain their existing thread/configuration. |
| Hook definitions | `/hooks reload` when idle, or restart; changed definitions may need approval. |
| MCP config | Reconnect a known server; restart after adding/removing servers. |
| Memory topics | Read again at the next recall; no restart needed. |

For API-key precedence and exact `/model` save destinations, see [Models](models.md). For runtime files rather than configuration, see [Storage](storage.md).
