import {describe, expect, test} from "bun:test";
import {mkdir, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {getCheckpointDirectory} from "../../src/checkpoints/paths.js";
import {validateCheckpointPath} from "../../src/checkpoints/fingerprint.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("Checkpoint path and disabled runtime", () => {
    test("拒绝项目外路径、symlink 和特殊目录目标", async () => {
        await withTempProject(async (cwd) => {
            const outside = join(cwd, "..", "outside.txt");
            await expect(validateCheckpointPath(cwd, outside)).rejects.toThrow(
                "当前项目内"
            );
            await writeFile(join(cwd, "target.txt"), "target\n");
            await symlink(join(cwd, "target.txt"), join(cwd, "link.txt"));
            await expect(
                validateCheckpointPath(cwd, join(cwd, "link.txt"))
            ).rejects.toThrow("symlink");
            await mkdir(join(cwd, "directory"));
            await expect(
                validateCheckpointPath(cwd, join(cwd, "directory"))
            ).rejects.toThrow("regular file");
        });
    });

    test("disabled runtime 的 turn 捕获路径完全不创建存储目录", async () => {
        await withTempProject(async (cwd, storage) => {
            const sessionId = `disabled-${Date.now()}-${Math.random()}`;
            const directory = getCheckpointDirectory(storage, cwd, sessionId);
            const runtime = createFileCheckpointRuntime({
                storage,
                cwd,
                sessionId,
                enabled: false,
            });
            expect(await runtime.beginTurn({prompt: "不会保存"})).toBeNull();
            expect((await runtime.beforeWrite({
                path: join(cwd, "a.txt"),
                content: null,
                toolCallId: "write-a",
            })).captured).toBe(false);
            await runtime.settleTurn();
            await expect(stat(directory)).rejects.toMatchObject({code: "ENOENT"});
        });
    });
});
