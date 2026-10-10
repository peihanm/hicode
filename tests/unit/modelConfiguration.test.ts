import {afterEach, expect, test} from "bun:test";
import {mkdir, readFile, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {parse as parseEnv} from "dotenv";
import {loadEnv} from "../../src/cli/env.js";
import {createModelConfiguration} from "../../src/settings/modelConfiguration.js";
import {loadHiCodeSettings} from "../../src/settings/index.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {withTempProject} from "../helpers/tempProject.js";

const prior = process.env.DEEPSEEK_API_KEY;
const currentKey = (): string | undefined => process.env.DEEPSEEK_API_KEY;
afterEach(() => {if (prior === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prior;});

function setup(storage: Parameters<typeof createModelConfiguration>[0], cwd: string) {
    const settings = resolveHiCodeSettings([]).values;
    const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources);
    return {runtime, config: createModelConfiguration(storage, cwd, runtime)};
}

test("Token Plan settings and credentials coexist with ordinary Qwen and survive selection reload", async () => {
    const keys = ["DASHSCOPE_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"] as const;
    const previous = keys.map(key => process.env[key]);
    try {
        await withTempProject(async (cwd, storage) => {
            const {runtime, config} = setup(storage, cwd);
            await config.saveKey("qwen", "ordinary-fixture");
            await config.saveEndpoint("qwen", "https://ordinary.example/v1");
            const ordinary = structuredClone(runtime.sources.qwen);
            await config.saveKey("qwen-token-plan", "plan-fixture");
            await config.saveEndpoint("qwen-token-plan", "https://plan.example/v1");
            expect(runtime.sources.qwen).toEqual(ordinary);
            expect(parseEnv(await readFile(join(storage.hicodeHome, ".env"), "utf8"))).toEqual({
                DASHSCOPE_API_KEY: "ordinary-fixture", QWEN_TOKEN_PLAN_API_KEY: "plan-fixture",
            });
            const target = runtime.available.find(model => model.source === "qwen-token-plan")!;
            await config.saveSelection(target);
            const loaded = loadHiCodeSettings({cwd, storage});
            expect(loaded.issues).toHaveLength(0);
            expect(loaded.values.models.primary).toEqual(target);
            expect(loaded.values.sources.qwen).toEqual(ordinary);
            expect(loaded.values.sources["qwen-token-plan"].baseUrl).toBe("https://plan.example/v1");
            await config.saveSelection(runtime.available.find(model => model.source === "qwen")!);
            expect(loadHiCodeSettings({cwd, storage}).values.models.primary.source).toBe("qwen");
        });
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
});

test("Key, custom model and endpoint save safely, refresh immediately and selection survives restart", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await mkdir(storage.hicodeHome);
        await writeFile(join(storage.hicodeHome, ".env"), "# retained\nOTHER_KEY=unrelated-fixture\n");
        await writeFile(join(storage.hicodeHome, "settings.json"), '{"memory":{"enabled":false},"custom":{"keep":true}}');
        const path = await config.saveKey("deepseek", "fixture-secret");
        expect(path).toBe(join(storage.hicodeHome, ".env"));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(parseEnv(await readFile(path, "utf8"))).toEqual({OTHER_KEY: "unrelated-fixture", DEEPSEEK_API_KEY: "fixture-secret"});
        expect(runtime.available.some(model => model.source === "deepseek")).toBe(true);
        await config.addModel("deepseek", "custom/model", "My Model");
        await config.saveEndpoint("deepseek", "https://proxy.example/v1");
        const selected = runtime.available.find(model => model.model === "custom/model")!;
        await config.saveSelection(selected);
        expect(runtime.target).toEqual(selected);
        expect(runtime.sources.deepseek.baseUrl).toBe("https://proxy.example/v1");
        const serialized = await readFile(join(storage.hicodeHome, "settings.json"), "utf8");
        expect(serialized).not.toContain("fixture-secret");
        expect(JSON.parse(serialized)).toMatchObject({memory: {enabled: false}, custom: {keep: true}});
        const loaded = loadHiCodeSettings({cwd, storage});
        expect(loaded.values.models.primary).toEqual(selected);
        expect(loaded.values.models.fast).toBeUndefined();
        await config.saveEndpoint("deepseek", "");
        expect(runtime.sources.deepseek.baseUrl).toBeUndefined();
        await expect(config.addModel("deepseek", "custom/model", "Duplicate")).rejects.toThrow("already exists");
    });
});

