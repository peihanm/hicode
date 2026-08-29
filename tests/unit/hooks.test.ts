import {describe, expect, test} from "bun:test";
import {z} from "zod";
import {join} from "node:path";
import {
    HookWorkspaceNotTrustedError,
    createHookSessionRuntime,
    createHookRuntimeFactory,
    getHookTrust,
    hooksSettingsFileSchema,
    matchesHookMatcher,
    saveHookTrust,
    type HookInput,
    type HookRuntime,
    type ResolvedHookSettings,
} from "../../src/hooks/index.js";
import {createEmptyResolvedHookSettings} from "../helpers/hooks.js";
import {matchesToolPermissionRule} from "../../src/permissions/index.js";
import {bashTool} from "../../src/tools/bash/bash.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import type {Tool} from "../../src/tools/types.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

function settingsWith(
    event: keyof ResolvedHookSettings,
    hooks: Array<{
        command: string;
        if?: string;
        shell?: "bash" | "powershell";
        once?: boolean;
        timeoutMs?: number;
    }>,
    matcher?: string
): ResolvedHookSettings {
    const settings = createEmptyResolvedHookSettings();
    return {
        ...settings,
        [event]: [{
            ...(matcher ? {matcher} : {}),
            hooks: hooks.map((hook) => ({type: "command" as const, ...hook})),
            source: "project" as const,
            path: "/project/.pillar/settings.json",
        }],
    };
}

function promptSettingsWith(
    event: keyof ResolvedHookSettings,
    hooks: Array<{
        prompt: string;
        if?: string;
        once?: boolean;
        timeoutMs?: number;
    }>,
    matcher?: string
): ResolvedHookSettings {
    const settings = createEmptyResolvedHookSettings();
    return {
        ...settings,
        [event]: [{
            ...(matcher ? {matcher} : {}),
            hooks: hooks.map((hook) => ({type: "prompt" as const, ...hook})),
            source: "project" as const,
            path: "/project/.pillar/settings.json",
        }],
    };
}

