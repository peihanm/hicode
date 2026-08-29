import {describe, expect, test} from "bun:test";
import {listConfiguredPrimaryModels} from "../../src/llm/modelCatalog.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {resolvePillarSettings} from "../../src/settings/index.js";

describe("primary model catalog", () => {
    test("一个有凭证的 source 暴露其全部已配置模型与 label", () => {
        const sources = resolvePillarSettings([]).values.sources;
        const models = listConfiguredPrimaryModels(sources, {
            DASHSCOPE_API_KEY: "qwen-key",
            GLM_API_KEY: "glm-key",
        });

        expect(models).toEqual([
            {
                source: "glm",
                provider: "glm",
                model: "glm-5.2",
                label: "GLM 5.2",
            },
            {
                source: "glm",
                provider: "glm",
                model: "glm-4.7",
                label: "GLM 4.7",
            },
            {
                source: "qwen",
                provider: "qwen",
                model: "qwen3.6-plus",
                label: "Qwen 3.6 Plus",
            },
            {
                source: "qwen",
                provider: "qwen",
                model: "qwen3.6-flash",
                label: "Qwen 3.6 Flash",
            },
        ]);
    });

    test("Runtime 只允许切换到启动时确认可用的候选", () => {
        const sources = resolvePillarSettings([]).values.sources;
        const initial = {
            source: "qwen" as const,
            provider: "qwen" as const,
            model: "qwen3.6-plus",
            label: "Qwen 3.6 Plus",
        };
        const alternative = {
            source: "deepseek" as const,
            provider: "deepseek" as const,
            model: "deepseek-v4-pro",
            label: "DeepSeek V4 Pro",
        };
        const runtime = createPrimaryModelRuntime(
            initial,
            sources,
            [initial, alternative]
        );

        runtime.select(alternative);
        expect(runtime.target).toEqual(alternative);
        expect(() => runtime.select({
            source: "glm",
            provider: "glm",
            model: "glm-5.2",
            label: "GLM 5.2",
        })).toThrow("当前不可用");
    });
});
