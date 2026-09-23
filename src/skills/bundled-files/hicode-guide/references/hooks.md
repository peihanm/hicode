# Hook configuration and protocol

## Location and trust

Declare Hooks in the `hooks` object of user/project/local Settings, or SDK Host overrides. No separate `hooks.json` is loaded. `.hicode/hooks/` is a conventional place for script files explicitly referenced by Settings.

Definitions from selected sources append in order; repeated groups are not automatically deduplicated. Inspect with `/hooks`, reload with `/hooks reload` when idle, or restart. Changes may require trust approval. Decisions are stored in `~/.hicode/trusted-projects.json` and bind canonical project plus definition hash.

Command Hooks run outside the ordinary Bash sandbox after this separate trust boundary. Approval of a command definition does not hash every referenced script's contents. `purpose: observe` limits Hook response powers; it does not make arbitrary script side effects read-only.

## Configuration shape

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "write_file|edit_file",
      "timeoutMs": 10000,
      "hooks": [{
        "type": "command",
        "purpose": "control",
        "executable": "node",
        "args": ["./.hicode/hooks/check-edit.mjs"],
        "timeoutMs": 5000
      }]
    }]
  }
}
```

Create the referenced script; this configuration alone does not implement a check. Merge into the chosen Settings source.

Group fields: optional `matcher`, optional `timeoutMs` and required nonempty `hooks` array. A matcher is an exact value, `*`, `a|b` alternatives or supported regular expression; the event determines what is matched. Group/handler timeouts are 100–30000 ms.

Every handler requires `purpose: observe|control` and one of:

- `type: command` with `command` and optional `shell: bash|powershell`;
- `type: command` with `executable` and `args` (direct argv, no shell expansion);
- `type: prompt` with `prompt` (an independent model-based decision, not a script).

Optional handler fields: `timeoutMs`, `once`, and tool-event-only `if`. `if` uses the tool permission matcher, e.g. `bash(git push:*)`; it selects calls, not authorization. `once` is consumed before the first matched execution attempt, including failures; it is scoped to the current session runtime, not a durable “run only once forever” flag.

## Events

| Event | Matcher value | Allowed purpose |
| --- | --- | --- |
| `SessionStart` | startup/resume | observe |
| `UserPromptSubmit` | No user-body matching | observe/control |
| `PreToolUse` | Tool name | observe/control |
| `PostToolUse` | Tool name, successful executed call | observe |
| `PostToolUseFailure` | Tool name, failed executed call | observe |
| `PostToolBatch` | No text matcher | observe |
| `Stop` | No final-body matcher | observe/control |
| `TurnEnd` | completed/failed/cancelled/blocked/limit | observe |
| `PreCompact`, `PostCompact` | auto/manual | observe |
| `SubagentStart`, `SubagentStop` | Agent type | observe |
| `SessionEnd` | End reason | observe |

TurnEnd and SessionEnd do not allow Prompt handlers. Cancelled/aborted paths can record interrupted/skipped handlers rather than executing scripts; do not treat an observation Hook as guaranteed external delivery. Slash commands do not trigger UserPromptSubmit. Tool refusals before execution are not PostToolUseFailure events.

## Input and output

Command stdin contains a JSON envelope with `version`, `cwd`, `hook_id`, `dispatch_id`, `execution_id`, `source`, `purpose`, and `event`. Use `event.hook_event_name` to identify the event; fields such as `tool_name`/`tool_input` are available for applicable tool events. Do not assume the full conversation or provider credentials are included.

Exit 0 with empty stdout is a successful observation or a passing control decision. Nonempty stdout must be a valid JSON object for that event/purpose:

| Handler | Response examples |
| --- | --- |
| Observation | `{}` or `{"userMessage":"Check recorded."}`; some events also allow `additionalContext`. |
| UserPromptSubmit control | `{"decision":"pass"}` or `{"decision":"block","reason":"..."}`. |
| PreToolUse control | pass/block, or `{"decision":"rewrite","updatedInput":{...}}` with the complete replacement tool input. |
| Stop control | `{"decision":"accept"}` or `{"decision":"continue","reason":"..."}`. |

Do not print normal logging on stdout alongside the result; use bounded stderr diagnostics without secrets. The combined output budget is 64 KiB. Rewritten tool arguments are schema-validated and permission-checked again; a Hook cannot grant permission by rewriting input.

Control exit 2 means block (or continue for Stop). Other errors/timeouts/invalid results fail the control operation; observation failures produce diagnostics without falsifying tool success. Stop continuation has runtime limits; it is not an infinite retry mechanism.

## Small observation handler

For a PostToolBatch observe Hook, the following `.mjs` script only emits a notification:

```js
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({userMessage: 'Tool batch observed.'}));
});
```

Prompt Hooks use the effective fast model, have no project tools and can incur API cost. Do not add a Prompt Hook for simple deterministic checks that a command can perform, or install any Hook merely to explain this feature.

Approved tool hooks also apply to Worker, Explore and custom subagents. Each child thread has independent `once` state retained across follow-up runs. Tool events carry child session/turn IDs; `actor` identifies the child and its working directory. Hook commands still run in the approved root project directory; resolve relative tool paths against `actor.cwd` when present. Root-only scripts can skip events with an `actor`. Children cannot approve, reload or manage hook configuration.
