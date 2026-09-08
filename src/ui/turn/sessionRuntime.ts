import type {MessageContent, ContentPart} from "../../images/content.js";
import {createCompactState} from "../../context/index.js";
import {createInitialHistory} from "../../prompt/index.js";
import {createRootSessionRuntime, type RootSessionRuntime} from "../../runtime/sessionRuntime.js";
import {createSessionId, type LoadedSession} from "../../session/index.js";
import type {RootRuntimeResources} from "../../runtime/resources.js";

export interface UITurnSessionRuntime {
    rootSession: RootSessionRuntime;
    resumedDraft?: MessageContent;
}

/** Compose Session-owned resources outside the interactive App render path. */
export function createUITurnSessionRuntime(
    resources: RootRuntimeResources,
    initialSession?: LoadedSession
): UITurnSessionRuntime {
    const queuedInputs = initialSession?.queuedInputs ?? [];
    const userInputs = queuedInputs.filter(
        (message) => message.type === "user_input"
    );
    const rootSession = createRootSessionRuntime({
        resources,
        seed: {
            sessionId: initialSession?.sessionId ?? createSessionId(),
            history:
                initialSession?.history ??
                createInitialHistory(resources.cwd, resources.model),
            compactState:
                initialSession?.compactState ?? createCompactState(),
            checkpointHead: initialSession?.checkpointHead,
            toolDiscovery: initialSession?.toolDiscovery,
            gitSession: initialSession?.gitSession,
            taskNotificationReceipts: initialSession?.taskNotificationReceipts,
            queuedInputs: queuedInputs.filter(
                (message) => message.type !== "user_input"
            ),
        },
        resumed: Boolean(initialSession),
    });
    return {
        rootSession,
        ...(userInputs.length > 0
            ? {
                resumedDraft: userInputs.every(message => typeof message.content === "string") ? userInputs.map(message => message.content).join("\n")
                    : userInputs.flatMap<ContentPart>(message => typeof message.content === "string" ? [{type: "text", text: message.content}] : message.content),
            }
            : {}),
    };
}
