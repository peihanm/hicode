import {waitForState} from "../helpers/waitForState.js";
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

test.each(["\u001b", "\u0003"])("/model back key %j discards reasoning draft and returns to a usable chat", async backKey => {
    await withTempProject(async cwd => {
        const current = {source: "qwen" as const, model: "qwen3.8-flash", label: "Qwen 3.8 Flash", reasoning: "medium" as const};
        const settings = createTestSettings();
        settings.models.reasoning = [{source: current.source, model: current.model, effort: current.reasoning}];
        const primaryModel = createPrimaryModelRuntime(current, settings.sources, [current], settings.models.reasoning);
        const resources = createTestRuntimeResources(cwd, {primaryModel, settings});
        let runs = 0;
        const instance = render(<App resources={resources} runAgentImpl={async () => {
            runs++;
            return {reply: "ok", reason: "completed", iterations: 1};
        }}/>);
        const press = async (key: string) => {
            // Ink updates input subscriptions in a passive effect after drawing the frame.
            await new Promise(resolve => setTimeout(resolve, 20));
            instance.stdin.write(key);
        };
        await waitForState(() => (instance.lastFrame() ?? "").includes("❯"), "chat input");
        await press("/model");
        await waitForState(() => (instance.lastFrame() ?? "").includes("/model"), "model command draft");
        await press("\r");
        await waitForState(() => (instance.lastFrame() ?? "").includes("◆ MODEL"), "model list");
        await press("\r");
        await waitForState(() => (instance.lastFrame() ?? "").includes("2/2 Reasoning"), "reasoning picker");
        await press("\u001b[B");
        await waitForState(() => (instance.lastFrame() ?? "").includes("›   xhigh"), "unsaved reasoning draft");
        await press(backKey);
        await waitForState(() => !(instance.lastFrame() ?? "").includes("2/2 Reasoning"), "return to model list");
        expect(instance.lastFrame()).toContain("◆ MODEL");
        expect(primaryModel.target).toEqual(current);
        await press(backKey);
        await waitForState(() => !(instance.lastFrame() ?? "").includes("◆ MODEL"), "return to chat");
        expect(primaryModel.target).toEqual(current);
        expect(runs).toBe(0);
        await press("continue");
        await waitForState(() => (instance.lastFrame() ?? "").includes("continue"), "chat draft after closing model picker");
        await press("\r");
        await waitForState(() => runs === 1, "chat still accepts a task");
    });
});

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

            expect(instance.lastFrame()).toContain("Reasoning");
            expect(instance.lastFrame()).toContain("default");
            expect(instance.lastFrame()).not.toContain("default (");
            for (let index = 0; index < 4; index++) {
                instance.stdin.write("\u001b[B");
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            instance.stdin.write("\r");
            await new Promise(resolve => setTimeout(resolve, 30));

            expect(primaryModel.target).toEqual({...deepseek, reasoning: "max"});
            expect(resources.fastModel).toBe(explicitFast ? fastBefore : deepseek.model);
            expect(instance.lastFrame()).toContain("DeepSeek Pro");
            expect(instance.lastFrame()).toContain("Switched to DeepSeek Pro.");
            expect(instance.lastFrame()).not.toContain("Fast model");
            expect(instance.lastFrame()).not.toContain("Main model");
            expect(instance.lastFrame()).not.toContain("Worked for");

            instance.stdin.write("验证真实上下文");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await waitForState(() => nextContext !== undefined, "the next Turn to capture the saved model");
            expect(nextContext?.provider).toBe("deepseek");
            expect(nextContext?.model).toBe("deepseek-pro");
            expect(nextContext?.reasoning).toBe("max");
            expect(nextContext?.fastReasoning).toBe(explicitFast ? undefined : "max");
            expect(nextContext?.fastModel).toBe(explicitFast ? fastBefore : deepseek.model);
            expect(nextContext?.fastProvider).toBe(explicitFast ? settings.models.fast!.source : deepseek.source);
            const saved = JSON.parse(await readFile(join(resources.storage.hicodeHome, "settings.json"), "utf8"));
            expect(saved.models.primary).toEqual({source: deepseek.source, model: deepseek.model});
            expect(nextContext?.contextSettings).toEqual(resources.settings.context);
        });
    });
});

