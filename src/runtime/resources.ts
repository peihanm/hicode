import {createModelConfiguration, type ModelConfiguration} from "../settings/modelConfiguration.js";
import {acquireProjectActivity} from "../persistence/projectState.js";
import {loadHiCodeSettings} from "../settings/index.js";
import {FileCommitCoordinator} from "../tools/shared/fileCommit.js";
import {createMcpManager} from "../mcp/manager.js";
import type {McpManagerLike, McpManagerOptions, McpServerSnapshot} from "../mcp/types.js";
import {loadSkills} from "../skills/loader.js";
import type {LoadedSkill, SkillLoadIssue} from "../skills/types.js";
import {createToolRuntime, type ToolRuntime,} from "../tools/registry.js";
import {createToolCatalog} from "../tools/catalog.js";
import {createTaskRuntime, type TaskRuntimeLike,} from "../tasks/index.js";
import {createShellRunner, type ShellRunnerLike,} from "../tools/bash/shellRunner.js";
import {createSandboxRuntime, type SandboxRuntimeLike,} from "../sandbox/index.js";
import {loadProjectInstructions, type ProjectInstructions,} from "../prompt/instructions.js";
import type {ResolvedHiCodeSettings} from "../settings/index.js";
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
import type {HiCodeStorageLayout} from "../persistence/index.js";
import {createInputHistoryStore, type InputHistoryStore,} from "../session/inputHistory/index.js";
import {
    createChildProcessEnvironment,
} from "./childEnvironment.js";
import type {HiCodeRootConfiguration} from "./rootConfiguration.js";
import type {Tool} from "../tools/types.js";

export interface RootRuntimeResources {
    readonly approvalReviewer: AgentRuntime["reviewApproval"];
    readonly allowFullAccess: boolean;
    readonly storage: HiCodeStorageLayout;
    readonly inputHistory: InputHistoryStore;
    readonly cwd: string;
    readonly workspaceBoundary: string;
    readonly model: string;
    readonly provider: ResolvedHiCodeSettings["models"]["primary"]["source"];
    readonly fastModel: string;
    readonly fastProvider: ResolvedHiCodeSettings["models"]["primary"]["source"];
    readonly primaryModel: PrimaryModelRuntime;
    readonly modelConfiguration?: ModelConfiguration;
    readonly settings: ResolvedHiCodeSettings;
    readonly agentRuntime: AgentRuntime;
    readonly subagents: SubagentCatalog;
    readonly agentDefinitions: AgentDefinitionManager;
    readonly agentAuthoring: AgentAuthoringRuntime;
    readonly skills: LoadedSkill[];
    readonly skillIssues: readonly SkillLoadIssue[];
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
    configuration: HiCodeRootConfiguration;
    signal?: AbortSignal;
    headless?: boolean;
    requestMcpApproval?: McpManagerOptions["requestApproval"];
    /** Startup-only observation; the Root retains ownership of the Manager. */
    onMcpStartup?: (servers: readonly McpServerSnapshot[]) => void;
    requestHookTrust?: (
        request: HookTrustRequest
    ) => Promise<"once" | "always" | "deny">;
    /** Root-only tools supplied by a programmatic Host. */
    additionalTools?: readonly Tool[];
}

interface RootRuntimeDependencies {
    createSandboxRuntime: typeof createSandboxRuntime;
    createMcpManager(
        options: McpManagerOptions
    ): McpManagerLike | undefined;

    loadSkills: typeof loadSkills;
    loadProjectInstructions: typeof loadProjectInstructions;
    createToolRuntime: typeof createToolRuntime;
    createHookRuntime: typeof createHookRuntime;

    createTaskRuntime(
        storage: HiCodeStorageLayout,
        cwd: string,
        shellRunner: ShellRunnerLike,
        createSubagentThread: CreateSubagentThread,
        subagents: SubagentCatalog,
        memory:MemoryRuntimeLike
    ): TaskRuntimeLike;
    createAgentRuntime: typeof createAgentRuntime;

    createMemoryRuntime: typeof createMemoryRuntime;

