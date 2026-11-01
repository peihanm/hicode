import {realpath} from "node:fs/promises";
import {createHookRuntimeFactory as createRuntimeFactory} from "../../src/hooks/runtime.js";
import {defaultExecuteHookCommand} from "../../src/hooks/command.js";
import {readHookTrust, saveHookTrust} from "../../src/hooks/approval.js";
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

export function createHookRuntimeFactory(overrides: Partial<Parameters<typeof createRuntimeFactory>[0]> = {}) {
  return createRuntimeFactory({
    executeCommand: defaultExecuteHookCommand,
    canonicalProjectPath: realpath,
    readTrust: readHookTrust,
    saveTrust: saveHookTrust,
    ...overrides,
  });
}