test("concurrent model additions preserve each other; optional label defaults to ID", async () => {
    await withTempProject(async (cwd, storage) => {
        const first = setup(storage, cwd), second = setup(storage, cwd);
        await Promise.all([first.config.addModel("deepseek", "extra-one", ""), second.config.addModel("deepseek", "extra-two", "Second")]);
        const loaded = loadHiCodeSettings({cwd, storage});
        expect(loaded.values.sources.deepseek.models).toEqual(expect.arrayContaining([{id: "extra-one", label: "extra-one", imageInput: false}, {id: "extra-two", label: "Second", imageInput: false}]));
    });
});

test("project Key and primary override update their effective local files without replacing shared settings", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=old-fixture\nAPP_MODE=dev\n");
        expect(await config.saveKey("deepseek", "new-fixture")).toBe(join(cwd, ".env"));
        expect(parseEnv(await readFile(join(cwd, ".env"), "utf8"))).toMatchObject({APP_MODE: "dev", DEEPSEEK_API_KEY: "new-fixture"});
        await mkdir(join(cwd, ".hicode"));
        const shared = '{"models":{"primary":{"source":"qwen","model":"qwen3.8-flash"}}}';
        await writeFile(join(cwd, ".hicode/settings.json"), shared);
        await writeFile(join(cwd, ".hicode/settings.local.json"), '{"permissions":{"allow":["read_file"]}}');
        const selected = runtime.available.find(item => item.source === "deepseek")!;
        await config.saveSelection(selected);
        expect(await readFile(join(cwd, ".hicode/settings.json"), "utf8")).toBe(shared);
        const local = JSON.parse(await readFile(join(cwd, ".hicode/settings.local.json"), "utf8"));
        expect(local.permissions.allow).toEqual(["read_file"]);
        expect(loadHiCodeSettings({storage, cwd}).values.models.primary).toEqual(selected);
    });
});

test("unsafe files, corrupt settings, duplicate or invalid values fail without overwriting", async () => {
    await withTempProject(async (cwd, storage) => {
        const {config} = setup(storage, cwd);
        await mkdir(storage.hicodeHome);
        const path = join(storage.hicodeHome, "settings.json");
        await writeFile(path, "{corrupt");
        await expect(config.addModel("deepseek", "test", "Test")).rejects.toThrow("Invalid settings");
        expect(await readFile(path, "utf8")).toBe("{corrupt");
        await expect(config.saveEndpoint("deepseek", "https://secret@example.com/v1")).rejects.toThrow("without credentials");
        await expect(config.saveKey("deepseek", "bad\nKEY=injection")).rejects.toThrow("single-line");
        const outside = join(cwd, "untouched"); await writeFile(outside, "keep");
        await symlink(outside, join(storage.hicodeHome, ".env"));
        await expect(config.saveKey("deepseek", "test-key")).rejects.toThrow("safely read");
        expect(await readFile(outside, "utf8")).toBe("keep");
    });
});

test("CLI accepts no env file; project values win and user credentials fill missing entries", async () => {
    await withTempProject(async (cwd, storage) => {
        expect(() => loadEnv(storage, cwd)).not.toThrow();
        delete process.env.DEEPSEEK_API_KEY;
        await mkdir(storage.hicodeHome);
        await writeFile(join(storage.hicodeHome, ".env"), "DEEPSEEK_API_KEY=user-fixture\n");
        await writeFile(join(cwd, ".env"), "# project has no provider credential\n");
        loadEnv(storage, cwd);
        expect(currentKey()).toBe("user-fixture");
        delete process.env.DEEPSEEK_API_KEY;
        await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=project-fixture\n");
        loadEnv(storage, cwd);
        expect(currentKey()).toBe("project-fixture");
        process.env.DEEPSEEK_API_KEY = "process-fixture";
        loadEnv(storage, cwd);
        expect(currentKey()).toBe("process-fixture");
    });
});

