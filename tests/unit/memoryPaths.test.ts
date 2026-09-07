import {describe, expect, test} from "bun:test";
import {symlink, unlink} from "node:fs/promises";
import {dirname, join} from "node:path";
import {getProjectMemoryDirectory} from "../../src/persistence/layout.js";
import {classifyPublicationPath} from "../../src/memory/publicationAccess.js";
import {createPillarStorageLayout, getProjectKey} from "../../src/persistence/index.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("Memory paths", () => {
    test("同一真实项目的符号链接入口复用 project key 和 Memory 目录", async () => {
        await withTempProject(async (cwd) => {
            const alias = join(dirname(cwd), `${getProjectKey(cwd)}-alias`);
            await symlink(cwd, alias);
            try {
                const pillarHome = join(cwd, "memory-storage");
                const storage = createPillarStorageLayout({pillarHome});
                expect(getProjectKey(alias)).toBe(getProjectKey(cwd));
                expect(getProjectMemoryDirectory(storage, alias)).toBe(
                    getProjectMemoryDirectory(storage, cwd)
                );
            } finally {
                await unlink(alias);
            }
        });
    });

    test("主题路径只接受公开视图和安全 key", () => {
        expect(classifyPublicationPath("/memory", "/memory/views/project-release.md")?.kind).toBe("topic");
        expect(classifyPublicationPath("/memory", "/memory/../secret.md")).toBeUndefined();
        expect(classifyPublicationPath("/memory", "/memory/publication.json")).toBeUndefined();
    });
});
