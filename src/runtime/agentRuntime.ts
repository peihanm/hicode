import {type AgentRunner, createAgentRunner} from "../agent/index.js";
import {type CompactHistoryRunner, createCompactHistoryRunner,} from "../context/compact.js";
import {createCompactSummaryGenerator} from "../context/compactSummary.js";
import {createLLMCaller} from "../llm/index.js";
import type {ModelTargetSettings} from "../settings/types.js";
import {createSubagentRunnerFactory} from "../subagents/runSubagent.js";
import type {CreateSubagentRunner} from "../subagents/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import {createToolResultStore} from "../toolResults/index.js";
import {createMemoryAwareAgentRunner, type MemoryRuntimeLike,} from "../memory/index.js";

export interface AgentRuntime {
    runAgent: AgentRunner;
    compactHistory: CompactHistoryRunner;
    createSubagentRunner: CreateSubagentRunner;
}

function createModelRunner(target: ModelTargetSettings) {
    const callLLM = createLLMCaller(target.provider);
    const generateSummary = createCompactSummaryGenerator({callLLM});
    const compactHistory = createCompactHistoryRunner({generateSummary});
    return {
        runAgent: createAgentRunner({callLLM, compactHistory}),
        compactHistory,
    };
}

/** Bind independent primary and fast model targets to one application runtime. */
export function createAgentRuntime({
    models,
    subagents,
    memory,
}: {
    models: {primary: ModelTargetSettings; fast: ModelTargetSettings};
    subagents: SubagentRegistry;
    memory: MemoryRuntimeLike;
}): AgentRuntime {
    const primary = createModelRunner(models.primary);
    const fast = createModelRunner(models.fast);
    const rootRunAgent = createMemoryAwareAgentRunner(
        primary.runAgent,
        memory
    );
    return {
        runAgent: rootRunAgent,
        compactHistory: primary.compactHistory,
        createSubagentRunner: createSubagentRunnerFactory({
            primaryRunAgent: primary.runAgent,
            fastRunAgent: fast.runAgent,
            fastModel: models.fast.model,
            registry: subagents,
            createToolResultStore,
        }),
    };
}
