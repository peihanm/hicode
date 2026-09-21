import {createWriterRegistry} from "../helpers/writerAgent.js";
import {bashTool} from "../../src/tools/bash/bash.js";
import {describe, expect, test} from "bun:test";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {executeToolCallBatch} from "../../src/agent/toolBatch.js";
import {createAgentTool} from "../../src/tools/agent/agent.js";
import {createSubagentRegistry} from "../../src/subagents/registry.js";
import type {Message, ToolCall} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createSubagentRunnerForTest} from "../helpers/subagent.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {mkdir} from "node:fs/promises";
import {z} from "zod";
import type {Tool} from "../../src/tools/types.js";

describe("effective execution capabilities", () => {
    test("Bash rules consume literal argv and cannot authorize hidden syntax", async () => {
        await withTempProject(async cwd => {
            const rt = createToolRuntime({toolOverrides: [{...bashTool, getDefaultApprovalScope: () => undefined}]});
            const ctx = createTestContext(cwd, {permissionMode: "ask",
                canUseTool: async () => ({behavior: "deny", message: "not approved"})});
            ctx.permissionRules.allow.push({toolName: "bash", content: "printf:*", source: "local"});
            const literal = await rt.executeTool("bash", JSON.stringify({command: 'p"rintf" ok'}), ctx, "literal");
            expect(literal.outcome).toBe("ok");
            const dynamic = await rt.executeTool("bash", JSON.stringify({command: 'printf "$(touch hidden.txt)"'}), ctx, "dynamic");
            expect(dynamic.outcome).toBe("denied");
            expect(await Bun.file(`${cwd}/hidden.txt`).exists()).toBe(false);
            ctx.permissionRules.deny.push({toolName: "bash", content: "sort -oout:*", source: "local"});
            const deny = await rt.executeTool("bash", JSON.stringify({command: 's"ort" "-oout" input'}), ctx, "deny");
            expect(deny.modelContent).toContain("Denied by rule");
            ctx.setPermissionMode("full-access");
            const opaque = await rt.executeTool("bash", JSON.stringify({command: 'printf "$(touch hidden.txt)"'}), ctx, "opaque");
            expect(opaque.outcome).toBe("denied");
            expect(await Bun.file(`${cwd}/hidden.txt`).exists()).toBe(false);
        });
    });

    test.each(["ask", "auto-review", "full-access"] as const)("Plan %s refuses writer launches without approval", async permissionMode => {
        await withTempProject(async cwd => {
            const workspace = `${cwd}/workspace`;
            await mkdir(workspace);
            const registry = createSubagentRegistry({issues: [], definitions: [{
                source: "host", id: "fixture", agentType: "Writer", whenToUse: "fixture", systemPrompt: "fixture",
                allowedTools: ["write_file"],
            }]});
            let approvals = 0;
            const ctx = createTestContext(workspace, {permissionMode, collaborationMode: "plan", workspaceBoundary: cwd,
                canUseTool: async () => { approvals++; return {behavior: "allow"}; }});
            const child = createFakeLLM([
                assistantToolCall("write_file", {path: "inside.txt", content: "approved"}, "inside"),
                assistantToolCall("write_file", {path: "../outside.txt", content: "escape"}, "outside"),
                (options) => {
                    expect(options.messages.find(item => item.role === "tool" && item.tool_call_id === "outside")?.content).toContain("Permission denied");
                    return assistantText("done");
                },
            ]);
            attachSubagentLauncher(ctx, createSubagentRunnerForTest({parentContext: ctx, registry,
                onEvent: () => {}, agentOptions: {callLLM: child.callLLM}}));
            const rt = createToolRuntime({toolOverrides: [createAgentTool(registry)]});
            expect((await rt.executeTool("agent", JSON.stringify({subagent_type: "Writer", description: "write", prompt: "write"}), ctx, "writer")).outcome).toBe("denied");
            expect(approvals).toBe(0);
            expect(await Bun.file(`${workspace}/inside.txt`).exists()).toBe(false);
            expect(child.calls).toHaveLength(0);
            expect(await Bun.file(`${cwd}/outside.txt`).exists()).toBe(false);
            expect(ctx.collaborationMode).toBe("plan");
            expect(ctx.permissionMode).toBe(permissionMode);
        });
    });

    test("invalid parent cwd outside its hard boundary stays fail closed after approval", async () => {
        await withTempProject(async cwd => {
            await mkdir(`${cwd}/allowed`);
            const ctx = createTestContext(cwd, {collaborationMode: "plan", workspaceBoundary: `${cwd}/allowed`});
            const child = createFakeLLM([
                assistantToolCall("write_file", {path: "allowed/ok.txt", content: "ok"}, "ok"),
                assistantToolCall("write_file", {path: "root.txt", content: "wrong"}, "wrong"),
                options => {
                    expect(options.messages.find(item => item.role === "tool" && item.tool_call_id === "wrong")?.content).toContain("Permission denied");
                    return assistantText("done");
                },
            ]);
            attachSubagentLauncher(ctx, createSubagentRunnerForTest({parentContext: ctx, registry: createWriterRegistry(), onEvent: () => {}, agentOptions: {callLLM: child.callLLM}}));
            await createToolRuntime({toolOverrides: [createAgentTool(createWriterRegistry())]}).executeTool("agent", JSON.stringify({subagent_type: "FixtureWriter", description: "bounded write", prompt: "write"}), ctx, "bounded");
            expect(await Bun.file(`${cwd}/allowed/ok.txt`).exists()).toBe(false);
            expect(await Bun.file(`${cwd}/root.txt`).exists()).toBe(false);
            expect(ctx.collaborationMode).toBe("plan");
        });
    });

    test.each(["bash", "mcp__fixture__mutate"])("approval to launch %s child does not remove Plan", async toolName => {
        await withTempProject(async cwd => {
            let writes = 0;
            const tool: Tool = {name: toolName, description: "fixture", parameters: z.object({}),
                exposure: "direct", isReadOnly: () => false, async execute() { writes++; return "mutated"; }};
            const registry = createSubagentRegistry({issues: [], definitions: [{
                source: "host", id: "fixture", agentType: "IndirectWriter", whenToUse: "fixture", systemPrompt: "fixture",
                allowedTools: [toolName],
            }]});
            let approvals = 0;
            const ctx = createTestContext(cwd, {permissionMode: "full-access", collaborationMode: "plan",
                mcpManager: {async waitForRefresh() {},
        async initialize() {}, getSnapshots: () => [], getTools: () => [tool], subscribe: () => () => {}, async reconnect() {}, async closeAll() {}},
                canUseTool: async () => { approvals++; return {behavior: "allow"}; }});
            // Only MCP is supplied dynamically. Bash uses the production tool/runner.
            if (toolName === "bash") {ctx.mcpManager = undefined; ctx.availableTools = createToolRuntime().getTools();}
            const child = createFakeLLM([
                assistantToolCall(toolName, toolName === "bash" ? {command: "printf escaped > escaped.txt"} : {}, "write"),
                options => {
                    expect(options.messages.find(item => item.role === "tool" && item.tool_call_id === "write")?.content).toContain("Permission denied");
                    return assistantText("denied");
                },
            ]);
            const runner = createSubagentRunnerForTest({parentContext: ctx, registry, onEvent: () => {}, agentOptions: {callLLM: child.callLLM}});
            attachSubagentLauncher(ctx, runner);
            const rt = createToolRuntime({toolOverrides: [createAgentTool(registry)]});
            await rt.executeTool("agent", JSON.stringify({subagent_type: "IndirectWriter", description: "write", prompt: "write"}), ctx, "indirect");
            expect(approvals).toBe(0);
            expect(child.calls).toHaveLength(0);
            expect(writes).toBe(0);
            expect(await Bun.file(`${cwd}/escaped.txt`).exists()).toBe(false);
        });
    });
    test.each(['sort -oout input', 'sort "-o" out input', 'sort -rout input', 'sort \\-o out input'])(
        "只读 Agent 拒绝等价写出选项: %s", async command => {
            await withTempProject(async cwd => {
                await Bun.write(`${cwd}/input`, "b\na\n");
                let approvals = 0;
                const ctx = createTestContext(cwd, {
                    permissionMode: "ask", collaborationMode: "plan", readOnlyTools: true,
                    canUseTool: async () => { approvals++; return {behavior: "deny", message: "no writes"}; },
                });
                const rt = createToolRuntime();
                const args = JSON.stringify({command});
                const result = await rt.executeTool("bash", args, ctx, "sort");
                expect(result.outcome).toBe("denied");
                expect(approvals).toBe(0);
                expect(rt.isConcurrencySafe("bash", args)).toBe(false);
                expect(await Bun.file(`${cwd}/out`).exists()).toBe(false);
            });
        }
    );

    test.each(["tail -n 20", "tee result.log"])("failed check retains status through %s", async filter => {
        await withTempProject(async cwd => {
            const result = await createToolRuntime().executeTool("bash", JSON.stringify({
                command: `(printf 'check failed\\n'; exit 7) | ${filter}`,
            }), createTestContext(cwd), "check");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("7");
        });
    });

    test.each(["ask", "auto-review", "full-access"] as const)("Plan %s cannot escape via Bash Agent", async permissionMode => {
        await withTempProject(async cwd => {
            const registry = createSubagentRegistry({issues: [], definitions: [{
                source: "host", id: "fixture", agentType: "ShellHelper", whenToUse: "fixture",
                systemPrompt: "fixture", allowedTools: ["bash"],
            }]});
            let approvals = 0;
            const ctx = createTestContext(cwd, {permissionMode, collaborationMode: "plan",
                canUseTool: async () => { approvals++; return {behavior: "deny", message: "no writes"}; },
            });
            const child = createFakeLLM([
                assistantToolCall("bash", {command: "printf escaped > escaped.txt"}, "write"), assistantText("done"),
            ]);
            attachSubagentLauncher(ctx, createSubagentRunnerForTest({parentContext: ctx, onEvent: () => {},
                registry, agentOptions: {callLLM: child.callLLM},
            }));
            const rt = createToolRuntime({toolOverrides: [createAgentTool(registry)]});
            const result = await rt.executeTool("agent", JSON.stringify({subagent_type: "ShellHelper",
                description: "write", prompt: "write"}), ctx, "delegate");
            expect(result.outcome).toBe("denied");
            expect(approvals).toBe(0);
            expect(child.calls).toHaveLength(0);
            expect(await Bun.file(`${cwd}/escaped.txt`).exists()).toBe(false);
        });
    });

    test.each([
        {original: "pwd", replacement: "printf written >> shared.txt"},
        {original: "printf forbidden >> original.txt", replacement: "pwd"},
        {original: "pwd", replacement: undefined},
    ])("Hook serializes full executions: %j", async ({original, replacement}) => {
        await withTempProject(async cwd => {
            const sequence: string[] = [];
            const rt = createToolRuntime({hooks: {enabled: true, hasToolHooks: () => true, inspect: () => [], reload: async () => {}, issues: [], async execute(input) {
                if (input.hook_event_name === "PreToolUse") {
                    sequence.push(`pre:${input.tool_call_id}`);
                    return {blocked: false, executions: [], additionalContexts: [],
                        ...(replacement ? {updatedInput: {command: replacement}} : {})};
                }
                if (input.hook_event_name === "PostToolUse") sequence.push(`post:${input.tool_call_id}`);
                return {blocked: false, executions: [], additionalContexts: []};
            }}});
            const calls: ToolCall[] = ["one", "two"].map(id => ({id, type: "function",
                function: {name: "bash", arguments: JSON.stringify({command: original})}}));
            const history: Message[] = [{role: "assistant", content: "", tool_calls: calls}];
            const result = await executeToolCallBatch({toolCalls: calls, history, ctx: createTestContext(cwd),
                turnId: "turn", onEvent: () => {}, executeTool: rt.executeTool, isToolConcurrencySafe: rt.isConcurrencySafe});
            expect(result.outcomes.map(item => item.outcome)).toEqual(["ok", "ok"]);
            expect(sequence).toEqual(["pre:one", "post:one", "pre:two", "post:two"]);
            expect(history.filter(item => item.role === "tool")).toHaveLength(2);
            if (replacement?.includes("shared.txt")) expect(await Bun.file(`${cwd}/shared.txt`).text()).toBe("writtenwritten");
            expect(await Bun.file(`${cwd}/original.txt`).exists()).toBe(false);
        });
    });

    test("cancel during Hook leaves all tool calls paired and consumes no approval", async () => {
        await withTempProject(async cwd => {
            const controller = new AbortController();
            let hookCalls = 0;
            let approvals = 0;
            const rt = createToolRuntime({hooks: {enabled: true, hasToolHooks: () => true, inspect: () => [], reload: async () => {}, issues: [], async execute() {
                hookCalls++;
                controller.abort();
                return {blocked: false, additionalContexts: [], executions: [], updatedInput: {command: "printf wrong > wrong.txt"}};
            }}});
            const calls: ToolCall[] = ["one", "two"].map(id => ({id, type: "function",
                function: {name: "bash", arguments: JSON.stringify({command: "pwd"})}}));
            const history: Message[] = [{role: "assistant", content: "", tool_calls: calls}];
            const ended: string[] = [];
            const result = await executeToolCallBatch({toolCalls: calls, history,
                ctx: createTestContext(cwd, {signal: controller.signal, permissionMode: "ask",
                    canUseTool: async () => { approvals++; return {behavior: "allow"}; }}),
                turnId: "cancel", onEvent: event => { if (event.type === "tool_call_end") ended.push(event.toolCallId); },
                executeTool: rt.executeTool, isToolConcurrencySafe: rt.isConcurrencySafe});
            expect(result.status).toBe("interrupted");
            expect(ended).toEqual(["one", "two"]);
            expect(history.filter(item => item.role === "tool").map(item => item.tool_call_id)).toEqual(["one", "two"]);
            expect(hookCalls).toBe(1);
            expect(approvals).toBe(0);
            expect(await Bun.file(`${cwd}/wrong.txt`).exists()).toBe(false);
        });
    });
});
