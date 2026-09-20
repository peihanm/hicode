import {describe, expect, test} from "bun:test";
import {createAgentDefinitionGenerator} from "../../src/subagents/authoring/generator.js";
import {EMPTY_PROJECT_INSTRUCTIONS} from "../../src/prompt/instructions.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createHiCodeStorageLayout} from "../../src/persistence/index.js";

function runtime(fake: ReturnType<typeof createFakeLLM>) {
    return createAgentDefinitionGenerator({callLLM: fake.callLLM})({
        storage: createHiCodeStorageLayout({hicodeHome: "/tmp/hicode-agent-authoring"}),
        cwd: "/fixture",
        model: "glm-test",
        instructions: EMPTY_PROJECT_INSTRUCTIONS,
        availableToolNames: ["read_file", "bash", "edit_file"],
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
                read_only: false,
            }
        )]);
        const candidate = await runtime(fake).generate("创建一个前端 Agent");
        expect(candidate).toMatchObject({
            name: "frontend-specialist",
            readOnly: false,
        });
        expect(fake.calls[0]?.kind).toBe("agent_authoring");
        expect(fake.calls[0]?.tools).toHaveLength(1);
    });

    test("拒绝正文、扩权字段和重名候选", async () => {
        await expect(runtime(createFakeLLM([
            assistantText("{\"name\":\"bad\"}"),
        ])).generate("create")).rejects.toThrow("ordinary text");

        await expect(runtime(createFakeLLM([assistantToolCall(
            "submit_agent_definition",
            {
                name: "unknown-tool",
                suggested_tools: ["agent"],
                description: "bad",
                system_prompt: "bad",
                read_only: false,
            }
        )])).generate("create")).rejects.toThrow("validation failed");

        await expect(runtime(createFakeLLM([assistantToolCall(
            "submit_agent_definition",
            {
                name: "Explore",
                description: "duplicate",
                system_prompt: "duplicate",
                read_only: false,
            }
        )])).generate("create")).rejects.toThrow("already exists");
    });

    test("拒绝同时返回正文和候选工具调用", async () => {
        const response = assistantToolCall("submit_agent_definition", {
            name: "mixed-response",
            description: "mixed",
            system_prompt: "mixed",
            read_only: false,
        });
        response.message = {
            ...response.message,
            role: "assistant",
            content: "我已经生成好了。",
        };
        await expect(runtime(createFakeLLM([response])).generate("create"))
            .rejects.toThrow("ordinary text");
    });
});