describe("Hooks", () => {
    test("matcher 支持精确名称、星号、管道枚举和正则", () => {
        expect(matchesHookMatcher("read_file", "read_file|grep")).toBe(true);
        expect(matchesHookMatcher("bash", "read_file|grep")).toBe(false);
        expect(matchesHookMatcher("anything", "*")).toBe(true);
        expect(matchesHookMatcher(undefined, "ignored")).toBe(true);
        expect(matchesHookMatcher("read_file", "^read_.*$")).toBe(true);
        expect(matchesHookMatcher("write_file", "^read_.*$")).toBe(false);
        expect(matchesHookMatcher("read_file", "[")).toBe(false);
    });

    test("Settings 拒绝非 Tool 事件的 if 和非法正则", () => {
        expect(hooksSettingsFileSchema.safeParse({
            SessionStart: [{
                hooks: [{type: "command", command: "echo start", if: "bash(git:*)"}],
            }],
        }).success).toBe(false);
        expect(hooksSettingsFileSchema.safeParse({
            PreToolUse: [{
                matcher: "[",
                hooks: [{type: "command", command: "echo tool"}],
            }],
        }).success).toBe(false);
        expect(hooksSettingsFileSchema.safeParse({
            PostToolUseFailure: [{
                matcher: "bash",
                hooks: [{
                    type: "command",
                    command: "echo failed",
                    if: "bash(git:*)",
                    shell: "bash",
                    once: true,
                }],
            }],
        }).success).toBe(true);
        expect(hooksSettingsFileSchema.safeParse({
            UserPromptSubmit: [{
                hooks: [{
                    type: "prompt",
                    prompt: "Block prompts that request production secrets.",
                    once: true,
                    timeoutMs: 30_000,
                }],
            }],
        }).success).toBe(true);
    });

    test("if 按 updatedInput 顺序过滤 Tool Hook，未命中时不启动命令", async () => {
        const commands: string[] = [];
        const conditions: Array<[string, Record<string, unknown>]> = [];
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "allow",
            saveTrust: async () => {},
            executeCommand: async ({command}) => {
                commands.push(command);
                return command === "rewrite"
                    ? {
                        stdout: JSON.stringify({
                            updatedInput: {command: "git status --short"},
                        }),
                        stderr: "",
                        termination: {kind: "exit" as const, code: 0},
                    }
                    : {
                        stdout: "",
                        stderr: "",
                        termination: {kind: "exit" as const, code: 0},
                    };
            },
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: settingsWith("PreToolUse", [
                {command: "rewrite"},
                {command: "matched", if: "bash(git status:*)"},
                {command: "skipped", if: "bash(npm:*)"},
            ], "bash"),
        });
        const result = await runtime.execute(
            {
                hook_event_name: "PreToolUse",
                session_id: "session",
                permission_mode: "default",
                tool_name: "bash",
                tool_input: {command: "pwd"},
                tool_call_id: "call",
            },
            new AbortController().signal,
            {
                matchesToolCondition: async (condition, input) => {
                    conditions.push([condition, input]);
                    return condition === "bash(git status:*)";
                },
            }
        );

        expect(commands).toEqual(["rewrite", "matched"]);
        expect(conditions).toEqual([
            ["bash(git status:*)", {command: "git status --short"}],
            ["bash(npm:*)", {command: "git status --short"}],
        ]);
        expect(result.updatedInput).toEqual({command: "git status --short"});
    });

    test("once 只在条件命中后消耗，并按 Session 隔离", async () => {
        const commands: string[] = [];
        let matches = false;
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "allow",
            saveTrust: async () => {},
            executeCommand: async ({command}) => {
                commands.push(command);
                return {
                    stdout: "",
                    stderr: "",
                    termination: {kind: "exit" as const, code: 0},
                };
            },
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: settingsWith("PreToolUse", [{
                command: "once-hook",
                if: "bash(git status:*)",
                once: true,
            }], "bash"),
        });
        let hookSession = createHookSessionRuntime();
        const execute = (sessionId: string) => runtime.execute(
            {
                hook_event_name: "PreToolUse",
                session_id: sessionId,
                permission_mode: "default",
                tool_name: "bash",
                tool_input: {command: "git status --short"},
                tool_call_id: "call",
            },
            new AbortController().signal,
            {
                matchesToolCondition: async () => matches,
                session: hookSession,
            }
        );

        await execute("session-a");
        matches = true;
        await execute("session-a");
        await execute("session-a");
        hookSession = createHookSessionRuntime();
        await execute("session-b");
        hookSession = createHookSessionRuntime();
        await Promise.all([execute("session-c"), execute("session-c")]);

        expect(commands).toEqual(["once-hook", "once-hook", "once-hook"]);
    });

    test("显式 shell 进入命令执行边界并展示在信任信息中", async () => {
        const shells: Array<string | undefined> = [];
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "pending",
            saveTrust: async () => {},
            executeCommand: async ({shell}) => {
                shells.push(shell);
                return {
                    stdout: "",
                    stderr: "",
                    termination: {kind: "exit" as const, code: 0},
                };
            },
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: settingsWith("SessionStart", [{
                command: "echo start",
                shell: "bash",
                once: true,
            }]),
            requestTrust: async ({hooks}) => {
                expect(hooks[0]).toMatchObject({shell: "bash", once: true});
                return "once";
            },
        });
        expect(runtime.mayRunCommands).toBe(true);
        await runtime.execute({
            hook_event_name: "SessionStart",
            session_id: "session",
            source: "startup",
            model: "model",
        }, new AbortController().signal, {
            session: createHookSessionRuntime(),
        });

        expect(shells).toEqual(["bash"]);
    });

    test("PreToolUse 顺序传递 updatedInput，并收集有界上下文和阻止原因", async () => {
        const seenInputs: Array<Record<string, unknown>> = [];
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "allow",
            saveTrust: async () => {},
            executeCommand: async ({command, stdin}) => {
                const input = JSON.parse(stdin) as HookInput;
                if (input.hook_event_name === "PreToolUse") {
                    seenInputs.push(input.tool_input);
                }
                return command === "first"
                    ? {
                        stdout: JSON.stringify({
                            updatedInput: {path: "after.ts"},
                            additionalContext: "first context",
                        }),
                        stderr: "",
                        termination: {kind: "exit" as const, code: 0},
                    }
                    : {
                        stdout: JSON.stringify({
                            decision: "block",
                            reason: "policy blocked",
                        }),
                        stderr: "",
                        termination: {kind: "exit" as const, code: 0},
                    };
            },
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: settingsWith(
                "PreToolUse",
                [{command: "first"}, {command: "second"}],
                "read_file"
            ),
        });
        const result = await runtime.execute({
            hook_event_name: "PreToolUse",
            session_id: "session",
            permission_mode: "default",
            tool_name: "read_file",
            tool_input: {path: "before.ts"},
            tool_call_id: "call",
        }, new AbortController().signal);

        expect(seenInputs).toEqual([
            {path: "before.ts"},
            {path: "after.ts"},
        ]);
        expect(result.updatedInput).toEqual({path: "after.ts"});
        expect(result.additionalContexts).toEqual(["first context"]);
        expect(result.blocked).toBe(true);
        expect(result.blockReason).toBe("policy blocked");
    });

    test("Prompt Hook 复用统一调度语义，并接收前序 Hook 更新后的输入", async () => {
        const seenInputs: HookInput[] = [];
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "allow",
            saveTrust: async () => {},
            executeCommand: async () => ({
                stdout: "",
                stderr: "",
                termination: {kind: "exit" as const, code: 0},
            }),
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: promptSettingsWith("PreToolUse", [{
                prompt: "Reject generated files",
            }], "edit_file"),
            promptExecutor: {
                async execute({event}) {
                    seenInputs.push(event);
                    return {
                        decision: "block",
                        reason: "generated file",
                        additionalContext: "Use the generator instead.",
                    };
                },
            },
        });
        expect(runtime.mayRunCommands).toBe(false);
        const result = await runtime.execute({
            hook_event_name: "PreToolUse",
            session_id: "session",
            permission_mode: "default",
            tool_name: "edit_file",
            tool_input: {path: "generated.ts"},
            tool_call_id: "call",
        }, new AbortController().signal);

        expect(seenInputs).toEqual([{
            hook_event_name: "PreToolUse",
            session_id: "session",
            permission_mode: "default",
            tool_name: "edit_file",
            tool_input: {path: "generated.ts"},
            tool_call_id: "call",
        }]);
        expect(result.blocked).toBe(true);
        expect(result.blockReason).toBe("generated file");
        expect(result.additionalContexts).toEqual(["Use the generator instead."]);
        expect(result.executions[0]).toMatchObject({
            type: "prompt",
            outcome: "blocking",
        });
    });

    test("Prompt Hook 缺少 Executor 时产生错误诊断，不伪造决定", async () => {
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "allow",
            saveTrust: async () => {},
            executeCommand: async () => {
                throw new Error("command executor should not run");
            },
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: promptSettingsWith("UserPromptSubmit", [{
                prompt: "Review the prompt",
            }]),
        });
        const result = await runtime.execute({
            hook_event_name: "UserPromptSubmit",
            session_id: "session",
            permission_mode: "default",
            prompt: "hello",
        }, new AbortController().signal);

        expect(result.blocked).toBe(false);
        expect(result.executions[0]).toMatchObject({
            type: "prompt",
            outcome: "error",
            message: "Prompt Hook Executor 未配置",
        });
    });

    test("格式错误和普通非零退出只记录错误，exit 2 仅能阻止前置事件", async () => {
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/project",
            getTrust: async () => "allow",
            saveTrust: async () => {},
            executeCommand: async ({command}) => command === "bad-json"
                ? {
                    stdout: "not-json",
                    stderr: "",
                    termination: {kind: "exit" as const, code: 0},
                }
                : {
                    stdout: "",
                    stderr: "should not block post",
                    termination: {kind: "exit" as const, code: 2},
                },
        });
        const runtime = await createRuntime({
            cwd: "/project",
            hooks: settingsWith("PostToolUse", [
                {command: "bad-json"},
                {command: "exit-two"},
            ]),
        });
        const result = await runtime.execute({
            hook_event_name: "PostToolUse",
            session_id: "session",
            permission_mode: "default",
            tool_name: "read_file",
            tool_input: {path: "a"},
            tool_call_id: "call",
            tool_response: {outcome: "ok", content: "ok"},
        }, new AbortController().signal);

        expect(result.blocked).toBe(false);
        expect(result.executions.map((item) => item.outcome)).toEqual([
            "error",
            "error",
        ]);
    });

    test("有 Hook 的 headless 工作区必须预先信任，交互选择 always 会持久化", async () => {
        const saved: Array<[string, "always" | "deny"]> = [];
        const createRuntime = createHookRuntimeFactory({
            canonicalProjectPath: async () => "/canonical/project",
            getTrust: async () => "pending",
            saveTrust: async (projectPath, decision) => {
                saved.push([projectPath, decision]);
            },
            executeCommand: async () => ({
                stdout: "",
                stderr: "",
                termination: {kind: "exit" as const, code: 0},
            }),
        });
        const hooks = settingsWith("SessionStart", [{command: "echo start"}]);

        await expect(createRuntime({cwd: "/project", hooks, headless: true}))
            .rejects.toBeInstanceOf(HookWorkspaceNotTrustedError);
        const runtime = await createRuntime({
            cwd: "/project",
            hooks,
            requestTrust: async (request) => {
                expect(request.projectPath).toBe("/canonical/project");
                expect(request.hooks[0]?.command).toBe("echo start");
                return "always";
            },
        });
        expect(runtime.enabled).toBe(true);
        expect(saved).toEqual([["/canonical/project", "always"]]);
    });

    test("真实 command 通过 stdin 接收事件 JSON，并获得项目目录环境变量", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createHookRuntimeFactory({
                canonicalProjectPath: async () => cwd,
                getTrust: async () => "allow",
                saveTrust: async () => {},
            });
            const command = [
                "node -e",
                '"let s=\'\';process.stdin.on(\'data\',c=>s+=c);',
                "process.stdin.on('end',()=>{const x=JSON.parse(s);",
                "process.stdout.write(JSON.stringify({additionalContext:x.prompt+'@'+process.env.PILLAR_PROJECT_DIR}))})\"",
            ].join(" ");
            const runtime = await createRuntime({
                cwd,
                hooks: settingsWith("UserPromptSubmit", [{
                    command,
                    shell: "bash",
                }]),
            });
            const result = await runtime.execute({
                hook_event_name: "UserPromptSubmit",
                session_id: "session",
                permission_mode: "default",
                prompt: "hello",
            }, new AbortController().signal);

            expect(result.executions[0]?.outcome).toBe("success");
            expect(result.additionalContexts).toEqual([`hello@${cwd}`]);
        });
    });

    test("workspace trust 使用锁内原子更新并可覆盖旧决定", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "state", "trusted-projects.json");
            await Promise.all([
                saveHookTrust(path, "/project-a", "always"),
                saveHookTrust(path, "/project-b", "always"),
            ]);
            expect(await getHookTrust(path, "/project-a")).toBe("allow");
            expect(await getHookTrust(path, "/project-b")).toBe("allow");
            await saveHookTrust(path, "/project-a", "deny");
            expect(await getHookTrust(path, "/project-a")).toBe("deny");
            expect(await getHookTrust(path, "/missing")).toBe("pending");
        });
    });
});

