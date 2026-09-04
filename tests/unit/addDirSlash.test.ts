import {describe, expect, test} from "bun:test";
import {mkdir, realpath} from "node:fs/promises";
import {join} from "node:path";
import {addDirCommand} from "../../src/slash/commands/addDir.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/index.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/add-dir", () => {
    test("查看并增加 Session 目录", async () => {
        await withTempProject(async (root) => {
            const cwd = join(root, "project");
            const shared = join(root, "shared");
            await mkdir(cwd);
            await mkdir(shared);
            const runtime = createDirectoryAccessRuntime({
                cwd,
                hardBoundary: root,
            });
            await runtime.initialize();
            const events: string[] = [];
            const context = createTestContext(cwd, {directoryAccess: runtime});
            const commandContext = {
                history: [],
                ctx: context,
                onEvent(event: {type: string; content?: string}) {
                    if (event.type === "assistant_text" && event.content) {
                        events.push(event.content);
                    }
                },
                compactHistory: async () => ({
                    history: [], compacted: false, preTokenCount: 0, threshold: 0,
                }),
                getToolSchemas: () => [],
                subagents: {
                    issues: [], has: () => false, get: () => undefined,
                    listDefinitions: () => [],
                },
            };

            await addDirCommand.execute(shared, commandContext);
            await addDirCommand.execute("", commandContext);

            const canonicalShared = await realpath(shared);
            expect(runtime.listDirectories()).toContain(canonicalShared);
            expect(events[0]).toContain("当前 Session");
            expect(events[1]).toContain(canonicalShared);
        });
    });

    test("project scope 先持久化再加入运行时", async () => {
        await withTempProject(async (root) => {
            const cwd = join(root, "project");
            const shared = join(root, "shared");
            await mkdir(cwd);
            await mkdir(shared);
            const persisted: string[] = [];
            const runtime = createDirectoryAccessRuntime({
                cwd,
                hardBoundary: root,
                persistDirectory: async (directory) => {
                    persisted.push(directory);
                },
            });
            await runtime.initialize();
            const events: string[] = [];
            await addDirCommand.execute(`--project ${shared}`, {
                history: [],
                ctx: createTestContext(cwd, {directoryAccess: runtime}),
                onEvent(event) {
                    if (event.type === "assistant_text") events.push(event.content);
                },
                compactHistory: async () => ({
                    history: [], compacted: false, preTokenCount: 0, threshold: 0,
                }),
                getToolSchemas: () => [],
                subagents: {
                    issues: [], has: () => false, get: () => undefined,
                    listDefinitions: () => [],
                },
            });

            expect(persisted).toEqual([await realpath(shared)]);
            expect(events).toEqual([expect.stringContaining("为当前项目记住")]);
        });
    });
});
