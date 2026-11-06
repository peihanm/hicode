import {expect, test} from "bun:test";
import {z} from "zod";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {executeToolCallBatch} from "../../src/agent/toolBatch.js";
import {threadsFromHistory} from "../../src/ui/conversation/threadReducer.js";
import type {AgentEvent} from "../../src/agent/types.js";
import type {Message, ToolCall} from "../../src/llm/types.js";
import type {Tool} from "../../src/tools/types.js";
import {loadSession} from "../../src/session/store/sessionStore.js";
import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";

const tool: Tool = {
    name: "mcp__fixture__calculate", mcp: {serverName: "fixture"}, description: "Multiply",
    parameters: z.object({a: z.number(), b: z.number()}).strict(),
    isReadOnly: () => true, isConcurrencySafe: () => true,
    execute: async ({a, b}) => String(a * b),
};

test("gateway preserves one call/result, real target hooks/events and restored UI", async () => withTempProject(async (cwd, storage) => {
    const runtime = createToolRuntime({additionalTools: [tool]});
    const call: ToolCall = {id: "multiply", type: "function", function: {name: "mcp_call", arguments: JSON.stringify({tool: tool.name, arguments: {a: 18, b: 7}})}};
    const history: Message[] = [{role: "user", origin: "user", content: "calculate"}, {role: "assistant", content: null, tool_calls: [call]}];
    const events: AgentEvent[] = [];
    const ctx = createTestContext(cwd);
    let batches = 0;
    ctx.runHook = async input => {
        if (input.hook_event_name === "PostToolBatch") {
            batches++; expect(input.tools).toMatchObject([{tool_call_id: call.id, name: tool.name, outcome: "ok"}]);
        }
        return {blocked: false, additionalContexts: [], executions: []};
    };
    const result = await executeToolCallBatch({history, toolCalls: [call], ctx, turnId: "turn", onEvent: event => {events.push(event);},
        executeTool: runtime.executeTool, isToolConcurrencySafe: runtime.isConcurrencySafe});
    expect(result.outcomes).toMatchObject([{toolCallId: call.id, name: tool.name, result: "126"}]);
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([{type: "tool_call_start", turnId: "turn", toolCallId: call.id,
        name: tool.name, args: '{"a":18,"b":7}'}]);
    expect(events.filter(event => event.type === "tool_call_end")).toHaveLength(1);
    expect(history.filter(message => message.role === "tool")).toEqual([{role: "tool", tool_call_id: call.id, content: "126"}]);
    expect(call.function.name).toBe("mcp_call"); expect(batches).toBe(1);
    await saveSessionSnapshot(storage, {cwd, sessionId: "gateway", model: "glm-test", history, todos: [], permissionMode: "ask"});
    const restored = loadSession(storage, cwd, "gateway")!;
    expect(restored.history.find(message => message.role === "assistant")?.tool_calls?.[0]).toEqual(call);
    expect(threadsFromHistory(restored.history).find(thread => thread.role === "tool_call")).toMatchObject({name: tool.name, args: '{"a":18,"b":7}', result: "126"});
    expect(restored).not.toHaveProperty("toolDiscovery");
}));

test("scoped live gateway survives removal and reconnection without broadening scope", async () => withTempProject(async cwd => {
    let tools = [tool];
    const runtime = createToolRuntime({allowedToolNames: ["read_file", tool.name], getAdditionalTools: () => tools});
    const input = JSON.stringify({tool: tool.name, arguments: {a: 18, b: 7}});
    const ctx = createTestContext(cwd);
    tools = [];
    expect(runtime.getToolSchemas().map(schema => schema.function.name)).toEqual(["read_file"]);
    expect((await runtime.executeTool("mcp_call", input, ctx, "removed")).outcome).toBe("failed");
    tools = [tool, {...tool, name: "mcp__private__calculate"}];
    expect((await runtime.executeTool("mcp_call", input, ctx, "reconnected")).modelContent).toBe("126");
    expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: tools[1]!.name, arguments: {a: 1, b: 1}}), ctx, "outside")).outcome).toBe("failed");
}));
