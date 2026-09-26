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
    test("scoped file commands do not release an ordinary command's backend mount lease", async () => {
        await withTempProject(async cwd => {
            const events: string[] = [];
            const runner = createShellRunner(sandboxRuntime({kind: "ready", networkMode: "open", platform: "linux", warnings: []}, events), testChildEnvironment);
            const request = {command: "printf scoped", cwd, signal: new AbortController().signal};
            expect((await runner.run({...request, fileWorkspace: {root: cwd, writable: true}})).stdout).toBe("scoped");
            expect(events.filter(event => event === "cleanup")).toHaveLength(0);
            await runner.run(request);
            expect(events.filter(event => event === "cleanup")).toHaveLength(1);
        });
    });
    test("已确认的沙箱违规附恢复建议，但不自动重跑或提权", async () => {
        await withTempProject(async cwd => {
            const events: string[] = [];
            const sandbox = sandboxRuntime({kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}, events);
            sandbox.annotateStderr = (_command, stderr) => `${stderr}\n<sandbox_violations>file-write denied</sandbox_violations>`;
            const runner = createShellRunner(sandbox, testChildEnvironment);
            const result = await runner.run({command: "exit 1", cwd, signal: new AbortController().signal});
            expect(result.stderr).toContain("sandbox_permissions=require_escalated");
            expect(result.stderr).toContain("partial effects");
            expect(events.filter(event => event.startsWith("wrap:"))).toHaveLength(1);
            expect(result.termination).toMatchObject({kind: "exit", code: 1});
        });
    });
    test("已授权的宿主执行跳过 Sandbox 包装", async () => {
        await withTempProject(async (cwd) => {
            const events: string[] = [];
            const runner = createShellRunner(
                sandboxRuntime({kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}, events),
                testChildEnvironment
            );
            const result = await runner.run({
                command: "printf disabled",
                sandboxPermissions: "require_escalated",
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
                sandboxRuntime({kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}),
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
                    networkMode: "restricted", platform: "macos",
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

    test("Sandbox 保留进程 EPERM 输出，不据文本添加提权建议", async () => {
        await withTempProject(async (cwd) => {
            const runner = createShellRunner(
                sandboxRuntime({
                    kind: "ready",
                    networkMode: "restricted", platform: "macos",
                    warnings: [],
                }),
                testChildEnvironment
            );
            const result = await runner.run({
                command: "printf 'Error: listen EPERM: operation not permitted 127.0.0.1:8000' >&2; exit 1",
                cwd,
                signal: new AbortController().signal,
            });

            expect(result.stderr).toContain("listen EPERM");
            expect(result.stderr).not.toContain("HiCode Sandbox:");
        });
    });

    test("普通本地连接失败不归因为 Sandbox 拒绝", async () => {
        await withTempProject(async (cwd) => {
            const runner = createShellRunner(
                sandboxRuntime({
                    kind: "ready",
                    networkMode: "restricted", platform: "macos",
                    warnings: [],
                }),
                testChildEnvironment
            );
            const result = await runner.run({
                command: "printf '* Immediate connect fail for 127.0.0.1:8173: Operation not permitted' >&2; exit 7",
                cwd,
                signal: new AbortController().signal,
            });

            expect(result.stderr).toContain("Immediate connect fail");
            expect(result.stderr).not.toContain("HiCode Sandbox:");
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
