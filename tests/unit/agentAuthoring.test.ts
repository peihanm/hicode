import {describe, expect, test} from "bun:test";
import {createAgentDefinitionGenerator} from "../../src/subagents/index.js";
import {EMPTY_PROJECT_INSTRUCTIONS} from "../../src/prompt/instructions.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

function runtime(fake: ReturnType<typeof createFakeLLM>) {
    return createAgentDefinitionGenerator({callLLM: fake.callLLM})({
        storage: createPillarStorageLayout({pillarHome: "/tmp/pillar-agent-authoring"}),
        cwd: "/fixture",
        model: "glm-test",
        instructions: EMPTY_PROJECT_INSTRUCTIONS,
        availableToolNames: ["list_files", "read_file", "grep", "edit_file"],
        getExistingAgentNames: () => ["Explore"],
    });
}

describe("agent authoring", () => {
    test("只接受私有 function call，并返回尚未落盘的候选", async () => {
        const fake = createFakeLLM([assistantToolCall(
            "submit_agent_definition",
            {
                name: "frontend-specialist",
                description: "实现前端结构和样式",
                system_prompt: "只处理前端任务，修改后报告文件。",
                suggested_tools: ["list_files", "read_file", "grep", "edit_file"],
                model: "inherit",
                max_iterations: 10,
            }
        )]);
        const candidate = await runtime(fake).generate("创建一个前端 Agent");
        expect(candidate).toMatchObject({
            name: "frontend-specialist",
            maxIterations: 10,
            model: "inherit",
        });
        expect(fake.calls[0]?.kind).toBe("agent_authoring");
        expect(fake.calls[0]?.tools).toHaveLength(1);
    });

    test("拒绝正文、未知工具和重名候选", async () => {
        await expect(runtime(createFakeLLM([
            assistantText("{\"name\":\"bad\"}"),
        ])).generate("create")).rejects.toThrow("普通正文");

        await expect(runtime(createFakeLLM([assistantToolCall(
            "submit_agent_definition",
            {
                name: "unknown-tool",
                description: "bad",
                system_prompt: "bad",
                suggested_tools: ["bash"],
                model: "inherit",
                max_iterations: 8,
            }
        )])).generate("create")).rejects.toThrow("不存在");

        await expect(runtime(createFakeLLM([assistantToolCall(
            "submit_agent_definition",
            {
                name: "Explore",
                description: "duplicate",
                system_prompt: "duplicate",
                suggested_tools: ["read_file"],
                model: "inherit",
                max_iterations: 8,
            }
        )])).generate("create")).rejects.toThrow("已经存在");
    });

    test("拒绝同时返回正文和候选工具调用", async () => {
        const response = assistantToolCall("submit_agent_definition", {
            name: "mixed-response",
            description: "mixed",
            system_prompt: "mixed",
            suggested_tools: ["read_file"],
            model: "inherit",
            max_iterations: 8,
        });
        response.message = {
            ...response.message,
            role: "assistant",
            content: "我已经生成好了。",
        };
        await expect(runtime(createFakeLLM([response])).generate("create"))
            .rejects.toThrow("普通正文");
    });
});
