import {createTurnAbortController} from "../runtime/abort.js";
import {runHeadless} from "./host.js";
import {writeHeadlessStdout} from "./io.js";
import {formatHeadlessCliError} from "./output.js";
import type {HeadlessOptions, HeadlessRunSummary} from "./types.js";

type SigintListener = () => void;

export interface HeadlessProcessAdapter {
    onceSigint(listener: SigintListener): void;

    onceSigterm(listener: SigintListener): void;

    removeSigint(listener: SigintListener): void;

    removeSigterm(listener: SigintListener): void;

    setExitCode(code: number): void;

    writeStdout(text: string): Promise<void>;

    writeStderr(text: string): void | Promise<void>;
}

type HeadlessCliRunner = (
    options: HeadlessOptions,
    signal: AbortSignal
) => Promise<HeadlessRunSummary>;

interface HeadlessCliDependencies {
    adapter: HeadlessProcessAdapter;
    runner: HeadlessCliRunner;
}

const processAdapter: HeadlessProcessAdapter = {
    onceSigint(listener) {
        process.once("SIGINT", listener);
    },
    onceSigterm(listener) {
        process.once("SIGTERM", listener);
    },
    removeSigint(listener) {
        process.removeListener("SIGINT", listener);
    },
    removeSigterm(listener) {
        process.removeListener("SIGTERM", listener);
    },
    setExitCode(code) {
        process.exitCode = code;
    },
    writeStdout: writeHeadlessStdout,
    writeStderr(text) {
        console.error(text);
    },
};

export function createHeadlessCli({
                                      adapter,
                                      runner,
                                  }: HeadlessCliDependencies) {
    return async function runHeadlessCli(
        options: HeadlessOptions
    ): Promise<void> {
        const controller = createTurnAbortController();
        const onSigint = () => {
            if (!controller.signal.aborted) controller.abort("sigint");
        };
        const onSigterm = () => {
            if (!controller.signal.aborted) controller.abort("shutdown");
        };
        adapter.onceSigint(onSigint);
        adapter.onceSigterm(onSigterm);
        try {
            const summary = await runner(options, controller.signal);
            adapter.setExitCode(summary.exitCode);
        } catch (error) {
            const formatted = formatHeadlessCliError(error, options.outputFormat);
            if (options.outputFormat === "json") {
                await adapter.writeStdout(formatted);
            } else {
                await adapter.writeStderr(formatted);
            }
            adapter.setExitCode(1);
        } finally {
            adapter.removeSigint(onSigint);
            adapter.removeSigterm(onSigterm);
        }
    };
}

const runCli = createHeadlessCli({
    adapter: processAdapter,
    runner: (options, signal) => runHeadless(options, signal),
});

export async function runHeadlessFromCli(
    options: HeadlessOptions
): Promise<void> {
    await runCli(options);
}
