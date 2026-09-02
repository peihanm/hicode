import {describe, expect, test} from "bun:test";
import type {
    SandboxRuntimeLike,
    SandboxStatus,
} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";

function sandboxRuntime(
    status: SandboxStatus,
    events: string[] = [],
    networkAllowedDomains?: readonly string[]
): SandboxRuntimeLike {
    return {
        status,
        networkAllowedDomains,
        async wrapCommand(command) {
            events.push(`wrap:${command}`);
            return {
                argv: ["/bin/sh", "-c", command],
                env: process.env,
            };
        },
        annotateStderr(_command, stderr) {
            events.push("annotate");
            return stderr;
        },
        cleanupAfterCommand() {
            events.push("cleanup");
        },
        async close() {
            events.push("close");
        },
    };
}

describe("ShellRunner", () => {
    test("disabled 状态保持现有裸 Shell 行为", async () => {
        await withTempProject(async (cwd) => {
            const events: string[] = [];
            const runner = createShellRunner(
                sandboxRuntime({kind: "disabled"}, events),
                testChildEnvironment
            );
            const result = await runner.run({
                command: "printf disabled",
                cwd,
                signal: new AbortController().signal,
            });
            expect(result.stdout).toBe("disabled");
            expect(result.termination).toMatchObject({kind: "exit", code: 0});
            expect(events).toEqual([]);
        });
    });

    test("项目命令无法继承或重新注入模型凭证", async () => {
        await withTempProject(async (cwd) => {
            const childEnvironment = createChildProcessEnvironment({
                ...process.env,
                VISIBLE_VALUE: "visible",
                CUSTOM_MODEL_CREDENTIAL: "configured-secret",
                SESSION_TOKEN: "token-secret",
            }, ["CUSTOM_MODEL_CREDENTIAL"]);
            const runner = createShellRunner(
                sandboxRuntime({kind: "disabled"}),
                childEnvironment
            );
            const result = await runner.run({
                command: "printf '%s|%s|%s' \"$VISIBLE_VALUE\" \"$CUSTOM_MODEL_CREDENTIAL\" \"$SESSION_TOKEN\"",
                cwd,
                signal: new AbortController().signal,
                env: {
                    CUSTOM_MODEL_CREDENTIAL: "reinjected",
                    SESSION_TOKEN: "reinjected",
                },
            });

            expect(result.stdout).toBe("visible||");
            expect(result.termination).toMatchObject({kind: "exit", code: 0});
        });
    });

    test("ready 状态包装 argv 并在结束后执行诊断和清理", async () => {
        await withTempProject(async (cwd) => {
            const events: string[] = [];
            const runner = createShellRunner(
                sandboxRuntime({
                    kind: "ready",
                    platform: "macos",
                    warnings: [],
                }, events),
                testChildEnvironment
            );
            const result = await runner.run({
                command: "printf sandboxed",
                cwd,
                signal: new AbortController().signal,
            });
            expect(result.stdout).toBe("sandboxed");
            expect(events).toEqual([
                "wrap:printf sandboxed",
                "annotate",
                "cleanup",
            ]);
        });
    });

    test("unavailable 状态 fail closed，显式 elevated 才能执行", async () => {
        await withTempProject(async (cwd) => {
            const runner = createShellRunner(
                sandboxRuntime({
                    kind: "unavailable",
                    reason: "socket denied",
                    warnings: [],
                }),
                testChildEnvironment
            );
            const blocked = await runner.run({
                command: "printf blocked",
                cwd,
                signal: new AbortController().signal,
            });
            expect(blocked.termination.kind).toBe("spawn_error");
            expect(
                blocked.termination.kind === "spawn_error"
                    ? blocked.termination.error.message
                    : ""
            ).toContain("socket denied");

            const elevated = await runner.run({
                command: "printf elevated",
                cwd,
                signal: new AbortController().signal,
                sandboxPermissions: "require_escalated",
            });
            expect(elevated.stdout).toBe("elevated");
            expect(elevated.termination).toMatchObject({kind: "exit", code: 0});
        });
    });
});
