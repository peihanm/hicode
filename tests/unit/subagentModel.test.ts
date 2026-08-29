import {describe, expect, test} from "bun:test";
import {
    formatSubagentModel,
    resolveSubagentModel,
} from "../../src/subagents/index.js";

describe("subagent model routing", () => {
    test("inherit 保留 Root 模型，fast 使用独立配置模型", () => {
        expect(resolveSubagentModel({
            definitionModel: "inherit",
            parentModel: "qwen3.6-plus",
            fastModel: "glm-4.7",
        })).toBe("qwen3.6-plus");
        expect(resolveSubagentModel({
            definitionModel: "fast",
            parentModel: "qwen3.6-plus",
            fastModel: "glm-4.7",
        })).toBe("glm-4.7");
        expect(formatSubagentModel("fast")).toBe(
            "fast（使用配置的快速模型）"
        );
        expect(formatSubagentModel("fast", "继承 Root", "glm-4.7"))
            .toBe("fast (glm-4.7)");
    });

    test("调用级选择优先于 Definition，精确模型保持原值", () => {
        expect(resolveSubagentModel({
            definitionModel: "fast",
            parentModel: "qwen3.6-plus",
            fastModel: "glm-4.7",
            override: "inherit",
        })).toBe("qwen3.6-plus");
        expect(resolveSubagentModel({
            definitionModel: "inherit",
            parentModel: "qwen3.6-plus",
            fastModel: "glm-4.7",
            override: "fast",
        })).toBe("glm-4.7");
        expect(resolveSubagentModel({
            definitionModel: "qwen-custom-reviewer",
            parentModel: "qwen3.6-plus",
            fastModel: "glm-4.7",
        })).toBe("qwen-custom-reviewer");
    });
});