test("credential-looking lines inside another multiline value cannot be overwritten", async () => {
    await withTempProject(async (cwd, storage) => {
        const {config} = setup(storage, cwd);
        await mkdir(storage.hicodeHome);
        const path = join(storage.hicodeHome, ".env");
        const before = "MULTILINE='first\nDEEPSEEK_API_KEY=embedded-text\nlast'\n";
        await writeFile(path, before);
        await expect(config.saveKey("deepseek", "replacement-fixture")).rejects.toThrow("another variable");
        expect(await readFile(path, "utf8")).toBe(before);
    });
});

test("removing custom and preset models persists an explicit catalog, retaining credentials and endpoint", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await config.saveKey("deepseek", "keep-key-fixture");
        await config.saveEndpoint("deepseek", "https://keep.example/v1");
        await config.addModel("deepseek", "remove-me", "Remove Me");
        await config.removeModel("deepseek", "remove-me");
        expect(runtime.available.some(model => model.model === "remove-me")).toBe(false);
        for (const model of runtime.sources.deepseek.models) await config.removeModel("deepseek", model.id);
        expect(runtime.sources.deepseek.models).toEqual([]);
        expect(runtime.hasCredential("deepseek")).toBe(true);
        const loaded = loadHiCodeSettings({storage, cwd});
        expect(loaded.values.sources.deepseek.models).toEqual([]);
        expect(loaded.values.sources.deepseek.baseUrl).toBe("https://keep.example/v1");
        expect(parseEnv(await readFile(join(storage.hicodeHome, ".env"), "utf8"))).toMatchObject({DEEPSEEK_API_KEY: "keep-key-fixture"});
        await config.addModel("deepseek", "added-again", "");
        expect(runtime.sources.deepseek.models).toEqual([{id: "added-again", label: "added-again", imageInput: false}]);
    });
});

test("removing a model protects the live target and fixed fast/reviewer targets", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await expect(config.removeModel(runtime.target.source, runtime.target.model)).rejects.toThrow("in use");
        const model = runtime.sources.deepseek.models[0]!;
        const protectedConfig = createModelConfiguration(storage, cwd, runtime, [{source: "deepseek", model: model.id, label: model.label}]);
        await expect(protectedConfig.removeModel("deepseek", model.id)).rejects.toThrow("in use");
    });
});

test.each(["primary", "fast", "reviewer"] as const)("removing a saved %s model is rejected without changing settings", async slot => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        const model = runtime.sources.deepseek.models[0]!;
        await mkdir(storage.hicodeHome);
        const path = join(storage.hicodeHome, "settings.json");
        const before = JSON.stringify({models: {[slot]: {source: "deepseek", model: model.id}}});
        await writeFile(path, before);
        await expect(config.removeModel("deepseek", model.id)).rejects.toThrow(`referenced by ${slot}`);
        expect(await readFile(path, "utf8")).toBe(before);
    });
});

test("project references and concurrent catalog edits are preserved during removal", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        const model = runtime.sources.deepseek.models[0]!;
        await mkdir(join(cwd, ".hicode"));
        await writeFile(join(cwd, ".hicode/settings.json"), JSON.stringify({models: {primary: {source: "deepseek", model: model.id}}}));
        await expect(config.removeModel("deepseek", model.id)).rejects.toThrow("project settings");
        await config.addModel("deepseek", "temporary", "Temporary");
        await Promise.all([config.removeModel("deepseek", "temporary"), config.addModel("deepseek", "concurrent", "Concurrent")]);
        const loaded = loadHiCodeSettings({storage, cwd});
        expect(loaded.values.sources.deepseek.models.some(item => item.id === "temporary")).toBe(false);
        expect(loaded.values.sources.deepseek.models.some(item => item.id === "concurrent")).toBe(true);
    });
});

