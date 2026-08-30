import {useEffect, useState} from "react";
import {Box, Text, useApp, useInput} from "ink";
import {ResumePicker} from "./resume/ResumePicker.js";
import {
    listSessionIndex,
    type LoadedSession,
    loadLatestSession,
    loadSession,
    type ResumeMode,
    type SessionIndexEntry,
} from "../session/index.js";
import type {PermissionMode} from "../permissions/index.js";
import {COLORS} from "./theme.js";
import type {ResolvedPillarSettings} from "../settings/index.js";
import {RuntimeBootstrap} from "./bootstrap/RuntimeBootstrap.js";
import type {PillarStorageLayout} from "../persistence/index.js";

type RootState =
    | { view: "loading" }
    | { view: "app"; session?: LoadedSession }
    | { view: "picker"; sessions: SessionIndexEntry[] }
    | { view: "error"; message: string };

function createRootState(
    storage: PillarStorageLayout,
    cwd: string,
    model: string,
    resumeMode: ResumeMode
): RootState {
    if (resumeMode.kind === "none") {
        return {view: "app"};
    }

    if (resumeMode.kind === "continue") {
        const session = loadLatestSession(storage, cwd, model);
        return session
            ? {view: "app", session}
            : {view: "error", message: "没有找到可继续的历史会话。"};
    }

    if (resumeMode.kind === "session") {
        const session = loadSession(storage, cwd, resumeMode.sessionId, model);
        return session
            ? {view: "app", session}
            : {view: "error", message: `没有找到会话: ${resumeMode.sessionId}`};
    }

    const sessions = listSessionIndex(storage, cwd);
    return sessions.length > 0
        ? {view: "picker", sessions}
        : {view: "error", message: "没有找到可恢复的历史会话。"};
}

export function Root({
                         storage,
                         cwd,
                         settings,
                         initialPermissionMode,
                         resumeMode,
                     }: {
    storage: PillarStorageLayout;
    cwd: string;
    settings: ResolvedPillarSettings;
    initialPermissionMode?: PermissionMode;
    resumeMode: ResumeMode;
}) {
    const {exit} = useApp();
    const model = settings.models.primary.model;
    const [state, setState] = useState<RootState>({view: "loading"});

    useEffect(() => {
        let active = true;
        Promise.resolve().then(() =>
            createRootState(storage, cwd, model, resumeMode)
        ).then((next) => {
            if (active) setState(next);
        }).catch((error) => {
            if (active) {
                setState({
                    view: "error",
                    message: `读取会话失败: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        });
        return () => {
            active = false;
        };
    }, [cwd, model, resumeMode, storage]);

    useInput(
        (input, key) => {
            if ((key.ctrl && input === "c") || input === "\x03") exit();
        },
        {isActive: state.view !== "app"}
    );

    if (state.view === "picker") {
        return (
            <ResumePicker
                sessions={state.sessions}
                onSelect={(sessionId) => {
                    try {
                        const session = loadSession(
                            storage,
                            cwd,
                            sessionId,
                            model
                        );
                        setState(
                            session
                                ? {view: "app", session}
                                : {view: "error", message: `没有找到会话: ${sessionId}`}
                        );
                    } catch (error) {
                        setState({
                            view: "error",
                            message: `读取会话失败: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    }
                }}
                onCancel={exit}
            />
        );
    }

    if (state.view === "error") {
        return (
            <Box flexDirection="column">
                <Text color={COLORS.assistant}>● {state.message}</Text>
                <Text color={COLORS.dim}>请直接运行 pillar 开始新会话。</Text>
            </Box>
        );
    }

    if (state.view === "loading") {
        return <Text color={COLORS.dim}>正在读取会话…</Text>;
    }

    return (
        <RuntimeBootstrap
            storage={storage}
            cwd={cwd}
            settings={settings}
            initialPermissionMode={initialPermissionMode}
            session={state.session}
            onSessionSwitch={(session) => setState({view: "app", session})}
        />
    );
}
