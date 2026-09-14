import {afterEach, expect, test} from "bun:test";
import {mkdir, readFile, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {parse as parseEnv} from "dotenv";
import {loadEnv} from "../../src/cli/env.js";
import {createModelConfiguration} from "../../src/settings/modelConfiguration.js";
import {loadPillarSettings, resolvePillarSettings} from "../../src/settings/index.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {withTempProject} from "../helpers/tempProject.js";

const prior = process.env.DEEPSEEK_API_KEY;
const currentKey = (): string | undefined => process.env.DEEPSEEK_API_KEY;
afterEach(() => {if (prior === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prior;});

function setup(storage: Parameters<typeof createModelConfiguration>[0], cwd: string) {
    const settings = resolvePillarSettings([]).values;
    const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources);
    return {runtime, config: createModelConfiguration(storage, cwd, runtime)};
}

test("Key, custom model and endpoint save safely, refresh immediately and selection survives restart", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await mkdir(storage.pillarHome);
        await writeFile(join(storage.pillarHome, ".env"), "# retained\nOTHER_KEY=unrelated-fixture\n");
        await writeFile(join(storage.pillarHome, "settings.json"), '{"memory":{"enabled":false},"custom":{"keep":true}}');
        const path = await config.saveKey("deepseek", "fixture-secret");
        expect(path).toBe(join(storage.pillarHome, ".env"));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(parseEnv(await readFile(path, "utf8"))).toEqual({OTHER_KEY: "unrelated-fixture", DEEPSEEK_API_KEY: "fixture-secret"});
        expect(runtime.available.some(model => model.source === "deepseek")).toBe(true);
        await config.addModel("deepseek", "custom/model", "My Model");
        await config.saveEndpoint("deepseek", "https://proxy.example/v1");
        const selected = runtime.available.find(model => model.model === "custom/model")!;
        await config.saveSelection(selected);
        expect(runtime.target).toEqual(selected);
        expect(runtime.sources.deepseek.baseUrl).toBe("https://proxy.example/v1");
        const serialized = await readFile(join(storage.pillarHome, "settings.json"), "utf8");
        expect(serialized).not.toContain("fixture-secret");
        expect(JSON.parse(serialized)).toMatchObject({memory: {enabled: false}, custom: {keep: true}});
        const loaded = loadPillarSettings({cwd, storage});
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
        const loaded = loadPillarSettings({cwd, storage});
        expect(loaded.values.sources.deepseek.models).toEqual(expect.arrayContaining([{id: "extra-one", label: "extra-one"}, {id: "extra-two", label: "Second"}]));
    });
});

test("project Key and primary override update their effective local files without replacing shared settings", async () => {
    await withTempProject(async (cwd, storage) => {
        const {runtime, config} = setup(storage, cwd);
        await writeFile(join(cwd, ".env"), "DEEPSEEK_API_KEY=old-fixture\nAPP_MODE=dev\n");
        expect(await config.saveKey("deepseek", "new-fixture")).toBe(join(cwd, ".env"));
        expect(parseEnv(await readFile(join(cwd, ".env"), "utf8"))).toMatchObject({APP_MODE: "dev", DEEPSEEK_API_KEY: "new-fixture"});
        await mkdir(join(cwd, ".pillar"));
        const shared = '{"models":{"primary":{"source":"qwen","model":"qwen3.8-flash"}}}';
        await writeFile(join(cwd, ".pillar/settings.json"), shared);
        await writeFile(join(cwd, ".pillar/settings.local.json"), '{"permissions":{"allow":["read_file"]}}');
        const selected = runtime.available.find(item => item.source === "deepseek")!;
        await config.saveSelection(selected);
        expect(await readFile(join(cwd, ".pillar/settings.json"), "utf8")).toBe(shared);
        const local = JSON.parse(await readFile(join(cwd, ".pillar/settings.local.json"), "utf8"));
        expect(local.permissions.allow).toEqual(["read_file"]);
        expect(loadPillarSettings({storage, cwd}).values.models.primary).toEqual(selected);
    });
});

test("unsafe files, corrupt settings, duplicate or invalid values fail without overwriting", async () => {
    await withTempProject(async (cwd, storage) => {
        const {config} = setup(storage, cwd);
        await mkdir(storage.pillarHome);
        const path = join(storage.pillarHome, "settings.json");
        await writeFile(path, "{corrupt");
        await expect(config.addModel("deepseek", "test", "Test")).rejects.toThrow("Invalid settings");
        expect(await readFile(path, "utf8")).toBe("{corrupt");
        await expect(config.saveEndpoint("deepseek", "https://secret@example.com/v1")).rejects.toThrow("without credentials");
        await expect(config.saveKey("deepseek", "bad\nKEY=injection")).rejects.toThrow("single-line");
        const outside = join(cwd, "untouched"); await writeFile(outside, "keep");
        await symlink(outside, join(storage.pillarHome, ".env"));
        await expect(config.saveKey("deepseek", "test-key")).rejects.toThrow("safely read");
        expect(await readFile(outside, "utf8")).toBe("keep");
    });
});

test("CLI accepts no env file; project values win and user credentials fill missing entries", async () => {
    await withTempProject(async (cwd, storage) => {
        expect(() => loadEnv(storage, cwd)).not.toThrow();
        delete process.env.DEEPSEEK_API_KEY;
        await mkdir(storage.pillarHome);
        await writeFile(join(storage.pillarHome, ".env"), "DEEPSEEK_API_KEY=user-fixture\n");
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
        await mkdir(storage.pillarHome);
        const path = join(storage.pillarHome, ".env");
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
        const loaded = loadPillarSettings({storage, cwd});
        expect(loaded.values.sources.deepseek.models).toEqual([]);
        expect(loaded.values.sources.deepseek.baseUrl).toBe("https://keep.example/v1");
        expect(parseEnv(await readFile(join(storage.pillarHome, ".env"), "utf8"))).toMatchObject({DEEPSEEK_API_KEY: "keep-key-fixture"});
        await config.addModel("deepseek", "added-again", "");
        expect(runtime.sources.deepseek.models).toEqual([{id: "added-again", label: "added-again"}]);
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
        await mkdir(storage.pillarHome);
        const path = join(storage.pillarHome, "settings.json");
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
        await mkdir(join(cwd, ".pillar"));
        await writeFile(join(cwd, ".pillar/settings.json"), JSON.stringify({models: {primary: {source: "deepseek", model: model.id}}}));
        await expect(config.removeModel("deepseek", model.id)).rejects.toThrow("project settings");
        await config.addModel("deepseek", "temporary", "Temporary");
        await Promise.all([config.removeModel("deepseek", "temporary"), config.addModel("deepseek", "concurrent", "Concurrent")]);
        const loaded = loadPillarSettings({storage, cwd});
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
        const loaded = loadPillarSettings({storage, cwd});
        expect(loaded.values.sources.qwen.models).toEqual([]);
        expect(loaded.values.models.primary).toEqual(target);
        expect(runtime.target).toEqual(target);
    });
});
