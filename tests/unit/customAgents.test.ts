import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
    createSubagentRegistry,
    loadCustomAgentDefinitions,
    validateCustomAgentTools,
    type AgentDefinition,
} from "../../src/subagents/index.js";
import {parseCustomAgentDocument} from "../../src/subagents/load.js";
import {
    CUSTOM_AGENT_FORBIDDEN_TOOLS,
} from "../../src/subagents/custom.js";
import {withTempProject} from "../helpers/tempProject.js";

function definition(
    agentType: string,
    source: "user" | "project",
    path: string
): AgentDefinition {
    return {
        agentType,
        source,
        path,
        whenToUse: `${agentType} description`,
        systemPrompt: `${agentType} prompt`,
        allowedTools: ["read_file"],
        model: "inherit",
        maxIterations: 12,
    };
}

describe("custom agent definitions", () => {
    test("解析 YAML frontmatter、工具数组、模型和正文", () => {
        const parsed = parseCustomAgentDocument({
            source: "project",
            path: "/repo/.pillar/agents/reviewer.md",
            raw: `---
name: code-reviewer
description: 审查实现和回归风险
tools:
  - read_file
  - grep
  - read_file
model: fast
max_iterations: 9
---

你是严格的代码审查 Agent。`,
        });

        expect(parsed.issues).toEqual([]);
        expect(parsed.definition).toMatchObject({
            agentType: "code-reviewer",
            source: "project",
            allowedTools: ["read_file", "grep"],
            model: "fast",
            maxIterations: 9,
            systemPrompt: "你是严格的代码审查 Agent。",
        });
    });

    test("非法字段产生 error，未知字段 warning 不阻止合法定义", () => {
        const warning = parseCustomAgentDocument({
            source: "user",
            path: "/home/.pillar/agents/reviewer.md",
            raw: `---
name: reviewer
description: review
tools: [read_file]
background: true
---
review carefully`,
        });
        expect(warning.definition?.agentType).toBe("reviewer");
        expect(warning.issues).toEqual([
            expect.objectContaining({
                severity: "warning",
                field: "background",
            }),
        ]);

        const invalid = parseCustomAgentDocument({
            source: "project",
            path: "/repo/.pillar/agents/bad.md",
            raw: `---
name: 1bad
description: bad
tools: []
max_iterations: 99
---
body`,
        });
        expect(invalid.definition).toBeUndefined();
        expect(invalid.issues.filter((item) => item.severity === "error").length)
            .toBeGreaterThanOrEqual(3);
    });

    test("内置名称保留，Markdown 定义不能覆盖", () => {
        const customExplore = definition(
            "explore",
            "project",
            "/project/explore.md"
        );
        const registry = createSubagentRegistry({
            definitions: [customExplore],
            issues: [],
        });

        expect(registry.get("Explore")?.definition.source).toBe("builtin");
        expect(registry.issues).toEqual([
            expect.objectContaining({severity: "error", field: "name"}),
        ]);
        expect(Object.isFrozen(registry)).toBe(true);
        expect(Object.isFrozen(registry.listDefinitions())).toBe(true);
        expect(Object.isFrozen(registry.get("Explore")?.definition)).toBe(true);
        expect(Object.isFrozen(
            registry.get("Explore")?.definition.allowedTools
        )).toBe(true);
    });

    test("禁止控制面工具和当前不存在的工具使定义不激活", () => {
        expect(CUSTOM_AGENT_FORBIDDEN_TOOLS.has("agent")).toBe(true);
        expect(CUSTOM_AGENT_FORBIDDEN_TOOLS.has("memory")).toBe(true);
        const forbidden = {
            ...definition("writer", "project", "/project/writer.md"),
            allowedTools: ["read_file", "agent"],
        };
        const missing = {
            ...definition("browser", "project", "/project/browser.md"),
            allowedTools: ["mcp__missing__snapshot"],
        };
        const validated = validateCustomAgentTools(
            {definitions: [forbidden, missing], issues: []},
            ["read_file", "agent"]
        );

        expect(validated.definitions).toEqual([]);
        expect(validated.issues).toHaveLength(2);
        expect(validated.issues[0]?.message).toContain("禁止使用工具");
        expect(validated.issues[1]?.message).toContain("不存在工具");
    });

    test("生产 loader 从项目 .pillar/agents 读取定义并隔离坏文件", async () => {
        await withTempProject(async (cwd, storage) => {
            const directory = join(cwd, ".pillar", "agents");
            await mkdir(directory, {recursive: true});
            await writeFile(
                join(directory, "unique-r12-agent.md"),
                `---
name: unique-r12-agent
description: project test agent
tools: [read_file]
---
project prompt`,
                "utf8"
            );
            await writeFile(join(directory, "broken.md"), "---\nname: broken", "utf8");

            const loaded = await loadCustomAgentDefinitions(storage, cwd);
            expect(
                loaded.definitions.some(
                    (item) => item.agentType === "unique-r12-agent"
                )
            ).toBe(true);
            expect(
                loaded.issues.some((item) => item.path.endsWith("broken.md"))
            ).toBe(true);
        });
    });

    test("隔离进程从临时 HOME 加载用户定义并由项目定义覆盖", async () => {
        await withTempProject(async (root) => {
            const home = join(root, "home");
            const cwd = join(root, "project");
            const userDirectory = join(home, ".pillar", "agents");
            const projectDirectory = join(cwd, ".pillar", "agents");
            await Promise.all([
                mkdir(userDirectory, {recursive: true}),
                mkdir(projectDirectory, {recursive: true}),
            ]);
            await writeFile(join(userDirectory, "reviewer.md"), `---
name: reviewer
description: user reviewer
tools: [read_file]
---
user prompt`, "utf8");
            await writeFile(join(userDirectory, "user-only.md"), `---
name: user-only
description: user only
tools: [grep]
---
user only prompt`, "utf8");
            await writeFile(join(projectDirectory, "reviewer.md"), `---
name: Reviewer
description: project reviewer
tools: [read_file]
---
project prompt`, "utf8");
            const moduleUrl = pathToFileURL(
                resolve("src/subagents/load.ts")
            ).href;
            const layoutUrl = pathToFileURL(
                resolve("src/persistence/layout.ts")
            ).href;
            const script = [
                `import {loadCustomAgentDefinitions} from ${JSON.stringify(moduleUrl)};`,
                `import {createPillarStorageLayout} from ${JSON.stringify(layoutUrl)};`,
                `const storage = createPillarStorageLayout({pillarHome: ${JSON.stringify(join(home, ".pillar"))}});`,
                `const loaded = await loadCustomAgentDefinitions(storage, ${JSON.stringify(cwd)});`,
                "console.log(JSON.stringify(loaded));",
            ].join("\n");
            const child = Bun.spawn([process.execPath, "-e", script], {
                cwd: resolve("."),
                env: {...process.env, HOME: home},
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            if (exitCode !== 0) {
                throw new Error(`isolated loader failed: ${stderr}`);
            }
            const loaded = JSON.parse(stdout) as {
                definitions: AgentDefinition[];
                issues: Array<{message: string}>;
            };
            expect(loaded.definitions.map((item) => [
                item.agentType,
                item.source,
            ])).toEqual([
                ["Reviewer", "project"],
                ["user-only", "user"],
            ]);
            expect(loaded.issues.some((item) =>
                item.message.includes("覆盖用户定义")
            )).toBe(true);
        });
    });

    test("超大定义文件不会激活", async () => {
        await withTempProject(async (cwd, storage) => {
            const directory = join(cwd, ".pillar", "agents");
            await mkdir(directory, {recursive: true});
            await writeFile(
                join(directory, "oversized.md"),
                "x".repeat(64_001),
                "utf8"
            );

            const loaded = await loadCustomAgentDefinitions(storage, cwd);
            const oversized = loaded.issues.find((item) =>
                item.path.endsWith("oversized.md")
            );
            expect(oversized?.message).toContain("64000 bytes");
            expect(loaded.definitions.some((item) =>
                item.agentType === "oversized"
            )).toBe(false);
        });
    });

    test("合并来源后最多激活 64 个定义", async () => {
        await withTempProject(async (cwd, storage) => {
            const userDirectory = join(storage.pillarHome, "agents");
            const projectDirectory = join(cwd, ".pillar", "agents");
            await Promise.all([
                mkdir(userDirectory, {recursive: true}),
                mkdir(projectDirectory, {recursive: true}),
            ]);
            await Promise.all(Array.from({length: 64}, (_, index) =>
                writeFile(
                    join(userDirectory, `user-${index}.md`),
                    `---\nname: user-${index}\ndescription: user ${index}\ntools: [read_file]\n---\nprompt`,
                    "utf8"
                )
            ));
            await writeFile(
                join(projectDirectory, "project-agent.md"),
                "---\nname: project-agent\ndescription: project\ntools: [read_file]\n---\nprompt",
                "utf8"
            );

            const loaded = await loadCustomAgentDefinitions(storage, cwd);
            expect(loaded.definitions).toHaveLength(64);
            expect(loaded.definitions.some((item) =>
                item.agentType === "project-agent"
            )).toBe(true);
            expect(loaded.issues.some((item) =>
                item.message.includes("超过 64 个")
            )).toBe(true);
        });
    });
});
