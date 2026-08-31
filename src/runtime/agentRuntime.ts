import {type AgentRunner, createAgentRunner} from "../agent/index.js";
import {type CompactHistoryRunner, createCompactHistoryRunner,} from "../context/compact.js";
import {createCompactSummaryGenerator} from "../context/compactSummary.js";
import {createLLMCaller} from "../llm/index.js";
import type {ModelTargetSettings} from "../settings/types.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {ResolvedPillarSettings} from "../settings/types.js";
import {createSubagentFactories} from "../subagents/runSubagent.js";
import type {
    CreateSubagentRunner,
    CreateSubagentThread,
} from "../subagents/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import {createToolResultStore} from "../toolResults/index.js";
import {createMemoryAwareAgentRunner, type MemoryRuntimeLike,} from "../memory/index.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {CodexAppServerRuntimeLike} from "../llm/providers/codex/index.js";

export interface AgentRuntime {
    runAgent: AgentRunner;
    compactHistory: CompactHistoryRunner;
    createSubagentRunner: CreateSubagentRunner;
    createSubagentThread: CreateSubagentThread;
}

function createProviderRunner(
    source: ResolvedPillarSettings["sources"][LLMProviderName],
    codex: CodexAppServerRuntimeLike
) {
    const callLLM = createLLMCaller(source, {codex});
    const generateSummary = createCompactSummaryGenerator({callLLM});
    const compactHistory = createCompactHistoryRunner({generateSummary});
    return {
        runAgent: createAgentRunner({callLLM, compactHistory}),
        compactHistory,
    };
}

function createPrimaryRouter(
    sources: ResolvedPillarSettings["sources"],
    codex: CodexAppServerRuntimeLike
) {
    const runners = new Map<LLMProviderName, ReturnType<typeof createProviderRunner>>();
    const getRunner = (provider: LLMProviderName) => {
        let runner = runners.get(provider);
        if (!runner) {
            runner = createProviderRunner(sources[provider], codex);
            runners.set(provider, runner);
        }
        return runner;
    };
    return {
        runAgent: ((userInput, history, onEvent, ctx, inputChannel, options) =>
            getRunner(ctx.provider).runAgent(
                userInput,
                history,
                onEvent,
                ctx,
                inputChannel,
                options
            )) satisfies AgentRunner,
        compactHistory: ((input) =>
            getRunner(input.ctx.provider).compactHistory(input)) satisfies CompactHistoryRunner,
    };
}

/** Route the per-Turn primary target while keeping the fast target fixed. */
export function createAgentRuntime({
    storage,
    fastModel,
    sources,
    subagents,
    memory,
    codex,
}: {
    storage: PillarStorageLayout;
    fastModel: ModelTargetSettings;
    sources: ResolvedPillarSettings["sources"];
    subagents: SubagentRegistry;
    memory: MemoryRuntimeLike;
    codex: CodexAppServerRuntimeLike;
}): AgentRuntime {
    const primary = createPrimaryRouter(sources, codex);
    const fast = createProviderRunner(sources[fastModel.source], codex);
    const rootRunAgent = createMemoryAwareAgentRunner(
        primary.runAgent,
        memory
    );
    const subagentFactories = createSubagentFactories({
        primaryRunAgent: primary.runAgent,
        fastRunAgent: fast.runAgent,
        fastModel: fastModel.model,
        registry: subagents,
        createToolResultStore: (cwd, sessionId) =>
            createToolResultStore(storage, cwd, sessionId),
    });
    return {
        runAgent: rootRunAgent,
        compactHistory: primary.compactHistory,
        ...subagentFactories,
    };
}
