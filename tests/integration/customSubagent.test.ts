import {describe, expect, test} from "bun:test";
import {
    createSubagentRegistry,
    type AgentDefinition,
} from "../../src/subagents/index.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createSubagentRunnerForTest} from "../helpers/subagent.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createAgentTool} from "../../src/tools/agent/agent.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {runAgentForTest} from "../helpers/agent.js";
import type {Message} from "../../src/llm/types.js";
import {z} from "zod";
import type {Tool} from "../../src/tools/types.js";
import type {McpManagerLike} from "../../src/mcp/types.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";

function customDefinition(
    overrides: Partial<Pick<AgentDefinition,
        | "agentType"
        | "whenToUse"
        | "systemPrompt"
        | "allowedTools"
        | "model"
        | "maxIterations"
    >> = {}
): AgentDefinition {
    return {
        agentType: "project-reviewer",
        whenToUse: "检查当前项目并返回结论",
        systemPrompt: "你是项目审查 Agent。",
        allowedTools: ["read_file"],
        model: "inherit",
        maxIterations: 6,
        source: "project",
        path: "/fixture/.pillar/agents/project-reviewer.md",
        ...overrides,
    };
}

describe("custom subagent runtime", () => {
    test("主 Agent 通过动态 Agent Tool 调用自定义 child 并收到报告", async () => {
        await withTempProject(async (cwd) => {
            await Bun.write(`${cwd}/target.ts`, "export const answer = 42;\n");
            const registry = createSubagentRegistry({
                definitions: [customDefinition()],
                issues: [],
            });
            const child = createFakeLLM([
                assistantToolCall(
                    "read_file",
                    {path: "target.ts"},
                    "custom-read"
                ),
                (options) => {
                    const read = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "custom-read"
                    );
                    expect(read?.content).toContain("answer = 42");
                    return assistantText("target.ts 导出 answer，值为 42。");
                },
            ]);
            const parent = createFakeLLM([
                (options) => {
                    const agent = options.tools.find((tool) =>
                        tool.function.name === "agent"
                    );
                    expect(agent?.function.description)
                        .toContain("project-reviewer");
                    return assistantToolCall("agent", {
                        subagent_type: "project-reviewer",
                        description: "调查 target",
                        prompt: "读取 target.ts 并报告导出值",
                    }, "parent-custom-agent");
                },
                (options) => {
                    const report = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "parent-custom-agent"
                    );
                    expect(report?.content).toContain("answer，值为 42");
                    return assistantText("自定义 Agent 调查完成");
                },
            ]);
            const ctx = createTestContext(cwd);
            attachSubagentLauncher(ctx, createSubagentRunnerForTest({
                parentContext: ctx,
                onEvent: () => {},
                registry,
                agentOptions: {callLLM: child.callLLM},
                toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
            }));
            const toolRuntime = createToolRuntime({
                toolOverrides: [createAgentTool(registry)],
            });
            const history: Message[] = [{role: "system", content: "root"}];

            const result = await runAgentForTest(
                "调查 target.ts",
                history,
                () => {},
                ctx,
                {
                    callLLM: parent.callLLM,
                    getToolSchemas: toolRuntime.getToolSchemas,
                    executeTool: toolRuntime.executeTool,
                    isToolConcurrencySafe: toolRuntime.isConcurrencySafe,
                }
            );

            expect(result.reply).toBe("自定义 Agent 调查完成");
            expect(child.calls).toHaveLength(2);
        });
    });

    test("使用定义中的 fast 模型和精确工具集，并在 default 模式拒绝嵌套写入确认", async () => {
        await withTempProject(async (cwd) => {
            let confirmations = 0;
            const registry = createSubagentRegistry({
                definitions: [customDefinition({
                    allowedTools: ["read_file", "write_file"],
                    model: "fast",
                })],
                issues: [],
            });
            const child = createFakeLLM([
                (options) => {
                    expect(options.model).toBe("glm-fast-test");
                    expect(options.tools.map((tool) => tool.function.name)).toEqual([
                        "read_file",
                        "write_file",
                    ]);
                    expect(options.messages.some((message) =>
                        typeof message.content === "string" &&
                        message.content.includes("必须遵守项目规则")
                    )).toBe(true);
                    return assistantToolCall(
                        "write_file",
                        {path: "blocked.txt", content: "should not exist"},
                        "blocked-write"
                    );
                },
                (options) => {
                    const denied = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "blocked-write"
                    );
                    expect(denied?.content).toContain("This Agent only allows read-only tool calls");
                    return assistantText("写入被安全拒绝，审查结束。");
                },
            ]);
            const ctx = createTestContext(cwd, {
                permissionMode: "ask",
        collaborationMode: "build",
                canUseTool: async () => {
                    confirmations += 1;
                    return {behavior: "allow"};
                },
                instructions: {
                    files: [{
                        path: `${cwd}/PILLAR.md`,
                        scope: "project",
                        content: "必须遵守项目规则",
                        truncated: false,
                    }],
                    issues: [],
                },
            });
            const runner = createSubagentRunnerForTest({
                parentContext: ctx,
                onEvent: () => {},
                registry,
                agentOptions: {callLLM: child.callLLM},
                toolResultStoreOptions: {pillarHome: `${cwd}/tool-results`},
            });

            const result = await runner({
                kind: "registered",
                agentType: "PROJECT-REVIEWER",
                description: "检查自定义权限",
                prompt: "尝试写入并说明结果",
                parentToolCallId: "custom-default",
            });

            expect(result.agentType).toBe("project-reviewer");
            expect(result.reply).toContain("安全拒绝");
            expect(confirmations).toBe(0);
            expect(await Bun.file(`${cwd}/blocked.txt`).exists()).toBe(false);
        });
    });

    test("直接 Custom child 收窄 Default，且父 allow 不能绕过非交互边界", async () => {
        await withTempProject(async (cwd) => {
            const registry = createSubagentRegistry({
                definitions: [customDefinition({
                    agentType: "writer",
                    allowedTools: ["write_file"],
                })],
                issues: [],
            });
            const defaultLLM = createFakeLLM([
                assistantToolCall(
                    "write_file",
                    {path: "allowed.txt", content: "written by child"},
                    "allowed-write"
                ),
                (options) => {
                    const result = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "allowed-write"
                    );
                    expect(result?.content).toContain("This Agent only allows read-only tool calls");
                    return assistantText("写入被拒绝");
                },
            ]);
            const accepted = createSubagentRunnerForTest({
                parentContext: createTestContext(cwd, {
                    permissionMode: "ask",
        collaborationMode: "build",
                }),
                onEvent: () => {},
                registry,
                agentOptions: {callLLM: defaultLLM.callLLM},
                toolResultStoreOptions: {pillarHome: `${cwd}/accepted-results`},
            });
            await accepted({
                kind: "registered",
                agentType: "writer",
                description: "写入 cwd",
                prompt: "创建 allowed.txt",
                parentToolCallId: "custom-accept",
            });
            expect(await Bun.file(`${cwd}/allowed.txt`).exists()).toBe(false);

            const planLLM = createFakeLLM([
                assistantToolCall(
                    "write_file",
                    {path: "plan-blocked.txt", content: "blocked"},
                    "plan-write"
                ),
                (options) => {
                    const result = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "plan-write"
                    );
                    expect(result?.content).toContain("This Agent only allows read-only tool calls");
                    return assistantText("plan 写入未执行");
                },
            ]);
            const planContext = createTestContext(cwd, {
                permissionMode: "ask",
                collaborationMode: "plan",
            });
            planContext.permissionRules.allow.push({
                toolName: "write_file",
                source: "project",
            });
            const planned = createSubagentRunnerForTest({
                parentContext: planContext,
                onEvent: () => {},
                registry,
                agentOptions: {callLLM: planLLM.callLLM},
                toolResultStoreOptions: {pillarHome: `${cwd}/plan-results`},
            });
            await planned({
                kind: "registered",
                agentType: "writer",
                description: "plan 隔离",
                prompt: "尝试创建 plan-blocked.txt",
                parentToolCallId: "custom-plan",
            });
            expect(await Bun.file(`${cwd}/plan-blocked.txt`).exists()).toBe(false);
        });
    });

    test("deny 规则在 bypassPermissions 下仍然优先", async () => {
        await withTempProject(async (cwd) => {
            const registry = createSubagentRegistry({
                definitions: [customDefinition({
                    agentType: "writer",
                    allowedTools: ["write_file"],
                })],
                issues: [],
            });
            const child = createFakeLLM([
                assistantToolCall(
                    "write_file",
                    {path: "denied.txt", content: "blocked"},
                    "denied-write"
                ),
                (options) => {
                    const result = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "denied-write"
                    );
                    expect(result?.content).toContain("Denied by rule");
                    return assistantText("deny 生效");
                },
            ]);
            const ctx = createTestContext(cwd, {
                permissionMode: "full-access",
        collaborationMode: "build",
            });
            ctx.permissionRules.deny.push({
                toolName: "write_file",
                source: "project",
            });
            const runner = createSubagentRunnerForTest({
                parentContext: ctx,
                onEvent: () => {},
                registry,
                agentOptions: {callLLM: child.callLLM},
                toolResultStoreOptions: {pillarHome: `${cwd}/deny-results`},
            });
            await runner({
                kind: "registered",
                agentType: "writer",
                description: "deny 优先",
                prompt: "尝试写入",
                parentToolCallId: "custom-deny",
            });
            expect(await Bun.file(`${cwd}/denied.txt`).exists()).toBe(false);
        });
    });

    test("白名单 MCP 读工具可执行，写工具仍经过权限裁决", async () => {
        await withTempProject(async (cwd) => {
            const parameters = z.object({value: z.string()});
            const readTool: Tool<typeof parameters> = {
                name: "mcp__fixture__lookup",
                description: "lookup",
                parameters,
                isReadOnly: () => true,
                isConcurrencySafe: () => true,
                async execute({value}) {
                    return `lookup:${value}`;
                },
            };
            const writeTool: Tool<typeof parameters> = {
                name: "mcp__fixture__mutate",
                description: "mutate",
                parameters,
                isReadOnly: () => false,
                async execute() {
                    throw new Error("写 MCP 不应执行");
                },
            };
            const mcpManager: McpManagerLike = {
                async initialize() {},
                getSnapshots: () => [],
                getTools: () => [readTool, writeTool],
                subscribe: () => () => {},
                async reconnect() {},
                async closeAll() {},
            };
            const registry = createSubagentRegistry({
                definitions: [customDefinition({
                    agentType: "mcp-reader",
                    allowedTools: [readTool.name, writeTool.name],
                })],
                issues: [],
            });
            const child = createFakeLLM([
                (options) => {
                    expect(options.tools.map((tool) => tool.function.name))
                        .toEqual([readTool.name, writeTool.name]);
                    return assistantToolCall(
                        readTool.name,
                        {value: "safe"},
                        "mcp-read"
                    );
                },
                (options) => {
                    const result = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "mcp-read"
                    );
                    expect(result?.content).toContain("lookup:safe");
                    return assistantToolCall(
                        writeTool.name,
                        {value: "blocked"},
                        "mcp-write"
                    );
                },
                (options) => {
                    const result = options.messages.find((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "mcp-write"
                    );
                    expect(result?.content).toContain("This Agent only allows read-only tool calls");
                    return assistantText("MCP 权限边界正常");
                },
            ]);
            const runner = createSubagentRunnerForTest({
                parentContext: createTestContext(cwd, {
                    permissionMode: "ask",
        collaborationMode: "build",
                    mcpManager,
                }),
                onEvent: () => {},
                registry,
                agentOptions: {callLLM: child.callLLM},
                toolResultStoreOptions: {pillarHome: `${cwd}/mcp-results`},
            });

            const result = await runner({
                kind: "registered",
                agentType: "mcp-reader",
                description: "MCP 权限",
                prompt: "读取后尝试写入",
                parentToolCallId: "custom-mcp",
            });
            expect(result.reply).toBe("MCP 权限边界正常");
        });
    });
});
