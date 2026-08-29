import {createLspManager} from "../lsp/manager.js";
import type {CreateLspManager, LspManagerLike,} from "../lsp/types.js";
import {createMcpManager} from "../mcp/manager.js";
import type {McpManagerLike, McpManagerOptions,} from "../mcp/types.js";
import {loadSkills} from "../skills/loader.js";
import type {LoadedSkill} from "../skills/types.js";
import {createToolRuntime, type ToolRuntime,} from "../tools/registry.js";
import {createTaskRuntime, type TaskRuntimeLike,} from "../tasks/index.js";
import {createShellRunner, type ShellRunnerLike,} from "../tools/bash/shellRunner.js";
import {createSandboxRuntime, type SandboxRuntimeLike,} from "../sandbox/index.js";
import {createFileStateTracker, type FileStateTracker,} from "../tools/shared/fileState.js";
import {loadProjectInstructions, type ProjectInstructions,} from "../prompt/instructions.js";
import type {ResolvedPillarSettings} from "../settings/index.js";
import {type AgentRuntime, createAgentRuntime} from "./agentRuntime.js";
import {
    type AgentAuthoringRuntime,
    type AgentDefinitionManager,
    createAgentAuthoringRuntime,
    createAgentDefinitionManager,
    createAgentDefinitionStore,
    createSubagentCatalog,
    loadCustomAgentDefinitions,
    type LoadedCustomAgents,
    type SubagentCatalog,
    validateCustomAgentTools,
} from "../subagents/index.js";
import {createAgentTool} from "../tools/agent/agent.js";
import type {CreateSubagentRunner} from "../subagents/types.js";
import {createHookPromptExecutor, createHookRuntime, type HookRuntime, type HookTrustRequest,} from "../hooks/index.js";
import {createMemoryRuntime, type MemoryRuntimeLike,} from "../memory/index.js";
import type {MemoryFileAccess} from "../memory/types.js";
import {createGitWorkspaceRuntime, type GitWorkspaceRuntimeLike,} from "../git/index.js";
import {createPrimaryModelRuntime, type PrimaryModelRuntime,} from "./primaryModel.js";

export interface RootRuntimeResources {
    readonly cwd: string;
    readonly model: string;
    readonly provider: ResolvedPillarSettings["models"]["primary"]["provider"];
    readonly fastModel: string;
    readonly fastProvider: ResolvedPillarSettings["models"]["fast"]["provider"];
    readonly primaryModel: PrimaryModelRuntime;
    readonly settings: ResolvedPillarSettings;
    readonly agentRuntime: AgentRuntime;
    readonly subagents: SubagentCatalog;
    readonly agentDefinitions: AgentDefinitionManager;
    readonly agentAuthoring: AgentAuthoringRuntime;
    readonly skills: LoadedSkill[];
    readonly instructions: ProjectInstructions;
    readonly toolRuntime: ToolRuntime;
    readonly hooks: HookRuntime;
    readonly mcpManager?: McpManagerLike;
    readonly lspManager?: LspManagerLike;
    readonly taskRuntime: TaskRuntimeLike;
    readonly shellRunner: ShellRunnerLike;
    readonly sandbox: SandboxRuntimeLike;
    readonly fileState: FileStateTracker;
    readonly memory: MemoryRuntimeLike;
    readonly memoryFiles?: MemoryFileAccess;
    readonly gitWorkspace: GitWorkspaceRuntimeLike;

    close(): Promise<void>;
}

export interface CreateRootRuntimeResourcesOptions {
    cwd: string;
    settings: ResolvedPillarSettings;
    signal?: AbortSignal;
    headless?: boolean;
    requestMcpApproval?: McpManagerOptions["requestApproval"];
    requestHookTrust?: (
        request: HookTrustRequest
    ) => Promise<"once" | "always" | "deny">;
}

interface RootRuntimeDependencies {
    createMcpManager(
        options: McpManagerOptions
    ): McpManagerLike | undefined;

