import {describe, expect, test} from "bun:test";
import {listConfiguredPrimaryModels} from "../../src/llm/modelCatalog.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";

describe("primary model catalog", () => {
    test("一个有凭证的 source 暴露其全部已配置模型与 label", () => {
        const sources = resolveHiCodeSettings([]).values.sources;
        const models = listConfiguredPrimaryModels(sources, {
            DASHSCOPE_API_KEY: "qwen-key",
            GLM_API_KEY: "glm-key",
        });

        expect(models).toEqual([
            {
                source: "glm",
                model: "glm-5.2",
                label: "GLM 5.2",
            },
            {
                source: "glm",
                model: "glm-4.7",
                label: "GLM 4.7",
            },
            {
                source: "qwen",
                model: "qwen3.8-flash",
                label: "Qwen 3.8 Flash",
            },
            {
                source: "qwen",
                model: "qwen3.8-max",
                label: "Qwen 3.8 Max",
            },
            {
                source: "qwen",
                model: "qwen3.6-plus",
                label: "Qwen 3.6 Plus",
            },
            {
                source: "qwen",
                model: "qwen3.6-flash",
                label: "Qwen 3.6 Flash",
            },
        ]);
    });

    test("Runtime 只允许切换到启动时确认可用的候选", () => {
        const sources = resolveHiCodeSettings([]).values.sources;
        const initial = {
            source: "qwen" as const,
            model: "qwen3.6-plus",
            label: "Qwen 3.6 Plus",
        };
        const alternative = {
            source: "deepseek" as const,
            model: "deepseek-pro",
            label: "DeepSeek Pro",
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
            model: "glm-5.2",
            label: "GLM 5.2",
        })).toThrow("is unavailable");
    });
});

test("可信来源声明的别名不会被模型家族前缀过滤，未声明目标仍拒绝", () => {
    const sources = resolveHiCodeSettings([]).values.sources;
    sources.qwen = {...sources.qwen, models: [{id: "vendor/custom-alias", label: "Alias"}]};
    const available = listConfiguredPrimaryModels(sources, {DASHSCOPE_API_KEY: "fixture"});
    expect(available).toEqual([{source: "qwen", model: "vendor/custom-alias", label: "Alias"}]);
    const runtime = createPrimaryModelRuntime(available[0]!, sources, available);
    expect(() => runtime.select({...available[0]!, model: "undeclared"})).toThrow("is unavailable");
});
