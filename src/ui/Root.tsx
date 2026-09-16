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
import type {CollaborationMode} from "../collaboration/index.js";
import {COLORS} from "./theme.js";
import {RuntimeBootstrap} from "./bootstrap/RuntimeBootstrap.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import type {HiCodeRootConfiguration} from "../runtime/rootConfiguration.js";
import type {InteractiveShutdown} from "../cli/interactiveShutdown.js";

type RootState =
    | { view: "loading" }
    | { view: "app"; session?: LoadedSession }
    | { view: "picker"; sessions: SessionIndexEntry[] }
    | { view: "error"; message: string };

function createRootState(
    storage: HiCodeStorageLayout,
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
            : {view: "error", message: "No previous session available to continue."};
    }

    if (resumeMode.kind === "session") {
        const session = loadSession(storage, cwd, resumeMode.sessionId, model);
        return session
            ? {view: "app", session}
            : {view: "error", message: `Session not found: ${resumeMode.sessionId}`};
    }

    const sessions = listSessionIndex(storage, cwd);
    return sessions.length > 0
        ? {view: "picker", sessions}
        : {view: "error", message: "No previous session available to resume."};
}

export function Root({
                         configuration,
                         shutdown,
                         initialPermissionMode,
                         initialCollaborationMode,
        initialImages,
                         resumeMode,
                     }: {
    configuration: HiCodeRootConfiguration;
    shutdown: InteractiveShutdown;
    initialPermissionMode?: PermissionMode;
    initialCollaborationMode?: CollaborationMode;
    initialImages?: readonly string[];
    resumeMode: ResumeMode;
}) {
    const {exit} = useApp();
    const {cwd, settings, storage} = configuration;
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
                    message: `Failed to read session: ${error instanceof Error ? error.message : String(error)}`,
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
                                : {view: "error", message: `Session not found: ${sessionId}`}
                        );
                    } catch (error) {
                        setState({
                            view: "error",
                            message: `Failed to read session: ${error instanceof Error ? error.message : String(error)}`,
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
                <Text color={COLORS.dim}>Run hicode directly to start a new session.</Text>
            </Box>
        );
    }

    if (state.view === "loading") {
        return <Text color={COLORS.dim}>Reading session…</Text>;
    }

    return (
        <RuntimeBootstrap
            shutdown={shutdown}
            configuration={configuration}
            initialPermissionMode={initialPermissionMode}
            initialCollaborationMode={initialCollaborationMode}
                initialImages={initialImages}
            session={state.session}
            onSessionSwitch={(session) => setState({view: "app", session})}
        />
    );
}
