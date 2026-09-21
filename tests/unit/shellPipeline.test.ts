import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {describe, expect, test} from "bun:test";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

describe("Bash pipeline status", () => {
    for (const mode of ["disabled", "sandbox", "elevated"] as const) {
        test(`${mode}: actual Bash retains failures and explicit control flow`, async () => {
            await withTempProject(async (cwd, storage) => {
                let enabled = false;
                const wrappedShells: Array<string | undefined> = [];
                const factory = createSandboxRuntimeFactory({
                    isSupportedPlatform: () => true,
                    isSandboxingEnabled: () => enabled,
                    checkDependencies: () => ({errors: [], warnings: []}),
                    async initialize() { enabled = true; },
                    async wrapWithSandboxArgv(command, shell) {
                        wrappedShells.push(shell);
                        return {argv: [shell!, "--noprofile", "--norc", "-c", command], env: {}};
                    },
                    annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
                    cleanupAfterCommand() {},
                    async reset() { enabled = false; },
                });
                const sandbox = mode === "disabled" ? createDisabledSandboxRuntime() : await factory({cwd, storage,
                    settings: {filesystem: {denyRead: [], denyWrite: []},
                        network: {mode: "restricted", allowedDomains: [], allowLocalBinding: false}}});
                const runner = createShellRunner(sandbox, testChildEnvironment);
                try {
                    for (const [command, code] of [
                        ["(printf failed; exit 7) | tail -n 20", 7],
                        ["(printf failed; exit 7) | tee log.txt", 7],
                        ["(exit 7) | cat | cat", 7],
                        ["false | cat || printf expected", 0],
                        ["true && printf ok", 0],
                        ["false; printf no-errexit", 0],
                        ["yes | head -n 1", 141],
                        ['yes | head -n 1; status=("${PIPESTATUS[@]}"); test "${status[0]}" -eq 141 && test "${status[1]}" -eq 0', 0],
                    ] as const) {
                        const result = await runner.run({command, cwd, signal: new AbortController().signal,
                            sandboxPermissions: mode === "elevated" ? "require_escalated" : "use_default"});
                        expect(result.termination).toMatchObject({kind: "exit", code});
                    }
                    expect(wrappedShells.length).toBe(mode === "sandbox" ? 8 : 0);
                    if (mode === "sandbox") expect(wrappedShells.every(shell => shell === "/bin/bash")).toBe(true);
                } finally { await sandbox.close(); }
            });
        });
    }
});