test("all Qwen entries can be removed once the saved main model uses another provider", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await config.saveKey("deepseek", "fixture-key");
        const target = runtime.available.find(model => model.source === "deepseek")!;
        await config.saveSelection(target);
        for (const model of runtime.sources.qwen.models) await config.removeModel("qwen", model.id);
        const loaded = loadHiCodeSettings({storage, cwd});
        expect(loaded.values.sources.qwen.models).toEqual([]);
        expect(loaded.values.models.primary).toEqual(target);
        expect(runtime.target).toEqual(target);
    });
});

test("reasoning persists per source/model; switching restores it and local default overrides user max", async () => {
    const keys = ["DASHSCOPE_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"] as const;
    const previous = keys.map(key => process.env[key]);
    try {
        await withTempProject(async (cwd, storage) => {
            const {runtime, config} = setup(storage, cwd);
            await config.saveKey("qwen", "ordinary-fixture");
            await config.saveKey("qwen-token-plan", "plan-fixture");
            const ordinary = runtime.available.find(item => item.source === "qwen" && item.model === "qwen3.8-flash")!;
            const plan = runtime.available.find(item => item.source === "qwen-token-plan" && item.model === "deepseek-v4.1-flash")!;
            await config.saveSelection({...ordinary, reasoning: "medium"});
            await config.saveSelection({...plan, reasoning: "max"});
            await config.saveSelection(runtime.available.find(item => item.source === ordinary.source && item.model === ordinary.model)!);
            expect(runtime.target.reasoning).toBe("medium");
            const loaded = loadHiCodeSettings({cwd, storage});
            expect(loaded.values.models.primary.reasoning).toBe("medium");
            expect(loaded.values.models.reasoning).toEqual(expect.arrayContaining([
                {source: ordinary.source, model: ordinary.model, effort: "medium"},
                {source: plan.source, model: plan.model, effort: "max"},
            ]));
            const before = await readFile(join(storage.hicodeHome, "settings.json"), "utf8");
            await expect(config.saveSelection({...ordinary, reasoning: "high"})).rejects.toThrow("not supported");
            expect(await readFile(join(storage.hicodeHome, "settings.json"), "utf8")).toBe(before);
            await mkdir(join(cwd, ".hicode"), {recursive: true});
            await writeFile(join(cwd, ".hicode", "settings.json"), JSON.stringify({models: {reasoning: [{source: plan.source, model: plan.model, effort: "max"}]}}));
            await config.saveSelection({...plan, reasoning: "default"});
            expect(loadHiCodeSettings({cwd, storage}).values.models.reasoning?.find(item => item.source === plan.source && item.model === plan.model)?.effort).toBe("default");
            expect(runtime.target.reasoning).toBeUndefined();
            expect(JSON.parse(await readFile(join(cwd, ".hicode", "settings.local.json"), "utf8")).models.reasoning).toEqual([{source: plan.source, model: plan.model, effort: "default"}]);
        });
    } finally {
        keys.forEach((key, index) => {if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];});
    }
});


test("GLM saves independent native choices per model and restores them after reload", async () => {
    const previous = process.env.GLM_API_KEY;
    try {
        await withTempProject(async (cwd, storage) => {
            const {runtime, config} = setup(storage, cwd);
            await config.saveKey("glm", "glm-fixture");
            const main = runtime.available.find(item => item.source === "glm" && item.model === "glm-5.2")!;
            const earlier = runtime.available.find(item => item.source === "glm" && item.model === "glm-5.3-flash")!;
            await config.saveSelection({...main, reasoning: "max"});
            await config.saveSelection({...earlier, reasoning: "low"});
            await config.saveSelection(runtime.available.find(item => item.source === "glm" && item.model === "glm-5.2")!);
            expect(runtime.target.reasoning).toBe("max");
            const loaded = loadHiCodeSettings({cwd, storage});
            expect(loaded.values.models.primary.reasoning).toBe("max");
            expect(loaded.values.models.reasoning).toEqual(expect.arrayContaining([
                {source: "glm", model: "glm-5.2", effort: "max"},
                {source: "glm", model: "glm-5.3-flash", effort: "low"},
            ]));
            await expect(config.saveSelection({...earlier, reasoning: "off"})).rejects.toThrow("not supported");
        });
    } finally {if (previous === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = previous;}
});
