import {describe, expect, test} from "bun:test";
import {
    createCodexBridgePrompt,
    createCodexBridgeOutputSchema,
    parseCodexBridgeResponse,
} from "../../src/llm/providers/codex/protocol.js";
import type {OpenAITool} from "../../src/llm/types.js";

const READ_FILE_TOOL: OpenAITool = {
    type: "function",
    function: {
        name: "read_file",
        description: "read one file",
        parameters: {
            type: "object",
            properties: {path: {type: "string"}},
            required: ["path"],
        },
    },
};

function bridgeResponse(
    name: string,
    args = JSON.stringify({path: "README.md"})
): string {
    return JSON.stringify({
        content: null,
        tool_calls: [{
            type: "function",
            function: {name, arguments: args},
        }],
    });
}

describe("Codex Bridge protocol", () => {
    test("每轮 Prompt 末尾重申只返回 Pillar Function Call", () => {
        const prompt = createCodexBridgePrompt(
            [{role: "user", content: "check the project"}],
            [READ_FILE_TOOL]
        );

        expect(prompt).toEndWith([
            "<bridge-contract>",
            "Do not call Codex built-in shell, file, web, MCP, subagent, or user-input tools.",
            "If an action is needed, request only a function listed in <functions> through the structured response.",
            "Return only the JSON object required by the output schema.",
            "</bridge-contract>",
        ].join("\n"));
    });

    test("输出 Schema 只允许当前 Pillar 工具且不接收模型生成的 ID", () => {
        expect(createCodexBridgeOutputSchema([READ_FILE_TOOL])).toEqual({
            type: "object",
            properties: {
                content: {type: ["string", "null"]},
                tool_calls: {
                    type: "array",
                    maxItems: 128,
                    items: {
                        type: "object",
                        properties: {
                            type: {type: "string", enum: ["function"]},
                            function: {
                                type: "object",
                                properties: {
                                    name: {type: "string", enum: ["read_file"]},
                                    arguments: {type: "string"},
                                },
                                required: ["name", "arguments"],
                                additionalProperties: false,
                            },
                        },
                        required: ["type", "function"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["content", "tool_calls"],
            additionalProperties: false,
        });
    });

    test("拒绝污染的工具名和非对象参数", () => {
        expect(() => parseCodexBridgeResponse(
            bridgeResponse('read_file","arguments":"internal reasoning'),
            [READ_FILE_TOOL]
        )).toThrow("请求了未提供的函数");
        expect(() => parseCodexBridgeResponse(
            bridgeResponse("read_file", "not-json"),
            [READ_FILE_TOOL]
        )).toThrow("非法 JSON 参数");
        expect(() => parseCodexBridgeResponse(
            bridgeResponse("read_file", "[]"),
            [READ_FILE_TOOL]
        )).toThrow("参数不是对象");
    });

    test("相同模型输出由 Pillar 分配不同 Tool Call ID", () => {
        const text = bridgeResponse("read_file");
        const first = parseCodexBridgeResponse(text, [READ_FILE_TOOL]);
        const second = parseCodexBridgeResponse(text, [READ_FILE_TOOL]);

        expect(first.toolCalls[0]!.id).toMatch(/^call_codex_[0-9a-f-]+$/);
        expect(second.toolCalls[0]!.id).toMatch(/^call_codex_[0-9a-f-]+$/);
        expect(first.toolCalls[0]!.id).not.toBe(second.toolCalls[0]!.id);
    });

    test("拒绝模型自行提供 Tool Call ID", () => {
        const text = JSON.stringify({
            content: null,
            tool_calls: [{
                id: "call_read_tsconfig_for_debug",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: JSON.stringify({path: "tsconfig.app.json"}),
                },
            }],
        });

        expect(() => parseCodexBridgeResponse(text, [READ_FILE_TOOL]))
            .toThrow("不符合协议");
    });

    test("未提供工具时禁止返回 Function Call", () => {
        expect(createCodexBridgeOutputSchema([]).properties.tool_calls.maxItems).toBe(0);
        expect(() => parseCodexBridgeResponse(
            bridgeResponse("read_file"),
            []
        )).toThrow("请求了未提供的函数");
    });
});
