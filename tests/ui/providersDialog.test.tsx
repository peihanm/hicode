import {afterEach, expect, spyOn, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {ProvidersDialog} from "../../src/ui/providers/ProvidersDialog.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {createModelConfiguration} from "../../src/settings/modelConfiguration.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";
import {withTempProject} from "../helpers/tempProject.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";

const oldKey = process.env.GLM_API_KEY;
afterEach(() => {cleanup(); if (oldKey === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = oldKey;});
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(check: () => boolean) {for (let i = 0; i < 100 && !check(); i++) await tick(); expect(check()).toBe(true);}

test("provider form masks secrets, cancels without saving, then adds a model with an optional label", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = resolveHiCodeSettings([]).values;
        const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources, [settings.models.primary]);
        const config = createModelConfiguration(storage, cwd, runtime);
        const app = render(<ProvidersDialog runtime={runtime} configuration={config} onSelect={async () => {}} onClose={() => {}}/>);
        await tick();
        app.stdin.write("\r"); await tick(); // GLM
        app.stdin.write("\r"); await tick(); // key
        const secret = "ui-secret-fixture-only";
        app.stdin.write(secret); await tick();
        expect(app.lastFrame()).toContain("•");
        expect(app.frames.join("\n")).not.toContain(secret);
        app.stdin.write("\u001b"); await tick();
        await expect(readFile(join(storage.hicodeHome, ".env"), "utf8")).rejects.toThrow();
        app.stdin.write("\r"); await tick();
        app.stdin.write(secret); await tick();
        app.stdin.write("\r");
        await until(() => app.lastFrame()?.includes("Key saved") ?? false);
        expect(await readFile(join(storage.hicodeHome, ".env"), "utf8")).toContain(secret);
        for (let i = 0; i < 6 && !app.lastFrame()?.includes("› Add model"); i++) {app.stdin.write("\u001b[B"); await tick();}
        expect(app.lastFrame()).toContain("› Add model");
        app.stdin.write("\r"); await tick();
        app.stdin.write("custom-new-model"); await tick();
        app.stdin.write("\r"); await tick();
        expect(app.lastFrame()).toContain("Display name");
        expect(app.lastFrame()).toContain("Image input: Disabled");
        app.stdin.write("\t"); await tick();
        expect(app.lastFrame()).toContain("Image input: Enabled");
        app.stdin.write("\r");
        await until(() => app.lastFrame()?.includes("Saved. Available immediately.") ?? false);
        expect(runtime.available).toContainEqual({source: "glm", model: "custom-new-model", label: "custom-new-model"});
        expect(runtime.sources.glm.models.find(model => model.id === "custom-new-model")?.imageInput).toBe(true);
        expect(app.frames.join("\n")).not.toContain(secret);
        expect(await readFile(join(storage.hicodeHome, "settings.json"), "utf8")).not.toContain(secret);
        app.unmount();
    });
});

test("/providers is a local panel and never starts the model or a task timer", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        let calls = 0;
        const app = render(<AppForTest resources={resources} runAgentImpl={async () => {calls++; return {reason: "completed", reply: "unexpected", iterations: 1};}}/>);
        await tick(); app.stdin.write("/providers"); await tick(); app.stdin.write("\r");
        await until(() => app.lastFrame()?.includes("◆ PROVIDERS") ?? false);
        app.stdin.write("\u001b"); await tick();
        expect(calls).toBe(0);
        expect(app.lastFrame()).not.toContain("Worked for");
        await resources.close(); app.unmount();
    });
});

test("remove-model picker confirms the exact ID, supports cancelling, and refreshes after deletion", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = resolveHiCodeSettings([]).values;
        const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources);
        const config = createModelConfiguration(storage, cwd, runtime);
        const id = runtime.sources.glm.models[0]!.id;
        const app = render(<ProvidersDialog runtime={runtime} configuration={config} onSelect={async () => {}} onClose={() => {}}/>);
        await tick(); app.stdin.write("\r"); await tick();
        for (let index = 0; index < 3; index++) {app.stdin.write("\u001b[B"); await tick();}
        app.stdin.write("\r"); await tick();
        expect(app.lastFrame()).toContain("Select a model to remove");
        app.stdin.write("\r"); await tick();
        expect(app.lastFrame()).toContain(id);
        expect(app.lastFrame()).toContain("› Cancel");
        app.stdin.write("\r"); await tick();
        expect(runtime.sources.glm.models.some(model => model.id === id)).toBe(true);
        app.stdin.write("\r"); await tick();
        app.stdin.write("\u001b[B"); await tick();
        app.stdin.write("\r");
        await until(() => app.lastFrame()?.includes("Model removed.") ?? false);
        expect(runtime.sources.glm.models.some(model => model.id === id)).toBe(false);
        expect(app.lastFrame()).not.toContain(id);
        app.unmount();
    });
});

