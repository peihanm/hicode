import type {EvalAssertion, EvalCase} from "./types.js";
import {runProcess} from "./process.js";

export async function runEvalVerification(
    evalCase: EvalCase,
    workspace: string,
    changedPaths: readonly string[],
    environment: Record<string, string>
): Promise<EvalAssertion[]> {
    const assertions: EvalAssertion[] = [];
    for (const path of evalCase.requiredChangedPaths) {
        assertions.push({
            id: `required-change:${path}`,
            label: `必须修改 ${path}`,
            passed: changedPaths.includes(path),
            expected: path,
            actual: changedPaths.join(", ") || "<none>",
        });
    }
    for (const prefix of evalCase.forbiddenChangedPrefixes) {
        const matches = changedPaths.filter((path) => pathMatches(path, prefix));
        assertions.push({
            id: `forbidden-change:${prefix}`,
            label: `不得修改 ${prefix}`,
            passed: matches.length === 0,
            expected: "<none>",
            actual: matches.join(", ") || "<none>",
        });
    }
    for (const command of evalCase.commands) {
        const process = await runProcess(command.argv, {
            cwd: workspace,
            env: environment,
            timeoutMs: command.timeoutMs ?? 30_000,
        });
        assertions.push({
            id: `command:${command.id}`,
            label: command.label,
            passed:
                process.exitCode === 0 &&
                !process.timedOut &&
                process.spawnError === undefined,
            expected: "exit 0",
            actual: process.spawnError
                ? `spawn error: ${process.spawnError}`
                : process.timedOut
                    ? "timeout"
                    : `exit ${process.exitCode}`,
            process,
        });
    }
    return assertions;
}

function pathMatches(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(
        prefix.endsWith("/") ? prefix : `${prefix}/`
    );
}