    loadCustomAgentDefinitions(
        storage: HiCodeStorageLayout,
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
        createSandboxRuntime: overrides.createSandboxRuntime ?? createSandboxRuntime,
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
        const releaseActivity = await acquireProjectActivity(storage,cwd);
        try {
        const [loadedSkills, instructions, loadedCustomAgents] = await Promise.all([
            Promise.resolve(dependencies.loadSkills({
                storage,
                cwd,
                sources: options.configuration.fileSources.skills,
                hostSkills: options.configuration.contributions.skills,
            })),
            dependencies.loadProjectInstructions({
                cwd,
                boundary: options.configuration.workspaceBoundary,
                userHiCodeHome: storage.hicodeHome,
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
        const {skills, issues: skillIssues} = loadedSkills;
        let mcpManager: McpManagerLike | undefined;
        let taskRuntime: TaskRuntimeLike | undefined;
        let memory: MemoryRuntimeLike | undefined;
        let closeOwnedResources: RootResourceCloser | undefined;
        const sandbox = await dependencies.createSandboxRuntime({
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
                getModelSource: (source) => primaryModel.sources[source],
                shellRunner,
                settings: settings.memory,
                contextSettings: settings.context,
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
            const publishMcpStartup = () => {
                try {options.onMcpStartup?.(mcpManager?.getSnapshots() ?? []);}
                catch { /* A display observer cannot interrupt resource initialization. */ }
            };
            const unsubscribeMcpStartup = options.onMcpStartup ? mcpManager?.subscribe(publishMcpStartup) : undefined;
            try {
                publishMcpStartup();
                await mcpManager?.initialize();
            } finally {
                publishMcpStartup();
                unsubscribeMcpStartup?.();
            }
            const hooks = await dependencies.createHookRuntime({
                storage,
                cwd,
                hooks: settings.hooks,
                childEnvironment,
                headless: options.headless,
                signal: options.signal,
                promptExecutor: {execute(input) {
                    const target = settings.models.fast ?? primaryModel.target;
                    return createHookPromptExecutor({storage, cwd, model: target.model,
                        source: primaryModel.sources[target.source]}).execute(input);
                }},
                requestTrust: options.requestHookTrust,
            });
            const catalogToolNames = () => createToolCatalog({
                additionalTools: mcpManager?.getTools() ?? [],
            }).tools.map((tool) => tool.name);
            const validateLoadedAgents = (loaded: LoadedCustomAgents) =>
                validateCustomAgentTools(loaded, catalogToolNames());
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
                getAvailableToolNames: catalogToolNames,
            });
            const agentAuthoring = createAgentAuthoringRuntime({
                storage,
                cwd,
                getModelTarget: auxiliaryModelTarget,
                getModelSource: (source) => primaryModel.sources[source],
                instructions,
                availableToolNames: catalogToolNames().filter(
                    (name) => !name.startsWith("mcp__")
                ),
                getExistingAgentNames: () => subagents
                    .listDefinitions()
                    .map((definition) => definition.agentType),
            });
            const toolRuntime = dependencies.createToolRuntime({
                skillsAvailable: skills.length > 0,
                getAdditionalTools: () => [
                    ...(mcpManager?.getTools() ?? []),
                    ...(options.additionalTools ?? []),
                ],
                toolOverrides: [
                    createAgentTool(subagents),
                ],
                hooks,
            });
            const agentRuntime = dependencies.createAgentRuntime({
                storage,
                getSources: () => primaryModel.sources,
                subagents,
                memory: createdMemory,
            });
            const createdTaskRuntime = dependencies.createTaskRuntime(
                storage,
                cwd,
                shellRunner,
                agentRuntime.createSubagentThread,
                subagents,
                createdMemory
            );
            taskRuntime = createdTaskRuntime;
            closeOwnedResources = createResourceCloser(
                mcpManager,
                createdTaskRuntime,
                createdMemory,
                sandbox
            );

            let finalClose: Promise<void> | undefined;
            let hookUsers = 0;
            let hooksReloading = false;
            return {
                holdHookConfiguration() {
                    if (hooksReloading) throw new Error("Hooks are reloading; cannot start a Turn");
                    hookUsers++;
                    let released = false;
                    return () => {if (!released) {released = true; hookUsers--;}};
                },
                async reloadHooks(signal) {
                    if (hookUsers || hooksReloading || createdTaskRuntime.hasRunning()) throw new Error("A Turn, background task or Hook reload is still active");
                    hooksReloading = true;
                    try {
                        const loaded = loadHiCodeSettings({storage, cwd, sources: options.configuration.fileSources.settings});
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
                approvalReviewer: agentRuntime.reviewApproval,
                allowFullAccess: options.configuration.allowFullAccess,
                get model() {
                    return primaryModel.target.model;
                },
                get provider() {
                    return primaryModel.target.source;
                },
                get fastModel() {return (settings.models.fast ?? primaryModel.target).model;},
                get fastProvider() {return (settings.models.fast ?? primaryModel.target).source;},
                primaryModel,
                modelConfiguration: options.configuration.fileSources.settings.includes("user") ? createModelConfiguration(storage, cwd, primaryModel, [settings.models.fast, settings.models.reviewer].filter((target): target is NonNullable<typeof target> => target !== undefined)) : undefined,
                settings,
                agentRuntime,
                subagents,
                agentDefinitions,
                agentAuthoring,
                skills,
                skillIssues,
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
                close: () => finalClose ??= (async () => {try {await closeOwnedResources!.close();} finally {await releaseActivity();}})(),
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
        } catch (error) {await releaseActivity();throw error;}
    };
}

export const createRootRuntimeResources =
    createRootRuntimeResourcesFactory();