test("first setup saves Qwen, chooses its model and returns to chat without Escape", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = resolveHiCodeSettings([]).values;
        const keys = Object.values(settings.sources).map(source => {
            source.apiKeyEnv = `HICODE_PROVIDER_FLOW_${source.id.toUpperCase()}`;
            return {name: source.apiKeyEnv, previous: process.env[source.apiKeyEnv]};
        });
        for (const key of keys) delete process.env[key.name];
        const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources);
        const resources = createTestRuntimeResources(cwd, {storage, settings, primaryModel: runtime});
        let calls = 0;
        const app = render(<AppForTest resources={resources} runAgentImpl={async () => {calls++; return {reason: "completed", reply: "unexpected", iterations: 1};}}/>);
        try {
            await until(() => app.lastFrame()?.includes("◆ PROVIDERS") ?? false);
            app.stdin.write("\u001b[B"); await tick(); // Qwen
            app.stdin.write("\r"); await tick();
            app.stdin.write("\r"); await tick(); // key
            const secret = "first-setup-qwen-fixture";
            app.stdin.write(secret); await tick(); app.stdin.write("\r");
            await until(() => app.lastFrame()?.includes("› Choose model and start") ?? false);
            expect(app.lastFrame()).toContain("Key saved");
            app.stdin.write("\r");
            await until(() => app.lastFrame()?.includes("◆ MODEL") ?? false);
            expect(app.lastFrame()).toContain("ALIBABA QWEN");
            expect(app.lastFrame()).not.toContain("ZHIPU GLM");
            await tick();
            app.stdin.write("\u001b[B"); await tick();
            expect(app.lastFrame()).toMatch(/›\s+Qwen 3\.8 Max/);
            app.stdin.write("\r");
            await until(() => app.lastFrame()?.includes("Ask HiCode") ?? false);
            const selected = settings.sources.qwen.models[1]!;
            expect(runtime.target).toMatchObject({source: "qwen", model: selected.id});
            const saved = JSON.parse(await readFile(join(storage.hicodeHome, "settings.json"), "utf8"));
            expect(saved.models.primary).toEqual({source: "qwen", model: selected.id});
            expect(calls).toBe(0);
            expect(app.frames.join("\n")).not.toContain(secret);
            expect(app.lastFrame()).not.toContain("Worked for");
        } finally {
            app.unmount(); await resources.close();
            for (const key of keys) {
                if (key.previous === undefined) delete process.env[key.name];
                else process.env[key.name] = key.previous;
            }
        }
    });
});

test("provider list has a visible finish action and failed selection stays open", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = resolveHiCodeSettings([]).values;
        const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources, [settings.models.primary]);
        const config = createModelConfiguration(storage, cwd, runtime);
        let closed = 0;
        const app = render(<ProvidersDialog runtime={runtime} configuration={config}
            onSelect={async () => {throw new Error("Fixture: settings are read-only");}} onClose={() => {closed++;}}/>);
        await tick();
        expect(app.lastFrame()).toContain("Choose model and start");
        expect(app.lastFrame()).toContain("Back to chat");
        for (let index = 0; index < 4; index++) {app.stdin.write("\u001b[B"); await tick();}
        app.stdin.write("\r"); await tick();
        expect(app.lastFrame()).toContain("◆ MODEL");
        app.stdin.write("\r");
        await until(() => app.lastFrame()?.includes("Fixture: settings are read-only") ?? false);
        expect(closed).toBe(0);
        app.stdin.write("\u001b"); await tick();
        expect(app.lastFrame()).toContain("› Choose model and start");
        app.stdin.write("\u001b[B"); await tick();
        expect(app.lastFrame()).toContain("› Back to chat");
        app.stdin.write("\r"); await tick();
        expect(closed).toBe(1);
        app.unmount();
    });
});

test.each(["providers", "key", "model"] as const)("incomplete setup: Escape from %s starts application shutdown", async page => {
    await withTempProject(async (cwd, storage) => {
        const settings = resolveHiCodeSettings([]).values;
        const available = page === "model" ? [{source: "deepseek" as const, model: "deepseek-flash", label: "DeepSeek Flash"}] : [];
        const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources, available);
        const resources = createTestRuntimeResources(cwd, {storage, settings, primaryModel: runtime});
        const shutdown = spyOn(resources, "beginShutdown");
        const app = render(<AppForTest resources={resources}/>);
        try {
            await until(() => app.lastFrame()?.includes(page === "model" ? "◆ MODEL" : "◆ PROVIDERS") ?? false);
            await tick();
            if (page === "key") {
                app.stdin.write("\r"); await tick();
                app.stdin.write("\r"); await tick();
                app.stdin.write("unsaved-fixture-key"); await tick();
            }
            expect(app.lastFrame()?.toLowerCase()).toContain("esc exit");
            if (page === "providers") {
                expect(app.lastFrame()).toContain("Exit HiCode");
                expect(app.lastFrame()).not.toContain("Back to chat");
            }
            app.stdin.write("\u001b");
            await until(() => shutdown.mock.calls.length === 1);
            expect(runtime.isConfigured).toBe(false);
            await expect(readFile(join(storage.hicodeHome, ".env"), "utf8")).rejects.toThrow();
        } finally {
            app.unmount(); await resources.close(); shutdown.mockRestore();
        }
    });
});

test("configured model: Escape closes provider management without exiting", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        const shutdown = spyOn(resources, "beginShutdown");
        const app = render(<AppForTest resources={resources}/>);
        try {
            await tick(); app.stdin.write("/providers"); await tick(); app.stdin.write("\r");
            await until(() => app.lastFrame()?.includes("◆ PROVIDERS") ?? false);
            await tick();
            expect(app.lastFrame()).toContain("Back to chat");
            expect(app.lastFrame()).toContain("Esc back");
            app.stdin.write("\u001b");
            await until(() => app.lastFrame()?.includes("Ask HiCode") ?? false);
            expect(shutdown).not.toHaveBeenCalled();
        } finally {
            app.unmount(); await resources.close(); shutdown.mockRestore();
        }
    });
});
