import {configuredModelSources} from "../helpers/modelSources.js";
import {afterEach, describe, expect, test} from "bun:test";
import {listConfiguredPrimaryModels} from "../../src/llm/modelCatalog.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup();});
const registerCleanup = (cleanup: () => Promise<void>) => {cleanups.push(cleanup);};

describe("primary model catalog", () => {
    test("Ark Agent Plan has independent credentials and a distinct DeepSeek catalog entry", () => {
        const sources = resolveHiCodeSettings([]).values.sources;
        const ark = listConfiguredPrimaryModels(sources, {ARK_AGENT_PLAN_API_KEY: "ark"});
        expect(ark).toEqual([
            {source:"ark-agent-plan", model:"deepseek-v4.1-flash", label:"DeepSeek 4.1 Flash (Ark Agent Plan)"},
            {source:"ark-agent-plan", model:"glm-5.3-flash", label:"GLM 5.3 Flash (Ark Agent Plan)"},
        ]);
        expect(listConfiguredPrimaryModels(sources, {QWEN_TOKEN_PLAN_API_KEY:"qwen"}).some(model => model.source === "ark-agent-plan")).toBe(false);
        expect(sources["ark-agent-plan"].models[0]?.imageInput).toBe(true);
        const available = listConfiguredPrimaryModels(sources, {ARK_AGENT_PLAN_API_KEY:"ark", QWEN_TOKEN_PLAN_API_KEY:"qwen"});
        const runtime = createPrimaryModelRuntime(ark[0]!, configuredModelSources(sources, available, registerCleanup));
        runtime.select(available.find(model => model.source === "qwen-token-plan" && model.model === "deepseek-v4.1-flash")!);
        expect(runtime.target.source).toBe("qwen-token-plan");
        runtime.select(ark[0]!);
        expect(runtime.target.source).toBe("ark-agent-plan");
    });
    test("ordinary Qwen and Token Plan expose independent models and credentials", () => {
        const sources = resolveHiCodeSettings([]).values.sources;
        const ordinary = listConfiguredPrimaryModels(sources, {DASHSCOPE_API_KEY: "ordinary"});
        const plan = listConfiguredPrimaryModels(sources, {QWEN_TOKEN_PLAN_API_KEY: "plan"});
        expect(ordinary.every(model => model.source === "qwen")).toBe(true);
        expect(plan.map(model => [model.source, model.model])).toEqual([
            ["qwen-token-plan", "qwen3.8-flash"],
            ["qwen-token-plan", "deepseek-v4.1-flash"],
        ]);
        const available = listConfiguredPrimaryModels(sources, {DASHSCOPE_API_KEY: "ordinary", QWEN_TOKEN_PLAN_API_KEY: "plan"});
        const ordinaryFlash = ordinary.find(model => model.model === "qwen3.8-flash")!;
        const planFlash = plan[0]!;
        expect(ordinaryFlash.label).not.toBe(planFlash.label);
        const runtime = createPrimaryModelRuntime(ordinaryFlash, configuredModelSources(sources, available, registerCleanup));
        runtime.select(planFlash);
        expect(runtime.target.source).toBe("qwen-token-plan");
        runtime.select(ordinaryFlash);
        expect(runtime.target.source).toBe("qwen");
    });

    test("一个有凭证的 source 暴露其全部已配置模型与 label", () => {
        const sources = resolveHiCodeSettings([]).values.sources;
        const models = listConfiguredPrimaryModels(sources, {
            DASHSCOPE_API_KEY: "qwen-key",
            GLM_API_KEY: "glm-key",
        });

        expect(models).toEqual([
            {source: "glm", model: "glm-5.3", label: "GLM 5.3"},
            {source: "glm", model: "glm-5.3-flash", label: "GLM 5.3 Flash"},
            {source: "glm", model: "glm-5.2", label: "GLM 5.2"},
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

    test("Runtime 只允许切换到有凭证且配置已声明的候选", () => {
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
            configuredModelSources(sources, [initial, alternative], registerCleanup)
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
    const runtime = createPrimaryModelRuntime(available[0]!, configuredModelSources(sources, available, registerCleanup));
    expect(() => runtime.select({...available[0]!, model: "undeclared"})).toThrow("is unavailable");
});
