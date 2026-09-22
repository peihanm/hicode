# Data locations, formats and maintenance

## Three separate roots

- **Project:** source code and declarative `.hicode/` configuration. Do not put generated session logs here.
- **Installation:** managed CLI copies under `~/.local/share/hicode`, or a developer-owned source checkout. Updating this does not delete user data.
- **HiCode Home:** CLI defaults to `~/.hicode`; SDK hosts inject their own absolute directory. Credentials, user defaults and project runtime data live here.

The diagram describes file roles, not a supported schema for manually manufacturing runtime records. Not every optional file exists before first use.

```text
~/.hicode/
  .env                                # provider credentials; never share
  settings.json                       # user JSON configuration
  mcp.json                            # user MCP declarations
  mcp-approvals.json                   # persisted server approval fingerprints
  trusted-projects.json               # Hook definition decisions
  HICODE.md                           # user instructions
  agents/<name>.md                    # custom Agent definitions
  skills/<name>/SKILL.md              # user Skills and optional resources
  projects/<project-key>/
    project.json                      # canonical project identity
    activity/<pid>-<uuid>.json         # Root liveness records
    .maintenance.lock/                # maintenance/Root registration lease
    cache/
      bun/                            # rebuildable package cache
      npm/                            # rebuildable npm/npx cache
    memory/
      topics/<topic-key>.md            # editable formal memory
      MEMORY.md                       # generated topic index
      state.json                      # workflow/hash/source/lease metadata
      .memory.lock/
      workspaces/<lease-id>/
        draft/                        # private consolidation inputs/topics
        runtime/                      # temporary maintenance execution data
    sessions/
      index.json                      # resume-list metadata, not conversation body
      .index.lock/
      index-recovery/<hash>.json       # evidence retained by index repair
      session-<session-hash>/
        identity.json                 # session ID, cwd, creation time
        snapshot.json                 # current message/UI references and state
        .persistence.lock/
        input-history.jsonl           # input-box history
        content/<sha256>.json          # immutable message/UI bodies
        archives/
          <archive-hash>-index.txt     # rebuildable compact-history index
          <archive-hash>-<part>.txt    # readable archive segments
        tool-results/
          <hash>.txt + <hash>.meta.json
          <hash>.bin + <hash>.binary.json
        tasks/events.jsonl            # Shell/Agent/Memory task lifecycle
        tasks/events.jsonl.lock/
        subagents/<agent-hash>/
          state.json                  # latest child history/result
          events.jsonl                # child run events and history increments
        debug/requests/run-<hash>/
          run.json                    # trace, owner, pending/end and log gaps
          <timestamp>_<uuid>.json      # recorded request and response
    debug/requests/run-<hash>/         # maintenance requests with no Session
```

Other locks, such as `.env.lock/`, `settings.json.lock/`, input-history and tool-result store locks, coordinate atomic writes. Do not remove a lock just because it exists; determine whether its owner is active first.

## Locate a particular run

1. `hicode --storage projects` lists known project storage. Confirm the canonical cwd in `project.json`; do not guess from a folder name.
2. In that project's `sessions/`, use index metadata and `identity.json` to find the session.
3. For model behavior, read the relevant `debug/requests/run-<hash>/run.json` first, then selected request/response records. Trace agentId/runId identifies child requests in the parent's request directory.
4. For task completion, inspect `tasks/events.jsonl` and the matching child's `state.json`/`events.jsonl`. For large output or images, follow the recorded result reference to its owning session.

Project/session/agent hashes are safe storage identifiers, not reversible IDs. Different cwd roots can produce different projects even inside one Git repository.

## Which files may be edited?

| File class | Treatment |
| --- | --- |
| Settings, instructions, Agent/Skill/MCP definitions | Editable configuration; follow the relevant format and reload rule. |
| `.env` | Credential data; use `/providers` where possible, never print or commit values. |
| `memory/topics/*.md` | Editable formal memory; can be removed as ordinary authorized files. |
| `memory/MEMORY.md` | Generated index; editing it is not how to update a topic. |
| Memory state, approvals, identity, snapshots, content blocks, task/child logs | Runtime-managed protocols; inspect rather than hand-edit. |
| Package caches and unreachable artifacts | Potentially rebuildable; inspect with storage maintenance before cleanup. |

### Formal memory format

Use lowercase kebab-case filenames such as `response-style.md`. A nonempty plain Markdown body is valid; optional YAML allows only `name`, `description`, `type`:

```markdown
---
name: Response style
description: Prefer concise answers with concrete evidence.
type: feedback
---
Lead with the conclusion and give file references for implementation claims.
```

Types: `user`, `feedback`, `project`, `reference`. File limit: 40 KiB; body: 32 KiB; maximum 200 topics. Without metadata, the file key supplies the name, the first body line supplies a bounded description, and type defaults to `project`. Do not copy private maintenance-draft `sources`, `key`, version or timestamp fields into a formal topic.

Use `/memory` to find the active project's exact topic location. Deleting a topic removes that formal memory, but does not erase mentions from old conversations or logs. Agent Bash removal uses the provided topics directory as explicit cwd and remains within its scoped file sandbox.

## Backup and cleanup

For a complete conversation backup, preserve the session directory, including snapshot references, `content/`, referenced tool artifacts and child data. Snapshot alone is insufficient. Preserve the project's memory separately when needed. Back up credentials only to an appropriate private location; do not attach a whole HiCode Home directory to a bug report.

Storage maintenance runs without model calls:

```sh
hicode --storage projects
hicode --storage inspect
hicode --storage preview
```

`inspect`/`preview` are the starting points for the current project. `clean` removes only eligible generated/unreferenced artifacts after validation; it does not promise to delete sessions, memory or old formats. `repair-index` rebuilds the resume index from validated session data and keeps old-index evidence. Both require no active Root for that project and recheck references under maintenance locking.

Do not delete active session files, individual content blocks, one half of an artifact pair, or an entire `~/.hicode` tree as a routine fix. Cleanup must match the user's requested scope. A clean application exit preserves conversation state but closes background processes; the state files do not restart them.

## Retention and sensitive content

Request logs are bounded and can be incomplete: check run metadata rather than assuming every historical request remains. They may contain source code, user input and reasoning actually returned by the model. Reasoning unavailable from the provider cannot be reconstructed from these files.

Current input history is session-local and bounded; older `history.jsonl`, `debug/prompt-logs/`, project-local runtime directories or legacy memory files are not current sources. Old files are not automatically migrated or deleted. Absence of an obsolete directory does not imply lost logging.
