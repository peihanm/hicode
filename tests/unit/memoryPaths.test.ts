import {describe, expect, test} from "bun:test";
import {symlink, unlink} from "node:fs/promises";
import {dirname, join} from "node:path";
import {
    getMemoryDirectory,
    getMemoryEntryPath,
} from "../../src/memory/index.js";
import {createPillarStorageLayout, getProjectKey} from "../../src/persistence/index.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("Memory paths", () => {
    test("同一真实项目的符号链接入口复用 project key 和 Memory 目录", async () => {
        await withTempProject(async (cwd) => {
            const alias = join(dirname(cwd), `${getProjectKey(cwd)}-alias`);
            await symlink(cwd, alias);
            try {
                const projectsRoot = join(cwd, "memory-projects");
                const storage = createPillarStorageLayout({projectsRoot});
                expect(getProjectKey(alias)).toBe(getProjectKey(cwd));
                expect(getMemoryDirectory(storage, alias)).toBe(
                    getMemoryDirectory(storage, cwd)
                );
            } finally {
                await unlink(alias);
            }
        });
    });

    test("主题路径只接受安全 key", () => {
        expect(getMemoryEntryPath("/memory", "project-release-context")).toBe(
            "/memory/project-release-context.md"
        );
        expect(() => getMemoryEntryPath("/memory", "../secret")).toThrow();
        expect(() => getMemoryEntryPath("/memory", "/absolute")).toThrow();
    });
});
