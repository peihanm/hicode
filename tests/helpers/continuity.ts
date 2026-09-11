import {createToolRuntime} from "../../src/tools/runtime.js";
import {createAgentRunner} from "../../src/agent/index.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {createCompactState} from "../../src/context/state.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createTestRuntimeResources} from "./runtimeResources.js";
import type {LLMCaller, Message} from "../../src/llm/types.js";
import type {PillarStorageLayout} from "../../src/persistence/layout.js";
import type {ToolContextHost} from "../../src/runtime/toolContext.js";

export const continuityState = () => ({todos: [], permissionMode: "ask" as const, collaborationMode: "build" as const, uiEvents: []});
export const continuityHost: ToolContextHost = {canUseTool: async () => ({behavior: "allow"}),
    getPermissionRules: () => ({allow: [], ask: [], deny: []}), getPermissionMode: () => "full-access",
    getCollaborationMode: () => "build", getPermissionPromptPolicy: () => "never",
    setTodos() {}};

export function continuityFixture(cwd: string, storage: PillarStorageLayout, callLLM: LLMCaller, history: Message[] = [{role: "system", content: "fixture"}]) {
    const resources = createTestRuntimeResources(cwd, {storage, toolRuntime: createToolRuntime({allowedToolNames: ["list_files", "write_file"]})});
    let compactions = 0;
    const compact = createCompactHistoryRunner({generateSummary: async () => {compactions++; return "工作继续，详细来源见档案";}});
    resources.agentRuntime.runAgent = createAgentRunner({callLLM, compactHistory: compact});
    const session = createRootSessionRuntime({resources,
        seed: {sessionId: "continuity", history, compactState: createCompactState()}});
    return {resources, session, compactions: () => compactions};
}
