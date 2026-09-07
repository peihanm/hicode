import {loadPillarSettings} from "../settings/index.js";
import {FileCommitCoordinator} from "../checkpoints/fileCommit.js";
import {createMcpManager} from "../mcp/manager.js";
import type {McpManagerLike, McpManagerOptions,} from "../mcp/types.js";
import {loadSkills} from "../skills/loader.js";
import type {LoadedSkill} from "../skills/types.js";
import {createToolRuntime, type ToolRuntime,} from "../tools/registry.js";
import {createToolCatalog} from "../tools/catalog.js";
import {createTaskRuntime, type TaskRuntimeLike,} from "../tasks/index.js";
import {createShellRunner, type ShellRunnerLike,} from "../tools/bash/shellRunner.js";
import {createSandboxRuntime, type SandboxRuntimeLike,} from "../sandbox/index.js";
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
import type {CreateSubagentThread} from "../subagents/types.js";
import type {AgentFileSource} from "../subagents/types.js";
import type {HostAgentContribution} from "./rootContributions.js";
import {createHookPromptExecutor, createHookRuntime, type HookRuntime, type HookTrustRequest,} from "../hooks/index.js";
import {createMemoryRuntime, type MemoryRuntimeLike,} from "../memory/index.js";
import {createGitWorkspaceRuntime, type GitWorkspaceRuntimeLike,} from "../git/index.js";
import {createPrimaryModelRuntime, type PrimaryModelRuntime,} from "./primaryModel.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {createInputHistoryStore, type InputHistoryStore,} from "../session/inputHistory/index.js";
import {
    createChildProcessEnvironment,
    type ChildProcessEnvironment,
} from "./childEnvironment.js";
import type {PillarRootConfiguration} from "./rootConfiguration.js";
import type {Tool} from "../tools/types.js";

export interface RootRuntimeResources {
    readonly storage: PillarStorageLayout;
    readonly inputHistory: InputHistoryStore;
    readonly cwd: string;
    readonly workspaceBoundary: string;
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
    readonly taskRuntime: TaskRuntimeLike;
    readonly fileCommits: FileCommitCoordinator;
    readonly shellRunner: ShellRunnerLike;
    readonly sandbox: SandboxRuntimeLike;
    readonly memory: MemoryRuntimeLike;
    readonly gitWorkspace: GitWorkspaceRuntimeLike;

    holdHookConfiguration(): () => void;
    reloadHooks(signal: AbortSignal): Promise<void>;
    beginShutdown(): void;
    close(): Promise<void>;
}

export interface CreateRootRuntimeResourcesOptions {
    configuration: PillarRootConfiguration;
    signal?: AbortSignal;
    headless?: boolean;
    requestMcpApproval?: McpManagerOptions["requestApproval"];
    requestHookTrust?: (
        request: HookTrustRequest
    ) => Promise<"once" | "always" | "deny">;
    /** Root-only tools supplied by a programmatic Host. */
    additionalTools?: readonly Tool[];
}

interface RootRuntimeDependencies {
    createMcpManager(
        options: McpManagerOptions
    ): McpManagerLike | undefined;

    loadSkills: typeof loadSkills;
    loadProjectInstructions: typeof loadProjectInstructions;
    createToolRuntime: typeof createToolRuntime;
    createHookRuntime: typeof createHookRuntime;

    createTaskRuntime(
        storage: PillarStorageLayout,
        cwd: string,
        childEnvironment: ChildProcessEnvironment,
        shellRunner: ShellRunnerLike,
        createSubagentThread: CreateSubagentThread,
        subagents: SubagentCatalog
    ): TaskRuntimeLike;
    createAgentRuntime: typeof createAgentRuntime;

    createMemoryRuntime: typeof createMemoryRuntime;

    loadCustomAgentDefinitions(
        storage: PillarStorageLayout,
        cwd: string,
        sources?: readonly AgentFileSource[],
        hostAgents?: readonly HostAgentContribution[]
    ): Promise<LoadedCustomAgents>;
}

interface RootResourceCloser {
    beginShutdown(): void;
    close(): Promise<void>;
}