    createLspManager: CreateLspManager;
    loadSkills: typeof loadSkills;
    loadProjectInstructions: typeof loadProjectInstructions;
    createToolRuntime: typeof createToolRuntime;
    createHookRuntime: typeof createHookRuntime;

    createTaskRuntime(
        cwd: string,
        shellRunner: ShellRunnerLike,
        createSubagentRunner: CreateSubagentRunner,
        subagents: SubagentCatalog
    ): TaskRuntimeLike;

    createFileStateTracker(): FileStateTracker;

    createAgentRuntime: typeof createAgentRuntime;

    createMemoryRuntime: typeof createMemoryRuntime;

    loadCustomAgentDefinitions(cwd: string): Promise<LoadedCustomAgents>;
}

function createResourceCloser(
    mcpManager: McpManagerLike | undefined,
    lspManager: LspManagerLike | undefined,
    taskRuntime: TaskRuntimeLike,
    memory: MemoryRuntimeLike,
    sandbox: SandboxRuntimeLike
): () => Promise<void> {
    let closePromise: Promise<void> | undefined;
    return () => {
        closePromise ??= (async () => {
            await Promise.allSettled([taskRuntime.close()]);
            await Promise.allSettled([
                lspManager?.shutdown(),
                mcpManager?.closeAll(),
                memory.close(),
            ]);
            await Promise.allSettled([sandbox.close()]);
        })();
        return closePromise;
    };
}

