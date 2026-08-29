import {describe, expect, test} from "bun:test";
import {homedir} from "node:os";
import {join} from "node:path";
import {
    getPillarHome,
    getProjectKey,
    getProjectStorageDirectory,
    getProjectsRoot,
    getSessionStorageDirectory,
    hashProjectValue,
} from "../../src/persistence/index.js";
import {getCheckpointDirectory} from "../../src/checkpoints/paths.js";
import {getMemoryDirectory} from "../../src/memory/paths.js";
import {getToolResultSessionDir} from "../../src/toolResults/paths.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("persistence paths", () => {
    test("默认 Pillar Home 与 Projects Root 使用统一布局", () => {
        expect(getPillarHome()).toBe(join(homedir(), ".pillar"));
        expect(getProjectsRoot()).toBe(join(homedir(), ".pillar", "projects"));
    });

    test("Project 与 Session 目录只计算一次 identity", async () => {
        await withTempProject(async (cwd) => {
            const projectsRoot = join(cwd, "storage-root");
            const sessionId = "session-path-test";
            const projectDirectory = join(projectsRoot, getProjectKey(cwd));
            const sessionDirectory = join(
                projectDirectory,
                `session-${hashProjectValue(sessionId, 24)}`
            );

            expect(getProjectStorageDirectory(cwd, projectsRoot)).toBe(
                projectDirectory
            );
            expect(getSessionStorageDirectory(
                cwd,
                sessionId,
                projectsRoot
            )).toBe(sessionDirectory);
            expect(getMemoryDirectory(cwd, projectsRoot)).toBe(
                join(projectDirectory, "memory")
            );
            expect(getCheckpointDirectory(
                cwd,
                sessionId,
                projectsRoot
            )).toBe(join(sessionDirectory, "checkpoints"));
            expect(getToolResultSessionDir(
                cwd,
                sessionId,
                projectsRoot
            )).toBe(join(sessionDirectory, "tool-results"));
        });
    });
});
