import {describe, expect, test} from "bun:test";
import {z} from "zod";
import {adaptPillarHostTools, definePillarTool} from "../../src/sdk/hostTools.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("SDK Host Tools", () => {
    test("typed Host Tool 通过统一 Schema、权限和执行链", async () => {
        await withTempProject(async (cwd) => {
            let executionContext:
                | {cwd: string; threadId: string; toolCallId: string}
                | undefined;
            const hostTool = definePillarTool({
                name: "host_lookup",
                description: "Look up a Host-owned value",
                parameters: z.object({key: z.string().min(1)}),
                readOnly: true,
                concurrencySafe: true,
                execute({key}, context) {
                    executionContext = context;
                    return `value:${key}`;
                },
            });
            const runtime = createToolRuntime({
                additionalTools: adaptPillarHostTools([hostTool]),
            });

            expect(runtime.getToolSchemas()).toContainEqual(
                expect.objectContaining({
                    function: expect.objectContaining({name: "host_lookup"}),
                })
            );
            expect(runtime.isConcurrencySafe(
                "host_lookup",
                JSON.stringify({key: "alpha"})
            )).toBe(true);

            const invalid = await runtime.executeTool(
                "host_lookup",
                JSON.stringify({key: ""}),
                createTestContext(cwd),
                "invalid-call"
            );
            expect(invalid.outcome).toBe("failed");
            expect(invalid.modelContent).toContain("Argument validation failed");

            let permissionCalls = 0;
            const result = await runtime.executeTool(
                "host_lookup",
                JSON.stringify({key: "alpha"}),
                createTestContext(cwd, {
                    permissionMode: "ask",
        collaborationMode: "build",
                    sessionId: "sdk-thread",
                    canUseTool: async () => {
                        permissionCalls += 1;
                        return {behavior: "deny", message: "unexpected"};
                    },
                }),
                "host-call"
            );
            expect(result).toMatchObject({
                outcome: "ok",
                modelContent: "value:alpha",
            });
            expect(permissionCalls).toBe(0);
            expect(executionContext).toMatchObject({
                cwd,
                threadId: "sdk-thread",
                toolCallId: "host-call",
            });
        });
    });

    test("有副作用的 Host Tool 默认确认，取消与非法返回 fail closed", async () => {
        await withTempProject(async (cwd) => {
            let executions = 0;
            const writeTool = definePillarTool({
                name: "host_mutation",
                description: "Perform a Host-owned external mutation",
                parameters: z.object({value: z.string()}),
                readOnly: false,
                execute() {
                    executions += 1;
                    return "mutated";
                },
            });
            const invalidOutput = definePillarTool({
                name: "host_invalid_output",
                description: "Return an invalid value at runtime",
                parameters: z.object({}),
                readOnly: true,
                // @ts-expect-error JavaScript Host 仍可能违反声明，Runtime 必须拦截。
                execute() {
                    return 42;
                },
            });
            const runtime = createToolRuntime({
                additionalTools: adaptPillarHostTools([
                    writeTool,
                    invalidOutput,
                ]),
            });
            let requestedTool = "";
            const denied = await runtime.executeTool(
                "host_mutation",
                JSON.stringify({value: "x"}),
                createTestContext(cwd, {
                    permissionMode: "ask",
        collaborationMode: "build",
                    canUseTool: async (name) => {
                        requestedTool = name;
                        return {behavior: "deny", message: "host denied"};
                    },
                }),
                "denied"
            );
            expect(denied.outcome).toBe("denied");
            expect(requestedTool).toBe("host_mutation");
            expect(executions).toBe(0);

            const controller = new AbortController();
            controller.abort("user_cancelled");
            const interrupted = await runtime.executeTool(
                "host_mutation",
                JSON.stringify({value: "x"}),
                createTestContext(cwd, {signal: controller.signal}),
                "cancelled"
            );
            expect(interrupted.outcome).toBe("interrupted");
            expect(executions).toBe(0);

            const allowedContext = createTestContext(cwd);
            const allowed = await runtime.executeTool(
                "host_mutation",
                JSON.stringify({value: "x"}),
                allowedContext,
                "allowed"
            );
            expect(allowed.outcome).toBe("ok");
            expect(executions).toBe(1);

            const failed = await runtime.executeTool(
                "host_invalid_output",
                "{}",
                createTestContext(cwd),
                "invalid-output"
            );
            expect(failed.outcome).toBe("failed");
            expect(failed.modelContent).toContain("must return a string or result object");
        });
    });

    test("定义在 Root 初始化时严格校验并形成不可变适配快照", async () => {
        const mutable = {
            name: "host_snapshot",
            description: "Snapshot a Host Tool definition",
            parameters: z.object({value: z.string()}),
            readOnly: true,
            execute: ({value}: {value: string}) => `before:${value}`,
        };
        const adapted = adaptPillarHostTools([mutable]);
        mutable.name = "changed";
        mutable.execute = ({value}: {value: string}) => `after:${value}`;
        expect(adapted[0]?.name).toBe("host_snapshot");

        await withTempProject(async (cwd) => {
            const runtime = createToolRuntime({additionalTools: adapted});
            const result = await runtime.executeTool(
                "host_snapshot",
                JSON.stringify({value: "stable"}),
                createTestContext(cwd),
                "snapshot"
            );
            expect(result.modelContent).toBe("before:stable");
        });

        expect(() => adaptPillarHostTools([{
            ...mutable,
            name: "read_file",
        }])).toThrow("Duplicate tool name");
        expect(() => adaptPillarHostTools([{
            ...mutable,
            name: "mcp__forbidden",
        }])).toThrow("mcp__ prefix");
        expect(() => adaptPillarHostTools([{
            ...mutable,
            name: "host_write_parallel",
            readOnly: false,
            concurrencySafe: true,
        }])).toThrow("readOnly=true");
        expect(() => adaptPillarHostTools([{
            ...mutable,
            name: "host_primitive",
            parameters: z.string(),
        }])).toThrow("top-level object JSON Schema");
    });
});
