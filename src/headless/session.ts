import {createCompactState} from "../context/index.js";
import type {PermissionMode} from "../permissions/index.js";
import {createInitialHistory} from "../prompt/index.js";
import {createSessionId, loadLatestSession, loadSession,} from "../session/index.js";
import type {Todo} from "../todos.js";
import type {Message} from "../llm/types.js";
import type {PersistedUIEvent} from "../session/index.js";
import type {HeadlessOptions} from "./types.js";
import type {CheckpointHead} from "../checkpoints/index.js";
import type {ToolDiscoverySnapshot} from "../tools/registry.js";
import type {GitSessionState} from "../git/index.js";

export interface HeadlessSessionState {
    sessionId: string;
    history: Message[];
    todos: Todo[];
    permissionMode: PermissionMode;
    prePlanMode?: PermissionMode;
    compactState: ReturnType<typeof createCompactState>;
    uiEvents: PersistedUIEvent[];
    checkpointHead?: CheckpointHead;
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
}

export function loadHeadlessSession(
    options: Pick<
        HeadlessOptions,
        "storage" | "cwd" | "settings" | "resumeMode" | "permissionMode"
    >
): HeadlessSessionState {
    const {storage, cwd, settings, resumeMode, permissionMode} = options;
    const model = settings.models.primary.model;
    if (resumeMode.kind === "picker") {
        throw new Error("headless 模式不能使用交互式 -r；请使用 -c 或 -r <sessionId>");
    }

    const loaded = resumeMode.kind === "continue"
        ? loadLatestSession(storage, cwd, model)
        : resumeMode.kind === "session"
            ? loadSession(storage, cwd, resumeMode.sessionId, model)
            : null;

    if (resumeMode.kind !== "none" && !loaded) {
        throw new Error(
            resumeMode.kind === "continue"
                ? "没有找到可继续的历史会话"
                : `没有找到会话: ${resumeMode.sessionId}`
        );
    }

    return {
        sessionId: loaded?.sessionId ?? createSessionId(),
        history: loaded?.history ?? createInitialHistory(cwd, model),
        todos: loaded?.todos ?? [],
        permissionMode:
            permissionMode ??
            loaded?.permissionMode ??
            settings.permissions.defaultMode,
        prePlanMode: loaded?.prePlanMode,
        compactState: loaded?.compactState ?? createCompactState(),
        uiEvents: loaded?.uiEvents ?? [],
        checkpointHead: loaded?.checkpointHead,
        toolDiscovery: loaded?.toolDiscovery,
        gitSession: loaded?.gitSession,
    };
}