export function createRootRuntimeResourcesFactory(
    overrides: Partial<RootRuntimeDependencies> = {}
) {
    const dependencies: RootRuntimeDependencies = {
        createMcpManager: overrides.createMcpManager ?? createMcpManager,
        createLspManager: overrides.createLspManager ?? createLspManager,
        loadSkills: overrides.loadSkills ?? loadSkills,
        loadProjectInstructions:
            overrides.loadProjectInstructions ?? loadProjectInstructions,
        createToolRuntime: overrides.createToolRuntime ?? createToolRuntime,
        createHookRuntime: overrides.createHookRuntime ?? createHookRuntime,
        createTaskRuntime: overrides.createTaskRuntime ?? createTaskRuntime,
        createFileStateTracker:
            overrides.createFileStateTracker ?? createFileStateTracker,
        createAgentRuntime: overrides.createAgentRuntime ?? createAgentRuntime,
        createMemoryRuntime:
            overrides.createMemoryRuntime ?? createMemoryRuntime,
        loadCustomAgentDefinitions:
            overrides.loadCustomAgentDefinitions ?? loadCustomAgentDefinitions,
    };

    return async function createRootRuntimeResources(
        options: CreateRootRuntimeResourcesOptions
    ): Promise<RootRuntimeResources> {
        const [skills, instructions, loadedCustomAgents] = await Promise.all([
            Promise.resolve(dependencies.loadSkills(options.cwd)),
            dependencies.loadProjectInstructions(options.cwd),
            dependencies.loadCustomAgentDefinitions(options.cwd),
        ]);
        let lspManager: LspManagerLike | undefined;
        let mcpManager: McpManagerLike | undefined;
        let taskRuntime: TaskRuntimeLike | undefined;
        let memory: MemoryRuntimeLike | undefined;
        let closeOwnedResources: (() => Promise<void>) | undefined;
        const sandbox = await createSandboxRuntime({
            cwd: options.cwd,
            settings: options.settings.sandbox,
        });
        const shellRunner = createShellRunner(sandbox);
        const primaryModel = createPrimaryModelRuntime(
            options.settings.models.primary,
            options.settings.sources
        );

        try {
            const fileState = dependencies.createFileStateTracker();
            const gitWorkspace = createGitWorkspaceRuntime(options.cwd);
            const createdMemory = dependencies.createMemoryRuntime({
                cwd: options.cwd,
                getModelTarget: () => primaryModel.target,
                getModelSource: (source) => options.settings.sources[source],
                shellRunner,
                settings: options.settings.memory,
            });
            memory = createdMemory;
            lspManager = dependencies.createLspManager(options.cwd);
            mcpManager = dependencies.createMcpManager({
                cwd: options.cwd,
                signal: options.signal,
                headless: options.headless,
                requestApproval: options.requestMcpApproval,
            });
            await mcpManager?.initialize();
            const hooks = await dependencies.createHookRuntime({
                cwd: options.cwd,
                hooks: options.settings.hooks,
                headless: options.headless,
                signal: options.signal,
                promptExecutor: createHookPromptExecutor({
                    source: options.settings.sources[options.settings.models.fast.source],
                    cwd: options.cwd,
                    model: options.settings.models.fast.model,
                }),
                requestTrust: options.requestHookTrust,
            });
            const additionalTools = mcpManager?.getTools() ?? [];
            const toolCatalog = dependencies.createToolRuntime({
                additionalTools,
            });
            const validateLoadedAgents = (loaded: LoadedCustomAgents) =>
                validateCustomAgentTools(loaded, toolCatalog.toolNames);
            const subagents = createSubagentCatalog({
                initial: validateLoadedAgents(loadedCustomAgents),
                load: async () => validateLoadedAgents(
                    await dependencies.loadCustomAgentDefinitions(options.cwd)
                ),
            });
            const agentDefinitions = createAgentDefinitionManager({
                store: createAgentDefinitionStore(options.cwd),
                catalog: subagents,
                availableToolNames: toolCatalog.toolNames,
            });
            const agentAuthoring = createAgentAuthoringRuntime({
                cwd: options.cwd,
                getModelTarget: () => primaryModel.target,
                getModelSource: (source) => options.settings.sources[source],
                instructions,
                availableToolNames: toolCatalog.toolNames.filter(
                    (name) => !name.startsWith("mcp__")
                ),
                getExistingAgentNames: () => subagents
                    .listDefinitions()
                    .map((definition) => definition.agentType),
            });
            const toolRuntime = dependencies.createToolRuntime({
                additionalTools,
                toolOverrides: [
                    createAgentTool(
                        subagents,
                        options.settings.models.fast.model
                    ),
                ],
                hooks,
            });
            const agentRuntime = dependencies.createAgentRuntime({
                fastModel: options.settings.models.fast,
                sources: options.settings.sources,
                subagents,
                memory: createdMemory,
            });
            const createdTaskRuntime = dependencies.createTaskRuntime(
                options.cwd,
                shellRunner,
                agentRuntime.createSubagentRunner,
                subagents
            );
            taskRuntime = createdTaskRuntime;
            closeOwnedResources = createResourceCloser(
                mcpManager,
                lspManager,
                createdTaskRuntime,
                createdMemory,
                sandbox
            );

            return {
                cwd: options.cwd,
                get model() {
                    return primaryModel.target.model;
                },
                get provider() {
                    return primaryModel.target.provider;
                },
                fastModel: options.settings.models.fast.model,
                fastProvider: options.settings.models.fast.provider,
                primaryModel,
                settings: options.settings,
                agentRuntime,
                subagents,
                agentDefinitions,
                agentAuthoring,
                skills,
                instructions,
                toolRuntime,
                hooks,
                mcpManager,
                lspManager,
                taskRuntime: createdTaskRuntime,
                shellRunner,
                sandbox,
                fileState,
                memory: createdMemory,
                memoryFiles: createdMemory.enabled
                    ? createdMemory.fileAccess("explicit")
                    : undefined,
                gitWorkspace,
                close: closeOwnedResources,
            };
        } catch (error) {
            if (closeOwnedResources) {
                await closeOwnedResources();
            } else {
                await Promise.allSettled([
                    taskRuntime?.close(),
                    lspManager?.shutdown(),
                    mcpManager?.closeAll(),
                    memory?.close(),
                    sandbox.close(),
                ]);
            }
            throw error;
        }
    };
}

export const createRootRuntimeResources =
    createRootRuntimeResourcesFactory();
