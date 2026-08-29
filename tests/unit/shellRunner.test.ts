import {describe, expect, test} from "bun:test";
import type {
    SandboxRuntimeLike,
    SandboxStatus,
} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";

function sandboxRuntime(
    status: SandboxStatus,
    events: string[] = []
): SandboxRuntimeLike {
    return {
        status,
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
                sandboxRuntime({kind: "disabled"}, events)
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

    test("ready 状态包装 argv 并在结束后执行诊断和清理", async () => {
        await withTempProject(async (cwd) => {
            const events: string[] = [];
            const runner = createShellRunner(
                sandboxRuntime({
                    kind: "ready",
                    platform: "macos",
                    warnings: [],
                }, events)
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
                })
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
