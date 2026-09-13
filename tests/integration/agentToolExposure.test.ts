import {expect, test} from "bun:test";
import {access, readFile} from "node:fs/promises";
import {join} from "node:path";
import type {Message, ToolCall} from "../../src/llm/types.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createSubagentRegistry} from "../../src/subagents/registry.js";
import {createSubagentRunnerForTest} from "../helpers/subagent.js";

test("无工具总结拒绝模型的写调用，保留对应结果并可继续总结", async () => {
    await withTempProject(async cwd => {
        const history: Message[] = [{role: "system", content: "test"}];
        const fake = createFakeLLM([
            assistantToolCall("write_file", {path: "forbidden.txt", content: "unexpected"}, "write"),
            assistantText("没有执行写入，基于已有证据总结。"),
        ]);
        let executions = 0;
        const runtime = createToolRuntime();
        const result = await runAgentForTest("只总结", history, () => {}, createTestContext(cwd), {
            callLLM: fake.callLLM, getToolSchemas: () => [], maxIterations: 2,
            executeTool: (...args) => { executions++; return runtime.executeTool(...args); },
        });
        expect(executions).toBe(0);
        expect(result.reason).toBe("completed");
        expect(history.filter(message => message.role === "tool" && message.tool_call_id === "write")).toHaveLength(1);
        expect(history.find(message => message.role === "tool")?.content).toContain("was not provided in this model request");
        await expect(access(join(cwd, "forbidden.txt"))).rejects.toThrow();
    });
});

test("同批工具暴露变化不能追认调用，下一次请求实际提供后才可执行", async () => {
    await withTempProject(async cwd => {
        const history: Message[] = [{role: "system", content: "test"}];
        const runtime = createToolRuntime();
        const allowed = new Set(["list_files"]);
        const calls: ToolCall[] = [
            {id: "list", type: "function", function: {name: "list_files", arguments: "{}"}},
            {id: "early-write", type: "function", function: {name: "write_file", arguments: JSON.stringify({path: "early.txt", content: "bad"})}},
        ];
        const fake = createFakeLLM([
            {message: {role: "assistant", content: null, tool_calls: calls}, toolCalls: calls,
                usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}},
            assistantToolCall("write_file", {path: "later.txt", content: "ok"}, "later-write"),
            assistantText("已完成后续写入。"),
        ]);
        const executed: string[] = [];
        await runAgentForTest("test", history, () => {}, createTestContext(cwd), {
            callLLM: fake.callLLM, maxIterations: 3,
            getToolSchemas: () => runtime.getToolSchemas().filter(tool => allowed.has(tool.function.name)),
            executeTool: (...args) => {
                executed.push(args[3]);
                allowed.add("write_file");
                return runtime.executeTool(...args);
            },
        });
        expect(executed).toEqual(["list", "later-write"]);
        expect(history.filter(message => message.role === "tool")).toHaveLength(3);
        await expect(access(join(cwd, "early.txt"))).rejects.toThrow();
        expect(await readFile(join(cwd, "later.txt"), "utf8")).toBe("ok");
    });
});

test("未公开工具的取消批次仍完整配对", async () => {
    await withTempProject(async cwd => {
        const controller = new AbortController();
        const history: Message[] = [{role: "system", content: "test"}];
        const fake = createFakeLLM([assistantToolCall("write_file", {path: "cancelled.txt", content: "x"}, "cancelled")]);
        const result = await runAgentForTest("test", history, event => {
            if (event.type === "tool_call_start") controller.abort("user-cancel");
        }, createTestContext(cwd, {signal: controller.signal}), {
            callLLM: fake.callLLM, getToolSchemas: () => [], maxIterations: 1,
            executeTool: async () => {throw new Error("must not execute");},
        });
        expect(result.reason).toBe("interrupted");
        expect(history.filter(message => message.role === "tool" && message.tool_call_id === "cancelled")).toHaveLength(1);
        await expect(access(join(cwd, "cancelled.txt"))).rejects.toThrow();
    });
});

test("子 Agent 用尽预算后的无工具总结不能再次写入文件", async () => {
    await withTempProject(async cwd => {
        const registry = createSubagentRegistry({issues: [], definitions: [{
            agentType: "writer", whenToUse: "fixture", systemPrompt: "fixture", allowedTools: ["list_files", "write_file"],
            model: "inherit", maxIterations: 2, source: "host", id: "writer",
        }]});
        const fake = createFakeLLM([
            assistantToolCall("list_files", {}, "first"),
            options => {
                expect(options.tools).toEqual([]);
                return assistantToolCall("write_file", {path: "late.txt", content: "unexpected"}, "late");
            },
        ]);
        const runner = createSubagentRunnerForTest({registry, parentContext: createTestContext(cwd),
            onEvent() {}, agentOptions: {callLLM: fake.callLLM}});
        const result = await runner({ agentType: "writer", description: "fixture",
            prompt: "test", parentToolCallId: "parent"});
        expect(result.reason).toBe("max_turns");
        expect(fake.calls).toHaveLength(2);
        await expect(access(join(cwd, "late.txt"))).rejects.toThrow();
    });
});
