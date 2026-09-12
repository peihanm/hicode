import type {InteractiveShutdown} from "../../cli/interactiveShutdown.js";
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
    shutdown: InteractiveShutdown;
    configuration: PillarRootConfiguration;
    initialPermissionMode?: PermissionMode;
    initialCollaborationMode?: CollaborationMode;
    initialImages?: readonly string[];
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
        shutdown,
        initialPermissionMode,
        initialCollaborationMode,
        initialImages,
        session,
        onSessionSwitch,
    }: RuntimeBootstrapProps) {
        const {cwd, settings, storage} = configuration;
        const initialImageSession = useRef(session?.sessionId ?? "new");
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
        const closedResourcesRef = useRef(new WeakMap<RootRuntimeResources, Promise<void>>());
        const closeResources = async (resources?: RootRuntimeResources) => {
            if (!resources) return;
            let closing = closedResourcesRef.current.get(resources);
            if (!closing) {closing = resources.close(); closedResourcesRef.current.set(resources, closing);}
            await closing;
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
            const abortInitialization = () => controller.abort("shutdown");
            shutdown.signal.addEventListener("abort", abortInitialization, {once: true});
            if (shutdown.signal.aborted) abortInitialization();
            sessionShutdownRef.current = null;
            setReady(null);
            setError(null);
            const initialization = (async () => {
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
                const initialSession = session;
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
            const dispose = shutdown.register(async () => {
                disposed = true;
                shutdown.signal.removeEventListener("abort", abortInitialization);
                controller.abort("shutdown");
                pendingRef.current?.resolve("deny");
                pendingRef.current = null;
                pendingHookRef.current?.resolve("deny");
                pendingHookRef.current = null;
                const shutdownSession = sessionShutdownRef.current;
                ownedResources?.beginShutdown();
                try {await shutdownSession?.();}
                finally {await initialization; await closeResources(ownedResources);}
            });
            return dispose;
        }, [configuration, cwd, session, settings, storage, shutdown]);

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
        if (pendingHook && !ready) {
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
                    <Text color={COLORS.error}>Runtime initialization failed: {error}</Text>
                    <Text color={COLORS.dim}>Press Ctrl+C to exit.</Text>
                </Box>
            );
        }
        const sessionKey = session?.sessionId ?? "new";
        if (!ready || ready.sessionKey !== sessionKey) {
            return (
                <Box flexDirection="column">
                    <Welcome/>
                    <Text color={COLORS.dim}>{SYMBOLS.spinner} Initializing Runtime…</Text>
                </Box>
            );
        }
        return (
            <App
                key={sessionKey}
                resources={ready.resources}
                runtimeApproval={pendingHook ? <HookApprovalDialog request={pendingHook.request} onDecision={decision => {
                    pendingHook.resolve(decision); pendingHookRef.current = null; setPendingHook(null);
                }}/> : undefined}
                rootSession={ready.session.rootSession}
                resumedDraft={ready.session.resumedDraft}
                initialPermissionMode={initialPermissionMode}
                initialCollaborationMode={initialCollaborationMode}
                initialImages={sessionKey === initialImageSession.current ? initialImages : undefined}
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
                            throw new Error(`Session not found: ${sessionId}`);
                        }
                        const shutdownSession = sessionShutdownRef.current;
                        if (!shutdownSession) {
                            throw new Error("Session Runtime is not ready");
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
