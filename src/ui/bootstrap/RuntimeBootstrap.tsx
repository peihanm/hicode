import {recoverSessionBeforeStart} from "../../checkpoints/rewind.js";
import {useEffect, useRef, useState} from "react";
import {Box, Text, useApp, useInput} from "ink";
import type {PermissionMode} from "../../permissions/index.js";
import type {CollaborationMode} from "../../collaboration/index.js";
import {loadSession, type LoadedSession} from "../../session/index.js";
import {
    createRootRuntimeResources,
    type RootRuntimeResources,
} from "../../runtime/resources.js";
import {
    type McpApprovalDecision,
    type McpApprovalRequest,
} from "../../mcp/index.js";
import type {HookTrustDecision, HookTrustRequest} from "../../hooks/index.js";
import {App} from "../App.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {HookApprovalDialog} from "./HookApprovalDialog.js";
import {McpApprovalDialog} from "./McpApprovalDialog.js";
import {Welcome} from "./Welcome.js";
import type {PillarRootConfiguration} from "../../runtime/rootConfiguration.js";
import {createUITurnSessionRuntime, type UITurnSessionRuntime,} from "../turn/sessionRuntime.js";

interface PendingMcpApproval {
    request: McpApprovalRequest;
    resolve: (decision: McpApprovalDecision) => void;
}

interface PendingHookApproval {
    request: HookTrustRequest;
    resolve: (decision: HookTrustDecision) => void;
}

interface RuntimeBootstrapProps {
    configuration: PillarRootConfiguration;
    initialPermissionMode?: PermissionMode;
    initialCollaborationMode?: CollaborationMode;
    session?: LoadedSession;
    onSessionSwitch?: (session: LoadedSession) => void;
}

interface RuntimeBootstrapDependencies {
    createResources: typeof createRootRuntimeResources;
}

