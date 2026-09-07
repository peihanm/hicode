import type {ResolvedHookSettings} from "../../src/hooks/types.js";

export function createEmptyResolvedHookSettings(): ResolvedHookSettings {
  return {
    SessionStart: [],
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    SessionEnd: [],
    PostToolBatch: [], Stop: [], TurnEnd: [], PreCompact: [], PostCompact: [], SubagentStart: [], SubagentStop: [],
  };
}

export function resolvedHooks(
  event: import("../../src/hooks/types.js").HookEvent,
  hooks: import("../../src/hooks/types.js").HookSettings[],
  timeoutMs?: number,
): ResolvedHookSettings {
  return {...createEmptyResolvedHookSettings(), [event]: [{source: "host", id: "fixture", hooks, timeoutMs}]};
}
