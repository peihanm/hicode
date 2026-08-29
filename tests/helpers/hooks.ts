import type {ResolvedHookSettings} from "../../src/hooks/types.js";

export function createEmptyResolvedHookSettings(): ResolvedHookSettings {
  return {
    SessionStart: [],
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    SessionEnd: [],
  };
}