function createResourceCloser(
    mcpManager: McpManagerLike | undefined,
    taskRuntime: TaskRuntimeLike,
    memory: MemoryRuntimeLike,
    sandbox: SandboxRuntimeLike
): RootResourceCloser {
    let closePromise: Promise<void> | undefined;
    let taskClosePromise: Promise<void> | undefined;
    const beginShutdown = () => {
        taskClosePromise ??= Promise.resolve()
            .then(() => taskRuntime.close())
            .catch(() => undefined);
    };
    return {
        beginShutdown,
        close() {
            closePromise ??= (async () => {
                beginShutdown();
                await Promise.allSettled([taskClosePromise]);
                await Promise.allSettled([
                    mcpManager?.closeAll(),
                    memory.close(),
                ]);
                await Promise.allSettled([sandbox.close()]);
            })();
            return closePromise;
        },
    };
}

export function createRootRuntimeResourcesFactory(
    overrides: Partial<RootRuntimeDependencies> = {}
) {
    const dependencies: RootRuntimeDependencies = {
        createMcpManager: overrides.createMcpManager ?? createMcpManager,
        loadSkills: overrides.loadSkills ?? loadSkills,
        loadProjectInstructions:
            overrides.loadProjectInstructions ?? loadProjectInstructions,
        createToolRuntime: overrides.createToolRuntime ?? createToolRuntime,
        createHookRuntime: overrides.createHookRuntime ?? createHookRuntime,
        createTaskRuntime: overrides.createTaskRuntime ?? createTaskRuntime,
        createAgentRuntime: overrides.createAgentRuntime ?? createAgentRuntime,
        createMemoryRuntime:
            overrides.createMemoryRuntime ?? createMemoryRuntime,
        loadCustomAgentDefinitions:
            overrides.loadCustomAgentDefinitions ?? loadCustomAgentDefinitions,
    };

    return async function createRootRuntimeResources(
        options: CreateRootRuntimeResourcesOptions
    ): Promise<RootRuntimeResources> {
        const {cwd, settings, storage} = options.configuration;
        const [skills, instructions, loadedCustomAgents] = await Promise.all([
            Promise.resolve(dependencies.loadSkills({
                storage,
                cwd,
                sources: options.configuration.fileSources.skills,
                hostSkills: options.configuration.contributions.skills,
            })),
            dependencies.loadProjectInstructions({
                cwd,
                boundary: options.configuration.workspaceBoundary,
                userPillarHome: storage.pillarHome,
                sources: options.configuration.fileSources.instructions,
                hostInstructions: options.configuration.contributions.instructions,
            }),
            dependencies.loadCustomAgentDefinitions(
                storage,
                cwd,
                options.configuration.fileSources.agents,
                options.configuration.contributions.agents
            ),
        ]);
        let mcpManager: McpManagerLike | undefined;
        let taskRuntime: TaskRuntimeLike | undefined;
        let memory: MemoryRuntimeLike | undefined;
        let closeOwnedResources: RootResourceCloser | undefined;
        const sandbox = await createSandboxRuntime({
            cwd,
            storage,
            settings: settings.sandbox,
            writableRoots: settings.permissions.additionalDirectories,
        });

        try {
            const childEnvironment = createChildProcessEnvironment(
                process.env,
                Object.values(settings.sources).map(
                    (source) => source.apiKeyEnv
                )
            );
            const shellRunner = createShellRunner(sandbox, childEnvironment);
            const primaryModel = createPrimaryModelRuntime(
                settings.models.primary,
                settings.sources
            );
            const gitWorkspace = createGitWorkspaceRuntime(
                cwd,
                childEnvironment
            );
            const auxiliaryModelTarget = () => primaryModel.target;
            const createdMemory = dependencies.createMemoryRuntime({
                storage,
                cwd,
                getModelTarget: auxiliaryModelTarget,
                getModelSource: (source) => settings.sources[source],
                shellRunner,
                environment: childEnvironment,
                settings: settings.memory,
            });
            memory = createdMemory;
            mcpManager = dependencies.createMcpManager({
                storage,
                cwd,
                childEnvironment,
                signal: options.signal,
                headless: options.headless,
                sources: options.configuration.fileSources.mcp,
                hostServers: options.configuration.contributions.mcpServers,
                requestApproval: options.requestMcpApproval,
            });
            await mcpManager?.initialize();
            const hooks = await dependencies.createHookRuntime({
                storage,
                cwd,
                hooks: settings.hooks,
                childEnvironment,
                headless: options.headless,
                signal: options.signal,
                promptExecutor: createHookPromptExecutor({
                    storage,
                    source: settings.sources[settings.models.fast.source],
                    cwd,
                    model: settings.models.fast.model,
                }),
                requestTrust: options.requestHookTrust,
            });
            const mcpTools = mcpManager?.getTools() ?? [];
            const catalogToolNames = createToolCatalog({
                additionalTools: mcpTools,
            }).tools.map((tool) => tool.name);
            const validateLoadedAgents = (loaded: LoadedCustomAgents) =>
                validateCustomAgentTools(loaded, catalogToolNames);
            const subagents = createSubagentCatalog({
                initial: validateLoadedAgents(loadedCustomAgents),
                load: async () => validateLoadedAgents(
                    await dependencies.loadCustomAgentDefinitions(
                        storage,
                        cwd,
                        options.configuration.fileSources.agents,
                        options.configuration.contributions.agents
                    )
                ),
            });
            const agentDefinitions = createAgentDefinitionManager({
                store: createAgentDefinitionStore(storage, cwd),
                catalog: subagents,
                availableToolNames: catalogToolNames,
            });
            const agentAuthoring = createAgentAuthoringRuntime({
                storage,
                cwd,
                getModelTarget: auxiliaryModelTarget,
                getModelSource: (source) => settings.sources[source],
                instructions,
                availableToolNames: catalogToolNames.filter(
                    (name) => !name.startsWith("mcp__")
                ),
                getExistingAgentNames: () => subagents
                    .listDefinitions()
                    .map((definition) => definition.agentType),
            });
            const toolRuntime = dependencies.createToolRuntime({
                additionalTools: [
                    ...mcpTools,
                    ...(options.additionalTools ?? []),
                ],
                toolOverrides: [
                    createAgentTool(
                        subagents,
                        settings.models.fast.model
                    ),
                ],
                hooks,
            });
            const agentRuntime = dependencies.createAgentRuntime({
                storage,
                fastModel: settings.models.fast,
                sources: settings.sources,
                subagents,
                memory: createdMemory,
            });
            const createdTaskRuntime = dependencies.createTaskRuntime(
                storage,
                cwd,
                childEnvironment,
                shellRunner,
                agentRuntime.createSubagentThread,
                subagents
            );
            taskRuntime = createdTaskRuntime;
            closeOwnedResources = createResourceCloser(
                mcpManager,
                createdTaskRuntime,
                createdMemory,
                sandbox
            );

            let hookUsers = 0;
            let hooksReloading = false;
            return {
                holdHookConfiguration() {
                    if (hooksReloading) throw new Error("Hooks 正在重载，不能开始 Turn");
                    hookUsers++;
                    let released = false;
                    return () => {if (!released) {released = true; hookUsers--;}};
                },
                async reloadHooks(signal) {
                    if (hookUsers || hooksReloading || createdTaskRuntime.hasRunning()) throw new Error("Turn、后台任务或 Hook 重载尚未结束");
                    hooksReloading = true;
                    try {
                        const loaded = loadPillarSettings({storage, cwd, sources: options.configuration.fileSources.settings});
                        if (loaded.issues.length) throw new Error(loaded.issues.map(issue => issue.message).join("\n"));
                        // Host declarations are immutable contributions and are not re-read from disk.
                        for (const event of Object.keys(loaded.values.hooks) as (keyof typeof settings.hooks)[]) {
                            loaded.values.hooks[event] = [...loaded.values.hooks[event], ...settings.hooks[event].filter(item => item.source === "host")];
                        }
                        await hooks.reload(loaded.values.hooks, signal);
                    } finally {hooksReloading = false;}
                },
                storage,
                inputHistory: createInputHistoryStore(storage),
                cwd,
                workspaceBoundary: options.configuration.workspaceBoundary,
                get model() {
                    return primaryModel.target.model;
                },
                get provider() {
                    return primaryModel.target.provider;
                },
                fastModel: settings.models.fast.model,
                fastProvider: settings.models.fast.provider,
                primaryModel,
                settings,
                agentRuntime,
                subagents,
                agentDefinitions,
                agentAuthoring,
                skills,
                instructions,
                toolRuntime,
                hooks,
                mcpManager,
                taskRuntime: createdTaskRuntime,
                shellRunner,
                sandbox,
                memory: createdMemory,
                fileCommits: new FileCommitCoordinator(),
                gitWorkspace,
                beginShutdown: closeOwnedResources.beginShutdown,
                close: closeOwnedResources.close,
            };
        } catch (error) {
            if (closeOwnedResources) {
                await closeOwnedResources.close();
            } else {
                await Promise.allSettled([
                    taskRuntime?.close(),
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