export function createRuntimeBootstrap(
    overrides: Partial<RuntimeBootstrapDependencies> = {}
) {
    const createResources =
        overrides.createResources ?? createRootRuntimeResources;

    return function RuntimeBootstrap({
        configuration,
        initialPermissionMode,
        initialCollaborationMode,
        session,
        onSessionSwitch,
    }: RuntimeBootstrapProps) {
        const {cwd, settings, storage} = configuration;
        const {exit} = useApp();
        const pendingRef = useRef<PendingMcpApproval | null>(null);
        const [pending, setPending] = useState<PendingMcpApproval | null>(null);
        const pendingHookRef = useRef<PendingHookApproval | null>(null);
        const [pendingHook, setPendingHook] = useState<PendingHookApproval | null>(null);
        const [ready, setReady] = useState<{
            resources: RootRuntimeResources;
            session: UITurnSessionRuntime;
            sessionKey: string;
            initialSession?: LoadedSession;
        } | null>(null);
        const [error, setError] = useState<string | null>(null);
        const sessionShutdownRef = useRef<(() => Promise<void>) | null>(null);
        const closedResourcesRef = useRef(new WeakSet<RootRuntimeResources>());
        const closeResources = async (resources?: RootRuntimeResources) => {
            if (!resources || closedResourcesRef.current.has(resources)) return;
            closedResourcesRef.current.add(resources);
            await resources.close();
        };

        useInput((input, key) => {
            if ((key.ctrl && input === "c") || input === "\x03") {
                pending?.resolve("deny");
                pendingHook?.resolve("deny");
                pendingRef.current = null;
                pendingHookRef.current = null;
                exit();
            }
        }, {isActive: !ready});

        useEffect(() => {
            let disposed = false;
            const controller = new AbortController();
            let ownedResources: RootRuntimeResources | undefined;
            sessionShutdownRef.current = null;
            setReady(null);
            setError(null);
            void (async () => {
                const resources = await createResources({
                    configuration,
                    signal: controller.signal,
                    requestMcpApproval: (request) => {
                        if (disposed) return Promise.resolve("deny");
                        return new Promise<McpApprovalDecision>((resolve) => {
                            const value = {request, resolve};
                            pendingRef.current = value;
                            setPending(value);
                        });
                    },
                    requestHookTrust: (request) => {
                        if (disposed) return Promise.resolve("deny");
                        return new Promise<HookTrustDecision>((resolve) => {
                            const value = {request, resolve};
                            pendingHookRef.current = value;
                            setPendingHook(value);
                        });
                    },
                });
                ownedResources = resources;
                const initialSession = session ? (await recoverSessionBeforeStart(resources, session.sessionId)) ?? session : undefined;
                const turnSession = createUITurnSessionRuntime(resources, initialSession);
                await turnSession.rootSession.initialize();
                if (disposed) {
                    await closeResources(resources);
                    return;
                }
                setReady({
                    resources,
                    session: turnSession,
                    initialSession,
                    sessionKey: session?.sessionId ?? "new",
                });
            })().catch(async (reason) => {
                const failedResources = ownedResources;
                ownedResources = undefined;
                await closeResources(failedResources);
                if (!disposed) {
                    const message = reason instanceof Error
                        ? reason.message
                        : String(reason);
                    setError(message.slice(0, 1000));
                }
            });
            return () => {
                disposed = true;
                controller.abort("shutdown");
                pendingRef.current?.resolve("deny");
                pendingRef.current = null;
                pendingHookRef.current?.resolve("deny");
                pendingHookRef.current = null;
                const resourcesToClose = ownedResources;
                const shutdownSession = sessionShutdownRef.current;
                void (async () => {
                    await shutdownSession?.();
                    await closeResources(resourcesToClose);
                })();
            };
        }, [configuration, cwd, session, settings, storage]);

        if (pending) {
            return (
                <McpApprovalDialog
                    request={pending.request}
                    onDecision={(decision) => {
                        pending.resolve(decision);
                        pendingRef.current = null;
                        setPending(null);
                    }}
                />
            );
        }
        if (pendingHook) {
            return (
                <HookApprovalDialog
                    request={pendingHook.request}
                    onDecision={(decision) => {
                        pendingHook.resolve(decision);
                        pendingHookRef.current = null;
                        setPendingHook(null);
                    }}
                />
            );
        }
        if (error) {
            return (
                <Box flexDirection="column">
                    <Text color={COLORS.error}>Runtime 初始化失败：{error}</Text>
                    <Text color={COLORS.dim}>按 Ctrl+C 退出。</Text>
                </Box>
            );
        }
        const sessionKey = session?.sessionId ?? "new";
        if (!ready || ready.sessionKey !== sessionKey) {
            return (
                <Box flexDirection="column">
                    <Welcome/>
                    <Text color={COLORS.dim}>{SYMBOLS.spinner} 正在初始化运行时…</Text>
                </Box>
            );
        }
        return (
            <App
                key={sessionKey}
                resources={ready.resources}
                rootSession={ready.session.rootSession}
                resumedDraft={ready.session.resumedDraft}
                initialPermissionMode={initialPermissionMode}
                initialCollaborationMode={initialCollaborationMode}
                initialSession={ready.initialSession}
                registerSessionShutdown={(shutdown) => {
                    sessionShutdownRef.current = shutdown;
                }}
                requestSessionSwitch={onSessionSwitch
                    ? async (sessionId) => {
                        const target = loadSession(
                            storage,
                            cwd,
                            sessionId,
                            settings.models.primary.model
                        );
                        if (!target) {
                            throw new Error(`没有找到会话: ${sessionId}`);
                        }
                        const shutdownSession = sessionShutdownRef.current;
                        if (!shutdownSession) {
                            throw new Error("当前 Session Runtime 尚未准备好");
                        }
                        await shutdownSession();
                        await closeResources(ready.resources);
                        onSessionSwitch(target);
                    }
                    : undefined}
            />
        );
    };
}

export const RuntimeBootstrap = createRuntimeBootstrap();
