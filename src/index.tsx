#!/usr/bin/env bun
import {render} from "ink";
import {Root} from "./ui/Root.js";
import {type CliOptions, loadEnv, parseCliArgs, printHelp} from "./cli/index.js";
import {runHeadlessFromCli} from "./headless/cli.js";
import {runCheckpointRewindFromCli} from "./checkpoints/index.js";
import {loadPillarSettings, type LoadedPillarSettings} from "./settings/index.js";
import {createTerminalCursorOutput} from "./ui/input/terminalCursor.js";
import {TerminalCursorAnchorProvider} from "./ui/input/terminalCursorContext.js";
import {TerminalSizeProvider} from "./ui/terminalSize.js";
import {createPillarStorageLayout} from "./persistence/index.js";
import {createChildProcessEnvironment} from "./runtime/childEnvironment.js";
import {parse} from "node:path";
import {
    CLI_FILE_SOURCES,
    createPillarRootConfiguration,
} from "./runtime/rootConfiguration.js";

let cliOptions: CliOptions;
try {
    cliOptions = parseCliArgs(process.argv.slice(2));
} catch (err) {
    console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    printHelp();
    process.exit(1);
}

if (cliOptions.help) {
    printHelp();
    process.exit(0);
}

loadEnv({required: cliOptions.rewindCheckpointId === undefined});

const cwd = process.cwd();
const storage = createPillarStorageLayout();
let loadedSettings: LoadedPillarSettings;
try {
    loadedSettings = loadPillarSettings({
        storage,
        cwd,
        sources: CLI_FILE_SOURCES.settings,
        cliOverrides: {
            model: cliOptions.model,
            source: cliOptions.source,
        },
    });
} catch (error) {
    console.error(
        `\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`
    );
    process.exit(1);
}

for (const issue of loadedSettings.issues) {
    const color = issue.severity === "error" ? "\x1b[31m" : "\x1b[33m";
    console.error(
        `${color}Settings ${issue.severity}: ${issue.source === "host" ? issue.id : issue.path}${issue.field ? ` (${issue.field})` : ""}: ${issue.message}\x1b[0m`
    );
}

const configuration = createPillarRootConfiguration({
    cwd,
    workspaceBoundary: parse(cwd).root,
    storage,
    settings: loadedSettings.values,
    fileSources: CLI_FILE_SOURCES,
});

if (
    cliOptions.rewindCheckpointId &&
    cliOptions.resumeMode.kind === "session"
) {
    const childEnvironment = createChildProcessEnvironment(
        process.env,
        Object.values(loadedSettings.values.sources).map(
            (source) => source.apiKeyEnv
        )
    );
    await runCheckpointRewindFromCli({
        storage,
        cwd,
        model: loadedSettings.values.models.primary.model,
        sessionId: cliOptions.resumeMode.sessionId,
        checkpointId: cliOptions.rewindCheckpointId,
        outputFormat: cliOptions.outputFormat,
        childEnvironment,
    });
} else if (cliOptions.printPrompt !== undefined) {
    await runHeadlessFromCli({
        configuration,
        prompt: cliOptions.printPrompt,
        permissionMode: cliOptions.permissionMode,
        collaborationMode: cliOptions.collaborationMode,
        resumeMode: cliOptions.resumeMode,
        outputFormat: cliOptions.outputFormat,
    });
} else {
    const stdout = createTerminalCursorOutput(process.stdout);
    const app = render(
        <TerminalSizeProvider>
            <TerminalCursorAnchorProvider enabled>
                <Root
                    configuration={configuration}
                    initialPermissionMode={cliOptions.permissionMode}
                    initialCollaborationMode={cliOptions.collaborationMode}
                    resumeMode={cliOptions.resumeMode}
                />
            </TerminalCursorAnchorProvider>
        </TerminalSizeProvider>,
        {patchConsole: false, exitOnCtrlC: false, stdout}
    );
    try {
        await app.waitUntilExit();
    } finally {
        stdout.disposeCursorOutput();
    }
    // 正常卸载会异步收尾；残留 Provider/Hook 句柄不得无限阻塞 Shell。
    const forceExit = setTimeout(() => process.exit(0), 1_000);
    forceExit.unref();
}
