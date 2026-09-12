import {createTurnAbortController} from "../runtime/abort.js";
import {createRootRuntimeResources} from "../runtime/resources.js";
import {createRootTurnRunnerFactory, type RootSessionSnapshotWriter} from "../runtime/turnRuntime.js";
import {loadLatestSession, loadSession} from "../session/index.js";
import {createSDKThreadFactory, prepareThreadSession} from "../sdk/thread.js";
import {collectTurnResult} from "../sdk/resultCollector.js";
import type {ThreadEvent} from "../sdk/protocol.js";
import {formatAgentLoadIssue} from "../subagents/diagnostics.js";
import {writeHeadlessDiagnostic, writeHeadlessOutput} from "./io.js";
import {buildHeadlessRunSummary, formatHeadlessProgress} from "./output.js";
import type {HeadlessOptions, HeadlessOutputFormat, HeadlessRunSummary} from "./types.js";

interface HeadlessRunnerDependencies {
    createResources: typeof createRootRuntimeResources;
    saveSession: RootSessionSnapshotWriter;
    writeOutput(summary: HeadlessRunSummary, format: HeadlessOutputFormat): void | Promise<void>;
    writeDiagnostic(line: string): void | Promise<void>;
}

export function createHeadlessRunner(overrides: Partial<HeadlessRunnerDependencies> = {}) {
    const dependencies: HeadlessRunnerDependencies = {
        createResources: overrides.createResources ?? createRootRuntimeResources,
        saveSession: overrides.saveSession ?? ((session, snapshot) => session.saveSnapshot(snapshot)),
        writeOutput: overrides.writeOutput ?? writeHeadlessOutput,
        writeDiagnostic: overrides.writeDiagnostic ?? writeHeadlessDiagnostic,
    };
    const createThread = createSDKThreadFactory({runTurn: createRootTurnRunnerFactory({saveSession: dependencies.saveSession})});
    return async (options: HeadlessOptions, signal?: AbortSignal): Promise<HeadlessRunSummary> => {
        const {configuration, resumeMode} = options;
        if (resumeMode.kind === "picker") throw new Error("Headless mode cannot use interactive -r; use -c or -r <sessionId>");
        const {storage, cwd, settings} = configuration;
        const model = settings.models.primary.model;
        const loaded = resumeMode.kind === "continue" ? loadLatestSession(storage, cwd, model) :
            resumeMode.kind === "session" ? loadSession(storage, cwd, resumeMode.sessionId, model) : null;
        if (resumeMode.kind !== "none" && !loaded) throw new Error("No previous session available to resume");
        const activeSignal = signal ?? createTurnAbortController().signal;
        const resources = await dependencies.createResources({configuration, signal: activeSignal, headless: true});
        let thread: Awaited<ReturnType<typeof createThread>> | undefined;
        try {
            if (resources.sandbox.status.kind === "unavailable") await dependencies.writeDiagnostic(`Sandbox unavailable: ${resources.sandbox.status.reason}`);
            for (const issue of resources.subagents.issues) await dependencies.writeDiagnostic(`Agent configuration: ${formatAgentLoadIssue(issue)}`);
            for (const issue of resources.hooks.issues) await dependencies.writeDiagnostic(`Hook: ${issue.message}`);
            const initial = prepareThreadSession(resources, loaded ?? undefined);
            initial.state.permissionMode = options.permissionMode ?? initial.state.permissionMode;
            initial.state.collaborationMode = options.collaborationMode ?? initial.state.collaborationMode;
            thread = await createThread({...initial, resources, signal: activeSignal, onClose() {},
                host: {onDiagnostic: diagnostic => dependencies.writeDiagnostic(`${diagnostic.scope}: ${diagnostic.message}`)}});
            const stream = await thread.runStreamedWithImagePaths(options.prompt, options.images ?? [], {signal: activeSignal});
            async function* observed(): AsyncGenerator<ThreadEvent> {
                for await (const event of stream.events) {
                    if (options.outputFormat === "text" || (event.type === "item.completed" && event.item.type === "hook")) {
                        const line = formatHeadlessProgress(event);
                        if (line !== null) await dependencies.writeDiagnostic(line);
                    }
                    yield event;
                }
            }
            const summary = buildHeadlessRunSummary(await collectTurnResult(observed()));
            await thread.close();
            await dependencies.writeOutput(summary, options.outputFormat);
            return summary;
        } finally {
            try {await thread?.close();} finally {await resources.close();}
        }
    };
}
export const runHeadless = createHeadlessRunner();
