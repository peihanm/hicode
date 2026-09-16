#!/usr/bin/env bun
import {render} from "ink";
import {InteractiveShutdown, bindInteractiveSignals} from "./cli/interactiveShutdown.js";
import {Root} from "./ui/Root.js";
import {type CliOptions, loadEnv, parseCliArgs, printHelp} from "./cli/index.js";
import {runHeadlessFromCli} from "./headless/cli.js";
import {loadHiCodeSettings, type LoadedHiCodeSettings} from "./settings/index.js";
import {createTerminalCursorOutput} from "./ui/input/terminalCursor.js";
import {TerminalCursorAnchorProvider} from "./ui/input/terminalCursorContext.js";
import {TerminalSizeProvider} from "./ui/terminalSize.js";
import {createHiCodeStorageLayout} from "./persistence/index.js";
import {parse} from "node:path";
import {
    CLI_FILE_SOURCES,
    createHiCodeRootConfiguration,
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

if (cliOptions.storageAction) {
    try {
        const storage=createHiCodeStorageLayout();
        const {inspectStorage,cleanStorage,listStoredProjects}=await import("./runtime/storageMaintenance.js");
        const {repairSessionIndex}=await import("./session/repair.js");
        const result=cliOptions.storageAction==="projects" ? await listStoredProjects(storage)
            : cliOptions.storageAction==="repair-index" ? await repairSessionIndex(storage,process.cwd())
            : cliOptions.storageAction==="clean" ? await cleanStorage(storage,process.cwd())
            : await inspectStorage(storage,process.cwd(),cliOptions.storageAction==="preview");
        process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
    } catch (error) {process.stderr.write(`${error instanceof Error ? error.message : "Storage maintenance failed"}\n`);process.exitCode=1;}
    process.exit(process.exitCode??0);
}

const cwd = process.cwd();
const storage = createHiCodeStorageLayout();
loadEnv(storage, cwd);
let loadedSettings: LoadedHiCodeSettings;
try {
    loadedSettings = loadHiCodeSettings({
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

const configuration = createHiCodeRootConfiguration({
    allowFullAccess: true,
    cwd,
    workspaceBoundary: parse(cwd).root,
    storage,
    settings: loadedSettings.values,
    fileSources: CLI_FILE_SOURCES,
});

if (cliOptions.printPrompt !== undefined) {
    await runHeadlessFromCli({
        configuration,
        prompt: cliOptions.printPrompt,
        images: cliOptions.images,
        permissionMode: cliOptions.permissionMode,
        collaborationMode: cliOptions.collaborationMode,
        resumeMode: cliOptions.resumeMode,
        outputFormat: cliOptions.outputFormat,
    });
} else {
    const shutdown = new InteractiveShutdown();
    let unmount: (() => void) | undefined;
    let exitRequested = false;
    const removeSignals = bindInteractiveSignals(shutdown, () => {
        exitRequested = true;
        unmount?.();
    });
    const stdout = createTerminalCursorOutput(process.stdout);
    const app = render(
        <TerminalSizeProvider>
            <TerminalCursorAnchorProvider enabled>
                <Root
                    shutdown={shutdown}
                    configuration={configuration}
                    initialImages={cliOptions.images}
                    initialPermissionMode={cliOptions.permissionMode}
                    initialCollaborationMode={cliOptions.collaborationMode}
                    resumeMode={cliOptions.resumeMode}
                />
            </TerminalCursorAnchorProvider>
        </TerminalSizeProvider>,
        {patchConsole: false, exitOnCtrlC: false, stdout}
    );
    unmount = app.unmount;
    if (exitRequested) app.unmount();
    try {
        await app.waitUntilExit();
    } finally {
        const timeout = setTimeout(() => {
            process.stderr.write("HiCode shutdown cleanup timed out; terminating the process.\n");
            process.exit(process.exitCode || 1);
        }, 10_000);
        await shutdown.close();
        clearTimeout(timeout);
        removeSignals();
        stdout.disposeCursorOutput();
    }
    // Resource cleanup has completed; unrelated handles must not keep the CLI alive indefinitely.
    const forceExit = setTimeout(() => process.exit(process.exitCode || 0), 1_000);
    forceExit.unref();
}
