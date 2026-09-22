# Extensions

## Choose the right extension

| Mechanism | Use it for |
| --- | --- |
| `HICODE.md` | Persistent project/user instructions. |
| Skill | Reusable guidance and supporting reference files, read when relevant. |
| MCP | Tools supplied by an external server. |
| Custom Agent | A reusable responsibility and operating instructions for delegated work. |
| Hook | Logic attached to runtime events. |

These mechanisms have different loading and permission rules. A Skill is not an executable tool registration or an access grant.

## Project instructions

Use `<project>/HICODE.md` for shared instructions and `HICODE.local.md` for local instructions. HiCode discovers project instructions from the working directory upward; `.hicode/HICODE.md` is another supported project entry. User-wide instructions live at `~/.hicode/HICODE.md`.

Write concise instructions about the project, expected checks and boundaries. Do not put API keys in instruction files.

## Skills

Install a project Skill at:

```text
<project>/.hicode/skills/my-skill/
  SKILL.md
  references/       # optional
  scripts/          # optional
  assets/           # optional
```

For user-wide use, place the same directory under `~/.hicode/skills/`. Minimal `SKILL.md`:

```markdown
---
description: Review database migration plans for rollback and data-loss risks.
when_to_use: Use when the user asks for a migration review.
---

# Migration review

Read the proposed migration and its callers. Report concrete risks and evidence.
Read references/checklist.md only when the task needs that checklist.
```

The directory supplies the Skill name. Frontmatter currently recognizes single-line `description` and `when_to_use`; it is not a general YAML configuration system. Do not promise support for another agent's `allowed-tools`, model override or automatic script injection fields.

Restart HiCode after editing/installing Skills, then use `/skills` to check the loaded name, origin and path. The list reflects the startup snapshot; it is not a reload command. A project Skill overrides a same-named user Skill; user/project definitions override bundled ones, and SDK Host inline definitions take precedence over file sources.

The model initially sees the Skill listing. Calling the `skill` tool returns that Skill's instructions; references are then read as needed with normal tools. Relative resource paths resolve against the actual Skill directory, not project cwd. Explicitly request a named Skill when testing it, then check the tool trace to confirm it was loaded.

## Detailed configuration guides

- [MCP](mcp.md): all server fields, config precedence, startup approval, tool permissions and connection diagnostics.
- [Subagents](subagents.md): file locations, required/optional frontmatter, model/tool inheritance, background execution and same-thread followup.
- [Hooks](hooks.md): Settings shape, supported events, handler inputs/outputs and definition trust.
- [SDK](sdk.md): Host configuration, file sources, storage, unattended permissions and lifecycle.
- [Configuration](configuration.md): all configuration paths, formats, merge rules and reload behavior.
- [Storage](storage.md): runtime directory tree, topic format, backups and maintenance.

Read the relevant guide before writing a configuration file. A general extension overview is not sufficient evidence for exact field names or approval behavior.
