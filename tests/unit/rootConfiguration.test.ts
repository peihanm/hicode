import {describe, expect, test} from "bun:test";
import {join} from "node:path";
import {
    createPillarRootConfiguration,
    type PillarFileSources,
} from "../../src/runtime/rootConfiguration.js";
import {
    createTestSettings,
} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

function sources() {
    return {
        settings: ["user"],
        instructions: ["project"],
        skills: [],
        agents: [],
        mcp: [],
    } satisfies PillarFileSources;
}

describe("Root Configuration", () => {
    test("防御性复制并冻结 Settings、Storage 和文件来源", async () => {
        await withTempProject(async (cwd, storage) => {
            const settings = createTestSettings();
            const fileSources = sources();
            const configuration = createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage,
                settings,
                fileSources,
            });

            settings.memory.enabled = true;
            fileSources.settings.push("user");

            expect(configuration.settings.memory.enabled).toBe(false);
            expect(configuration.fileSources.settings).toEqual(["user"]);
            expect(Object.isFrozen(configuration)).toBe(true);
            expect(Object.isFrozen(configuration.settings.memory)).toBe(true);
            expect(Object.isFrozen(configuration.fileSources.settings)).toBe(true);
        });
    });

    test("拒绝越过 workspace boundary 和重复来源", async () => {
        await withTempProject(async (cwd, storage) => {
            expect(() => createPillarRootConfiguration({
                cwd,
                workspaceBoundary: join(cwd, "nested"),
                storage,
                settings: createTestSettings(),
                fileSources: sources(),
            })).toThrow("workspaceBoundary 不包含 cwd");

            expect(() => createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage,
                settings: createTestSettings(),
                fileSources: {
                    ...sources(),
                    settings: ["user", "user"],
                },
            })).toThrow("fileSources.settings 包含重复来源 user");
        });
    });

    test("文件来源只负责选择，始终按领域规范优先级排列", async () => {
        await withTempProject(async (cwd, storage) => {
            const configuration = createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage,
                settings: createTestSettings(),
                fileSources: {
                    ...sources(),
                    settings: ["local", "user", "project"],
                    instructions: ["local", "user", "project"],
                },
            });

            expect(configuration.fileSources.settings)
                .toEqual(["user", "project", "local"]);
            expect(configuration.fileSources.instructions)
                .toEqual(["user", "project", "local"]);
        });
    });

    test("拒绝 Host 注入分裂或相对的 StorageLayout", async () => {
        await withTempProject(async (cwd, storage) => {
            expect(() => createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage: {...storage, projectsRoot: join(cwd, "elsewhere")},
                settings: createTestSettings(),
                fileSources: sources(),
            })).toThrow("projectsRoot 必须由 pillarHome 唯一派生");

            expect(() => createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage: {pillarHome: "relative", projectsRoot: "relative/projects"},
                settings: createTestSettings(),
                fileSources: sources(),
            })).toThrow("pillarHome 必须是非空绝对路径");
        });
    });

    test("严格校验、复制并冻结 Host contributions", async () => {
        await withTempProject(async (cwd, storage) => {
            const rootContributions = {
                instructions: [{id: "policy", content: "host policy"}],
                skills: [{
                    name: "review",
                    description: "review code",
                    content: "Review carefully.",
                }],
                agents: [{
                    name: "reviewer",
                    description: "review project",
                    systemPrompt: "Inspect the project.",
                    tools: ["read_file"],
                }],
                mcpServers: [{
                    name: "fixture",
                    command: "node",
                    env: {TOKEN: "initial"},
                }],
            };
            const configuration = createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage,
                settings: createTestSettings(),
                fileSources: sources(),
                rootContributions,
            });
            rootContributions.instructions[0]!.content = "mutated";
            rootContributions.mcpServers[0]!.env!.TOKEN = "mutated";
            expect(configuration.contributions.instructions?.[0]?.content)
                .toBe("host policy");
            expect(Object.isFrozen(configuration.contributions.agents?.[0]))
                .toBe(true);
            expect(configuration.contributions.mcpServers?.[0]?.env?.TOKEN)
                .toBe("initial");

            expect(() => createPillarRootConfiguration({
                cwd,
                workspaceBoundary: cwd,
                storage,
                settings: createTestSettings(),
                fileSources: sources(),
                rootContributions: {
                    skills: [
                        {name: "Same", description: "a", content: "a"},
                        {name: "same", description: "b", content: "b"},
                    ],
                },
            })).toThrow("重复名称");
        });
    });
});
