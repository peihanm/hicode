import {supportsToolImages} from "../images/capability.js";
import {createApprovalReviewer} from "../permissions/reviewer.js";
import type {ApprovalReviewer} from "../permissions/approval.js";
import {type AgentRunner, createAgentRunner} from "../agent/index.js";
import {type CompactHistoryRunner, createCompactHistoryRunner,} from "../context/compact.js";
import {createCompactSummaryGenerator} from "../context/compactSummary.js";
import {createLLMCaller} from "../llm/index.js";
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

export interface AgentRuntime {
    reviewApproval: ApprovalReviewer;
    runAgent: AgentRunner;
    compactHistory: CompactHistoryRunner;
    createSubagentRunner: CreateSubagentRunner;
    createSubagentThread: CreateSubagentThread;
}

function createProviderRunner(
    source: ResolvedPillarSettings["sources"][LLMProviderName]
) {
    const callLLM = createLLMCaller(source);
    const generateSummary = createCompactSummaryGenerator({callLLM});
    const compactHistory = createCompactHistoryRunner({generateSummary});
    const runner = createAgentRunner({callLLM, compactHistory});
    return {
        runAgent: ((userInput, history, onEvent, ctx, inputChannel, options) => {
            ctx.imageModelSupported = supportsToolImages(source, ctx.model);
            return runner(userInput, history, onEvent, ctx, inputChannel, options);
        }) satisfies AgentRunner,
        compactHistory,
    };
}

function createPrimaryRouter(
    getSources: () => ResolvedPillarSettings["sources"]
) {
    const runners = new Map<LLMProviderName, {connection: string; runner: ReturnType<typeof createProviderRunner>}>();
    const getRunner = (provider: LLMProviderName) => {
        const source = getSources()[provider];
        const connection = JSON.stringify(source);
        let cached = runners.get(provider);
        if (!cached || cached.connection !== connection) {
            cached = {connection, runner: createProviderRunner(source)};
            runners.set(provider, cached);
        }
        return cached.runner;
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

/** Root resolves current connections; each child captures connections at spawn. */
export function createAgentRuntime({storage, getSources, subagents, memory}: {
    storage: PillarStorageLayout;
    getSources(): ResolvedPillarSettings["sources"];
    subagents: SubagentRegistry;
    memory: MemoryRuntimeLike;
}): AgentRuntime {
    const primary = createPrimaryRouter(getSources);
    const childFactories = () => {
        const sources = structuredClone(getSources());
        const child = createPrimaryRouter(() => sources);
        return createSubagentFactories({
            primaryRunAgent: child.runAgent,
            fastRunAgent: child.runAgent,
            registry: subagents,
            createToolResultStore: (cwd, sessionId) => createToolResultStore(storage, cwd, sessionId),
        });
    };
    return {
        runAgent: createMemoryAwareAgentRunner(primary.runAgent, memory),
        reviewApproval: createApprovalReviewer(primary.runAgent),
        compactHistory: primary.compactHistory,
        createSubagentRunner: options => childFactories().createSubagentRunner(options),
        createSubagentThread: (options, request) => childFactories().createSubagentThread(options, request),
    };
}