test("English reasoning picker restores per-model preference, saves explicitly and Esc returns without saving", async () => {
    const {ModelDialog} = await import("../../src/ui/model/ModelDialog.js");
    const current = {source: "qwen" as const, model: "qwen3.8-flash", label: "Qwen 3.8 Flash", reasoning: "medium" as const};
    const saved: import("../../src/settings/types.js").ModelTargetSettings[] = [];
    const instance = render(<ModelDialog models={[current]} current={current} onSelect={async target => {saved.push(target);}} onClose={() => {}}/>);
    await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\r");await new Promise(resolve => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("2/2 Reasoning");
    expect(instance.lastFrame()).toContain("Qwen 3.8 Flash");
    expect(instance.lastFrame()).toContain("╭");
    expect(instance.lastFrame()).toContain("● saved");
    expect(instance.lastFrame()).toContain("default");
    expect(instance.lastFrame()).not.toContain("default (");
    expect(instance.lastFrame()).not.toContain("reasoning effort");
    expect(instance.lastFrame()).toContain("› ● medium");
    instance.stdin.write("\u001b");await new Promise(resolve => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("ALIBABA QWEN");expect(saved).toHaveLength(0);
    instance.stdin.write("\r");await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\u001b[B");await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\r");await new Promise(resolve => setTimeout(resolve, 20));
    expect(saved).toEqual([{...current, reasoning: "xhigh"}]);
});


test("reasoning card stays within a narrow terminal and navigation does not save a draft", async () => {
    const {ModelDialog} = await import("../../src/ui/model/ModelDialog.js");
    const {default: stringWidth} = await import("string-width");
    const current = {source: "qwen-token-plan" as const, model: "deepseek-v4.1-flash", label: "DeepSeek 4.1 Flash (Token Plan)", reasoning: "max" as const};
    let saves = 0;
    const dialog = <ModelDialog models={[current]} current={current} onSelect={async () => {saves++;}} onClose={() => {}}/>;
    const instance = render(dialog);
    Object.defineProperty(instance.stdout, "columns", {configurable: true, value: 30});
    instance.rerender(dialog);
    await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\r");await new Promise(resolve => setTimeout(resolve, 20));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("› ● max");
    expect(frame).not.toContain("default (");
    for (const line of frame.split("\n").filter(line => /[╭╰│]/.test(line))) expect(stringWidth(line)).toBeLessThanOrEqual(30);
    instance.stdin.write("\u001b[A");await new Promise(resolve => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("›   high");
    expect(instance.lastFrame()).toContain("● max");
    expect(saves).toBe(0);
});

test.each(["glm-5.2", "glm-5.3", "glm-5.3-flash"])("GLM reasoning picker exposes only confirmed choices: %s", async model => {
    const {ModelDialog} = await import("../../src/ui/model/ModelDialog.js");
    const current = {source: "glm" as const, model, label: model};
    const instance = render(<ModelDialog models={[current]} current={current} onSelect={async () => {}} onClose={() => {}}/>);
    await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\r");await new Promise(resolve => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("2/2 Reasoning");
    expect(instance.lastFrame()).toContain("default");
    expect(instance.lastFrame()).not.toContain("medium");
    expect(instance.lastFrame()).toContain("high");
    expect(instance.lastFrame()).toContain("max");
    if (model === "glm-5.2") expect(instance.lastFrame()).toContain("off");
    else {
        expect(instance.lastFrame()).not.toContain("off");
        expect(instance.lastFrame()).toContain("low");
    }
});
