import {describe, expect, test} from "bun:test";
import {homedir} from "node:os";
import {join} from "node:path";
import {
    createHiCodeStorageLayout,
    getProjectKey,
    getProjectStorageDirectory,
    getSessionStorageDirectory,
    hashProjectValue,
} from "../../src/persistence/index.js";
import {getProjectMemoryDirectory} from "../../src/persistence/layout.js";
import {getToolResultSessionDir} from "../../src/toolResults/paths.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("persistence paths", () => {
    test("默认 HiCode Home 与 Projects Root 使用统一布局", () => {
        const storage = createHiCodeStorageLayout();
        expect(storage.hicodeHome).toBe(join(homedir(), ".hicode"));
        expect(storage.projectsRoot).toBe(join(homedir(), ".hicode", "projects"));
    });

    test("Project 与 Session 目录只计算一次 identity", async () => {
        await withTempProject(async (cwd) => {
            const hicodeHome = join(cwd, "storage-root");
            const storage = createHiCodeStorageLayout({hicodeHome});
            const sessionId = "session-path-test";
            const projectDirectory = join(
                hicodeHome,
                "projects",
                getProjectKey(cwd)
            );
            const sessionDirectory = join(
                projectDirectory,
                "sessions",
                `session-${hashProjectValue(sessionId, 24)}`
            );

            expect(getProjectStorageDirectory(storage, cwd)).toBe(
                projectDirectory
            );
            expect(getSessionStorageDirectory(
                storage,
                cwd,
                sessionId
            )).toBe(sessionDirectory);
            expect(getProjectMemoryDirectory(storage, cwd)).toBe(
                join(projectDirectory, "memory")
            );

            expect(getToolResultSessionDir(
                storage,
                cwd,
                sessionId
            )).toBe(join(sessionDirectory, "tool-results"));
        });
    });
});
