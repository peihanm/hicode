import {describe, expect, test} from "bun:test";
import {readFile, readdir, symlink} from "node:fs/promises";
import {
    createAgentDefinitionStore,
    type AgentDefinitionDraft,
} from "../../src/subagents/index.js";
import {serializeAgentDefinition} from "../../src/subagents/serialize.js";
import {withTempProject} from "../helpers/tempProject.js";

function draft(description = "检查项目实现"): AgentDefinitionDraft {
    return {
        name: "project-reviewer",
        description,
        tools: ["read_file", "grep"],
        model: "inherit",
        maxIterations: 8,
        systemPrompt: "你只负责检查项目并返回证据。",
    };
}

describe("agent definition store", () => {
    test("在受管 project 目录创建、更新和删除 Markdown", async () => {
        await withTempProject(async (cwd) => {
            const store = createAgentDefinitionStore(cwd);
            const created = await store.create("project", draft());
            expect(created.path).toBe(
                `${cwd}/.pillar/agents/project-reviewer.md`
            );
            expect(await readFile(created.path, "utf8")).toBe(
                serializeAgentDefinition(draft())
            );

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
        await withTempProject(async (cwd) => {
            const store = createAgentDefinitionStore(cwd);
            const created = await store.create("project", draft());
            await Bun.write(created.path, serializeAgentDefinition(
                draft("外部编辑后的说明")
            ));
            await expect(store.update(
                "project",
                created.definition.agentType,
                created.contentHash,
                draft("旧表单覆盖")
            )).rejects.toThrow("已被外部修改");
        });
    });

    test("同一作用域按规范化名称拒绝重复创建", async () => {
        await withTempProject(async (cwd) => {
            const store = createAgentDefinitionStore(cwd);
            await store.create("project", draft());
            await expect(store.create("project", {
                ...draft(),
                name: "Project-Reviewer",
            })).rejects.toThrow("同一作用域已存在 Agent");
            expect((await readdir(`${cwd}/.pillar/agents`)).filter(
                (name) => name.endsWith(".md")
            )).toEqual(["project-reviewer.md"]);
        });
    });

    test("达到单个作用域文件上限后拒绝继续创建", async () => {
        await withTempProject(async (cwd) => {
            const store = createAgentDefinitionStore(cwd);
            await store.create("project", draft());
            await Promise.all(Array.from({length: 63}, (_, index) =>
                Bun.write(
                    `${cwd}/.pillar/agents/fixture-${index}.md`,
                    "invalid fixture"
                )
            ));
            await expect(store.create("project", {
                ...draft(),
                name: "over-limit",
            })).rejects.toThrow("64 个的上限");
        });
    });

    test("拒绝把 symlink 当成受管 Agent 文件", async () => {
        await withTempProject(async (cwd) => {
            const store = createAgentDefinitionStore(cwd);
            await Bun.write(`${cwd}/outside.md`, serializeAgentDefinition(draft()));
            await Bun.$`mkdir -p ${cwd}/.pillar/agents`.quiet();
            await symlink(
                `${cwd}/outside.md`,
                `${cwd}/.pillar/agents/project-reviewer.md`
            );
            await expect(store.read("project", "project-reviewer"))
                .rejects.toThrow();
        });
    });
});
