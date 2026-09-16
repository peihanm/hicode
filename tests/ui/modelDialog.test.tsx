import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import type {ToolContext} from "../../src/tools/types.js";
import {createPrimaryModelRuntime} from "../../src/runtime/primaryModel.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {AppForTest as App} from "../helpers/AppForTest.js";

afterEach(() => cleanup());

describe("Model dialog", () => {
    test.each([true, false])("/model saves selection; explicit fast=%s", async explicitFast => {
        await withTempProject(async (cwd) => {
            const qwen = {
                source: "qwen" as const,
                provider: "qwen" as const,
                model: "qwen-primary",
                label: "Qwen Primary",
            };
            const deepseek = {
                source: "deepseek" as const,
                provider: "deepseek" as const,
                model: "deepseek-pro",
                label: "DeepSeek Pro",
            };
            const primaryModel = createPrimaryModelRuntime(
                qwen,
                createTestSettings().sources,
                [qwen, deepseek]
            );
            const settings = createTestSettings();
            if (!explicitFast) delete settings.models.fast;
            const resources = createTestRuntimeResources(cwd, {primaryModel, settings});
            const fastBefore = resources.fastModel;
            let nextContext: ToolContext | undefined;
            const instance = render(
                <App
                    resources={resources}
                    runAgentImpl={async (_input, _history, _onEvent, ctx) => {
                        nextContext = ctx;
                        return {reply: "ok", reason: "completed", iterations: 1};
                    }}
                />
            );
            await new Promise((resolve) => setTimeout(resolve, 20));

            instance.stdin.write("/model");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));

            const dialog = instance.lastFrame() ?? "";
            expect(dialog).toContain("◆ MODEL");
            expect(dialog).toContain("ALIBABA QWEN");
            expect(dialog).toContain("DEEPSEEK");
            expect(dialog).toContain("Qwen Primary");
            expect(dialog).toContain("DeepSeek Pro");
            expect(dialog).not.toContain("Fast model");

            instance.stdin.write("\u001b[B");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));

            expect(primaryModel.target).toEqual(deepseek);
            expect(resources.fastModel).toBe(explicitFast ? fastBefore : deepseek.model);
            expect(instance.lastFrame()).toContain("DeepSeek Pro");
            expect(instance.lastFrame()).toContain("Switched to DeepSeek Pro.");
            expect(instance.lastFrame()).not.toContain("Fast model");
            expect(instance.lastFrame()).not.toContain("Main model");
            expect(instance.lastFrame()).not.toContain("Worked for");

            instance.stdin.write("验证真实上下文");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(nextContext?.provider).toBe("deepseek");
            expect(nextContext?.model).toBe("deepseek-pro");
            expect(nextContext?.fastModel).toBe(explicitFast ? fastBefore : deepseek.model);
            expect(nextContext?.fastProvider).toBe(explicitFast ? settings.models.fast!.source : deepseek.source);
            const saved = JSON.parse(await readFile(join(resources.storage.hicodeHome, "settings.json"), "utf8"));
            expect(saved.models.primary).toEqual({source: deepseek.source, model: deepseek.model});
            expect(nextContext?.contextSettings).toEqual(resources.settings.context);
        });
    });
});
