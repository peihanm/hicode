# Permissions and network

## Three separate controls

**Build/Plan chooses the kind of work. `/permissions` chooses how extra access is approved. `/sandbox` chooses network policy for sandboxed Bash.** Changing one is not equivalent to changing all three.

| Profile | Behavior |
| --- | --- |
| Ask for approval | Normal work within authorized boundaries proceeds; additional access goes to the user. |
| Approve for me | Additional permission requests go through an independent review Agent; some decisions may still require the user. |
| Full Access | Commands use host execution under the current OS account and ordinary extra-access prompts are reduced. This is not sudo/root access. |

`/permissions` changes the current session. Full Access selection requires confirmation. Explicit deny rules, tool validation, MCP Server approval and Hook trust still apply. Project settings cannot grant Full Access or replace the review model. SDK Hosts must explicitly permit Full Access before selecting it.

## Sandbox network

The current default network mode is **open**:

- **Open:** sandboxed Bash can connect directly, including to local networks; filesystem write restrictions remain.
- **Restricted:** traffic uses the sandbox proxy; new destinations may require domain/port approval. Session grants expire with the session.

Choose with `/sandbox`. The interactive CLI saves the choice to `.hicode/settings.local.json`; restart HiCode to apply it. Existing running commands keep their policy. Equivalent settings fragment:

```json
{
  "sandbox": {
    "network": {"mode": "restricted"}
  }
}
```

Merge this into existing settings rather than replacing the file. Network openness does not authorize writing arbitrary files, starting an MCP Server, or bypassing explicit restrictions. MCP child processes and Command Hooks are separate execution/trust boundaries, not ordinary Bash commands protected by this switch.

If `/sandbox` reports unavailable, commands cannot be described as sandbox-isolated. Use the reported initialization error to diagnose it; do not silently disable protection.

## Files and directories

Ordinary workspace writes do not need a new directory grant. The CLI also prepares authorized temporary directories. Additional paths must remain inside the Host's permitted boundary, and explicit file restrictions still apply.

```text
/add-dir
/add-dir /absolute/path/shared-library
/add-dir --project /absolute/path/shared-library
```

Use the second form for a temporary session grant and the third for a persistent project grant. The path must already exist and pass directory/symlink validation. Project grants are saved to `.hicode/settings.local.json`; do not share that machine-specific file as general project configuration.

Do not infer access from a child Agent's working directory or from text inside a Skill. A child can only use capabilities allowed by its parent and runtime policy.

## Distinguish approval types

| Prompt | What it approves |
| --- | --- |
| File access | The requested modification, or a directory scope offered by the dialog. |
| Restricted-network access | A specific destination/port, once or for the session. |
| Run outside sandbox | That command executing on the host; separate from a domain grant. |
| MCP Server authorization | Launching/connecting the configured server; not unconditional approval of every tool. |
| MCP tool authorization | That tool operation under current permission rules. |
| Hook trust | The configured Hook definitions; not blanket approval of all future script changes. |

MCP approvals are recorded in `~/.hicode/mcp-approvals.json`; Hook definition trust is recorded in `~/.hicode/trusted-projects.json`. Let their normal approval flows manage these files. Do not hand-edit fingerprints to bypass review.

For repeated prompts, first identify the category and actual target. Explain existing session/project grant options or the explicit network switch. Do not recommend broad Full Access as the default fix for an unknown failure.
