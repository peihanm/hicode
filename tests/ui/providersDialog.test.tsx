import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {ProvidersDialog} from "../../src/ui/providers/ProvidersDialog.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {createModelConfiguration} from "../../src/settings/modelConfiguration.js";
import {resolveHiCodeSettings} from "../../src/settings/index.js";
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
        const runtime = createPrimaryModelRuntime(settings.models.primary, settings.sources);
        const config = createModelConfiguration(storage, cwd, runtime);
        const app = render(<ProvidersDialog runtime={runtime} configuration={config} onClose={() => {}}/>);
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
        app.stdin.write("\u001b[B"); await tick();
        app.stdin.write("\u001b[B"); await tick();
        app.stdin.write("\r"); await tick();
        app.stdin.write("custom-new-model"); await tick();
        app.stdin.write("\r"); await tick();
        expect(app.lastFrame()).toContain("Display name");
        app.stdin.write("\r");
        await until(() => app.lastFrame()?.includes("Saved. Available immediately.") ?? false);
        expect(runtime.available).toContainEqual({source: "glm", model: "custom-new-model", label: "custom-new-model"});
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
        const app = render(<ProvidersDialog runtime={runtime} configuration={config} onClose={() => {}}/>);
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