describe("Hook tool boundary", () => {
    test("if 复用工具真实权限 matcher 而不自建 Bash 规则", async () => {
        const input = {command: "git status --short"};
        expect(await matchesToolPermissionRule(
            bashTool,
            input,
            "bash(git status:*)"
        )).toBe(true);
        expect(await matchesToolPermissionRule(
            bashTool,
            input,
            "bash(npm:*)"
        )).toBe(false);
        expect(await matchesToolPermissionRule(
            bashTool,
            input,
            "read_file"
        )).toBe(false);
    });

    test("PreToolUse 修改后的参数重新校验并重新执行完整权限裁决", async () => {
        await withTempProject(async (cwd) => {
            let askedInput: unknown;
            const hooks: HookRuntime = {
                enabled: true,
                mayRunCommands: false,
                issues: [],
                async execute(input) {
                    return input.hook_event_name === "PreToolUse"
                        ? {
                            blocked: false,
                            updatedInput: {
                                command: "printf unsafe > hook-output.txt",
                            },
                            additionalContexts: [],
                            executions: [],
                        }
                        : {
                            blocked: false,
                            additionalContexts: [],
                            executions: [],
                        };
                },
            };
            const runtime = createToolRuntime({hooks});
            const result = await runtime.executeTool(
                "bash",
                JSON.stringify({command: "pwd"}),
                createTestContext(cwd, {
                    permissionMode: "default",
                    canUseTool: async (_name, _message, input) => {
                        askedInput = input;
                        return {behavior: "deny", message: "fixture deny"};
                    },
                }),
                "call"
            );

            expect(askedInput).toEqual({
                command: "printf unsafe > hook-output.txt",
            });
            expect(result.outcome).toBe("denied");
        });
    });

    test("Hook 参数修改无效时不进入权限，Post 按工具结果分流", async () => {
        await withTempProject(async (cwd) => {
            let permissionCalls = 0;
            const invalidHooks: HookRuntime = {
                enabled: true,
                mayRunCommands: false,
                issues: [],
                async execute() {
                    return {
                        blocked: false,
                        updatedInput: {command: 42},
                        additionalContexts: [],
                        executions: [],
                    };
                },
            };
            const invalid = await createToolRuntime({hooks: invalidHooks})
                .executeTool(
                    "bash",
                    JSON.stringify({command: "pwd"}),
                    createTestContext(cwd, {
                        permissionMode: "default",
                        canUseTool: async () => {
                            permissionCalls += 1;
                            return {behavior: "allow"};
                        },
                    }),
                    "invalid"
                );
            expect(invalid.outcome).toBe("failed");
            expect(invalid.modelContent).toContain("修改后的参数校验失败");
            expect(permissionCalls).toBe(0);

            const events: string[] = [];
            const failures: Array<{outcome: string; content: string}> = [];
            const lifecycleHooks: HookRuntime = {
                enabled: true,
                mayRunCommands: false,
                issues: [],
                async execute(input) {
                    events.push(input.hook_event_name);
                    if (input.hook_event_name === "PostToolUseFailure") {
                        failures.push(input.tool_response);
                    }
                    return {
                        blocked: false,
                        additionalContexts: [`${input.hook_event_name} context`],
                        executions: [],
                    };
                },
            };
            const schema = z.object({
                fail: z.boolean().optional(),
                throws: z.boolean().optional(),
                write: z.boolean().optional(),
            });
            const fixture: Tool<typeof schema> = {
                name: "hook_fixture",
                description: "hook fixture",
                parameters: schema,
                isReadOnly: ({write}) => !write,
                execute: async ({fail, throws}) => {
                    if (throws) throw new Error("fixture exploded");
                    return fail
                        ? {content: "failed", outcome: "failed"}
                        : "success";
                },
            };
            const runtime = createToolRuntime({
                hooks: lifecycleHooks,
                additionalTools: [fixture],
            });
            const ok = await runtime.executeTool(
                "hook_fixture",
                "{}",
                createTestContext(cwd, {permissionMode: "default"}),
                "ok"
            );
            expect(events).toEqual(["PreToolUse", "PostToolUse"]);
            expect(ok.modelContent).toContain("PreToolUse context");
            expect(ok.modelContent).toContain("PostToolUse context");

            events.length = 0;
            await runtime.executeTool(
                "hook_fixture",
                JSON.stringify({fail: true}),
                createTestContext(cwd, {permissionMode: "default"}),
                "failed"
            );
            expect(events).toEqual(["PreToolUse", "PostToolUseFailure"]);
            expect(failures).toEqual([{
                outcome: "failed",
                content: "failed",
            }]);

            events.length = 0;
            failures.length = 0;
            await runtime.executeTool(
                "hook_fixture",
                JSON.stringify({throws: true}),
                createTestContext(cwd, {permissionMode: "default"}),
                "throws"
            );
            expect(events).toEqual(["PreToolUse", "PostToolUseFailure"]);
            expect(failures[0]).toEqual({
                outcome: "failed",
                content: "工具执行出错: fixture exploded",
            });

            events.length = 0;
            failures.length = 0;
            const denied = await runtime.executeTool(
                "hook_fixture",
                JSON.stringify({write: true}),
                createTestContext(cwd, {permissionMode: "dontAsk"}),
                "denied"
            );
            expect(denied.outcome).toBe("denied");
            expect(events).toEqual(["PreToolUse"]);
            expect(failures).toEqual([]);
        });
    });
});
