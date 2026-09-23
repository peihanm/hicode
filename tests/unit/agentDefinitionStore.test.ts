import {describe, expect, test} from "bun:test";
import {mkdir, readFile, readdir, symlink} from "node:fs/promises";
import {
    createAgentDefinitionStore,
    type AgentDefinitionDraft,
} from "../../src/subagents/index.js";
import {stringify} from "yaml";

function serializeAgentDefinition(value: AgentDefinitionDraft): string {
    return `---\n${stringify({name: value.name, description: value.description, tools: value.tools})}---\n\n${value.systemPrompt}\n`;
}
import {withTempProject} from "../helpers/tempProject.js";

function draft(description = "检查项目实现"): AgentDefinitionDraft {
    return {
        name: "project-reviewer",
        description,
        tools: ["read_file", "bash"],


        systemPrompt: "你只负责检查项目并返回证据。",
    };
}

describe("agent definition store", () => {
    test("在受管 project 目录创建、更新和删除 Markdown", async () => {
        await withTempProject(async (cwd, storage) => {
            const store = createAgentDefinitionStore(storage, cwd);
            const created = await store.create("project", draft());
            expect(created.path).toBe(
                `${cwd}/.hicode/agents/project-reviewer.md`
            );
            expect(await readFile(created.path, "utf8")).toContain(draft().systemPrompt);
            expect(created.definition.whenToUse).toBe(draft().description);

            const updated = await store.update(
                "project",
                "project-reviewer",
                created.contentHash,
                draft("检查架构和回归风险")
            );
            expect(updated.definition.whenToUse).toBe("检查架构和回归风险");
            await store.remove(
                "project",
                "project-reviewer",
                updated.contentHash
            );
            expect(await Bun.file(updated.path).exists()).toBe(false);
        });
    });

    test("expectedHash 阻止旧编辑覆盖外部修改", async () => {
        await withTempProject(async (cwd, storage) => {
            const store = createAgentDefinitionStore(storage, cwd);
            const created = await store.create("project", draft());
            await Bun.write(created.path, serializeAgentDefinition(
                draft("外部编辑后的说明")
            ));
            await expect(store.update(
                "project",
                created.definition.agentType,
                created.contentHash,
                draft("旧表单覆盖")
            )).rejects.toThrow("was modified externally");
        });
    });

    test("同一作用域按规范化名称拒绝重复创建", async () => {
        await withTempProject(async (cwd, storage) => {
            const store = createAgentDefinitionStore(storage, cwd);
            await store.create("project", draft());
            await expect(store.create("project", {
                ...draft(),
                name: "Project-Reviewer",
            })).rejects.toThrow("Agent already exists in this scope");
            expect((await readdir(`${cwd}/.hicode/agents`)).filter(
                (name) => name.endsWith(".md")
            )).toEqual(["project-reviewer.md"]);
        });
    });

    test("达到单个作用域文件上限后拒绝继续创建", async () => {
        await withTempProject(async (cwd, storage) => {
            const store = createAgentDefinitionStore(storage, cwd);
            await store.create("project", draft());
            await Promise.all(Array.from({length: 63}, (_, index) =>
                Bun.write(
                    `${cwd}/.hicode/agents/fixture-${index}.md`,
                    "invalid fixture"
                )
            ));
            await expect(store.create("project", {
                ...draft(),
                name: "over-limit",
            })).rejects.toThrow("64 items");
        });
    });

    test("拒绝把 symlink 当成受管 Agent 文件", async () => {
        await withTempProject(async (cwd, storage) => {
            const store = createAgentDefinitionStore(storage, cwd);
            await Bun.write(`${cwd}/outside.md`, serializeAgentDefinition(draft()));
            await Bun.$`mkdir -p ${cwd}/.hicode/agents`.quiet();
            await symlink(
                `${cwd}/outside.md`,
                `${cwd}/.hicode/agents/project-reviewer.md`
            );
            await expect(store.read("project", "project-reviewer"))
                .rejects.toThrow();
        });
    });

    test("拒绝通过 symlink .hicode 目录写出项目", async () => {
        await withTempProject(async (cwd, storage) => {
            const outside = `${cwd}/outside`;
            await mkdir(outside, {recursive: true});
            await symlink(outside, `${cwd}/.hicode`);
            const store = createAgentDefinitionStore(storage, cwd);

            await expect(store.create("project", draft())).rejects.toThrow(
                "Unsafe Agent configuration directory"
            );
            expect(await Bun.file(`${outside}/agents/project-reviewer.md`).exists())
                .toBe(false);
        });
    });
});
