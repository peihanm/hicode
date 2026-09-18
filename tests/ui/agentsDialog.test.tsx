import {createSubagentCatalog, loadCustomAgentDefinitions} from "../../src/subagents/index.js";
import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {AppForTest as App} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createSubagentRegistry} from "../../src/subagents/index.js";
import {AgentsDialog} from "../../src/ui/agents/AgentsDialog.js";
import stringWidth from "string-width";

afterEach(() => cleanup());
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

describe("Agents dialog", () => {
    test("agent list and details reflow without a box; built-in permissions stay clear", async () => {
        await withTempProject(async cwd => {
            const resources = createTestRuntimeResources(cwd);
            const view = render(<AgentsDialog manager={resources.agentDefinitions}
                authoring={resources.agentAuthoring} catalog={resources.subagents}
                fastModel="Qwen 3.8 Flash" onClose={() => {}}/>);
            let columns = 100;
            Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
            try {
                for (const width of [100, 56, 32]) {
                    columns = width;
                    view.stdout.emit("resize");
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const list = view.lastFrame() ?? "";
                    expect(list).toContain("Explore");
                    expect(list).toContain("Worker");
                    expect(list).not.toMatch(/[╭╰│]/);
                    expect(list).not.toContain("Current revision");
                    expect(list).not.toContain("0 loading issues");
                    expect(list.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
                    view.stdin.write("\r"); await tick();
                    const detail = view.lastFrame() ?? "";
                    expect(detail.replace(/\s+/g, " ")).toContain("Definition cannot be edited");
                    expect(detail).toContain("Read-only");
                expect(detail).not.toContain("Turn limit");
                    expect(detail).toContain("Tools · 4");
                    expect(detail).not.toContain("Root");
                    expect(detail.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
                    view.stdin.write("\u001b"); await tick();
                }
                view.stdin.write("\u001b[B"); await tick();
                view.stdin.write("\r"); await tick();
                const worker = view.lastFrame() ?? "";
                expect(worker).toContain("Worker");
                expect(worker).toContain("Inherited");
                expect(worker).not.toContain("read-only");
            } finally {view.unmount(); await resources.close();}
        });
    });

    test("manual creation previews all settings and edits one field without a wizard", async () => {
        await withTempProject(async cwd => {
            const resources = createTestRuntimeResources(cwd);
            const view = render(<AgentsDialog manager={resources.agentDefinitions}
                authoring={resources.agentAuthoring} catalog={resources.subagents} fastModel="fast" onClose={() => {}}/>);
            const press = async (key: string) => {view.stdin.write(key); await tick();};
            try {
                await tick();
                for (const key of ["\u001b[B", "\u001b[B", "\r", "\u001b[B", "\r"]) await press(key);
                expect(view.lastFrame()).toContain("New Agent");
                expect(view.lastFrame()).toContain("Save Agent");
                expect(view.lastFrame()).toContain("Tools · Inherited");
                expect(view.lastFrame()).not.toContain("Step 1/");
                await press("\u001b[B"); await press("\r");
                await press("reviewer"); await press("\r");
                expect(view.lastFrame()).toContain("reviewer");
                expect(view.lastFrame()).toContain("Save Agent");
                // Esc from a field returns to the preview; it does not save the definition.
                await press("\u001b[B"); await press("\r"); await press("\u001b");
                expect(view.lastFrame()).toContain("Save Agent");
                expect(resources.subagents.has("reviewer")).toBe(false);
            } finally {view.unmount(); await resources.close();}
        });
    });

    test("long agent lists stay bounded and keep the last actions reachable", async () => {
        await withTempProject(async cwd => {
            const subagents = createSubagentRegistry({definitions: Array.from({length: 10}, (_, index) => ({
                agentType: `reviewer-${index}`, source: "project" as const,
                path: `${cwd}/.hicode/agents/reviewer-${index}.md`,
                whenToUse: "Review a focused module", systemPrompt: "Review only.",
                allowedTools: ["read_file"],
            })), issues: []});
            const resources = createTestRuntimeResources(cwd, {subagents});
            let closed = false;
            const view = render(<AgentsDialog manager={resources.agentDefinitions}
                authoring={resources.agentAuthoring} catalog={resources.subagents}
                fastModel="Qwen 3.8 Flash" onClose={() => {closed = true;}}/>);
            try {
                await tick();
                expect(view.lastFrame()).toContain("12 available");
                expect(view.lastFrame()).not.toContain("reviewer-9");
                for (let index = 0; index < 11; index++) {
                    view.stdin.write("\u001b[B"); await tick();
                }
                expect(view.lastFrame()).toContain("❯ reviewer-9");
                for (let index = 0; index < 3; index++) {
                    view.stdin.write("\u001b[B"); await tick();
                }
                expect(view.lastFrame()).toContain("❯ Close");
                view.stdin.write("\r"); await tick();
                expect(closed).toBe(true);
            } finally {view.unmount(); await resources.close();}
        });
    });

    test("/agents 打开交互管理界面，Esc 返回主输入框", async () => {
        await withTempProject(async (cwd) => {
            const instance = render(
                <App
                    resources={createTestRuntimeResources(cwd)}
                />
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            instance.stdin.write("/agents");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));

            const dialog = instance.lastFrame() ?? "";
            expect(dialog).toContain("◆ Agents");
            expect(dialog).not.toContain("GeneralPurpose");
            expect(dialog).toContain("Create Agent");
            expect(dialog).toContain("Reload Agent files");

            instance.stdin.write("\u001b");
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(instance.lastFrame()).toContain("new session");
        });
    });

    test("管理界面提供加载问题入口", async () => {
        await withTempProject(async (cwd) => {
            const subagents = createSubagentRegistry({
                definitions: [],
                issues: [{
                    source: "project",
                    path: `${cwd}/.hicode/agents/broken.md`,
                    severity: "error",
                    field: "tools",
                    message: "Tool does not exist in this Runtime: missing",
                }],
            });
            const instance = render(
                <App
                    resources={createTestRuntimeResources(cwd, {subagents})}
                />
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            instance.stdin.write("/agents");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(instance.lastFrame()).toContain("Loading issues (1)");
        });
    });
});

test("generated candidates go straight to preview and save without model, turn or tool fields", async () => {
    await withTempProject(async (cwd, storage) => {
        const catalog = createSubagentCatalog({load: () => loadCustomAgentDefinitions(storage, cwd, ["project"])});
        const resources = createTestRuntimeResources(cwd, {storage, subagents: catalog, agentAuthoring: {async generate() {
            return {name: "reviewer", description: "Review real defects", systemPrompt: "Report evidence and do not edit files.", readOnly: true};
        }}});
        const view = render(<AgentsDialog manager={resources.agentDefinitions} authoring={resources.agentAuthoring}
            catalog={resources.subagents} fastModel="fast" onClose={() => {}}/>);
        const press = async (key: string) => {view.stdin.write(key); await tick();};
        try {
            await tick();
            for (const key of ["\u001b[B", "\u001b[B", "\r", "\r", "Create a reviewer", "\r"]) await press(key);
            expect(view.lastFrame()).toContain("Save Agent");
            expect(view.lastFrame()).toContain("Read-only");
            expect(view.lastFrame()).not.toContain("Maximum turns");
            expect(view.lastFrame()).not.toContain("Step 1/");
            await press("\r");
            for (let attempt = 0; attempt < 100 && !resources.subagents.has("reviewer"); attempt++) await tick();
            expect(view.lastFrame()).toContain("Created reviewer");
            expect(resources.subagents.has("reviewer")).toBe(true);
            const definition = resources.subagents.get("reviewer")!.definition;
            expect(definition.allowedTools).toBeUndefined();
            expect(definition.readOnly).toBe(true);
            expect(definition).not.toHaveProperty("model");
            expect(definition).not.toHaveProperty("maxIterations");
        } finally {view.unmount(); await resources.close();}
    });
});
