import {describe, expect, test} from "bun:test";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createFileStateTracker} from "../../src/tools/shared/fileState.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

describe("Checkpoint tool integration", () => {
    test("write、edit 和 delete 共享 Turn Checkpoint，恢复后强制重新读取", async () => {
        await withTempProject(async (cwd) => {
            const fileState = createFileStateTracker();
            const runtime = createFileCheckpointRuntime({
                storage: createPillarStorageLayout({
                    pillarHome: join(cwd, ".pillar-test-checkpoints"),
                }),
                cwd,
                sessionId: "tool-session",
                enabled: true,
                fileState,
            });
            const ctx = createTestContext(cwd, {
                permissionMode: "bypassPermissions",
        collaborationMode: "build",
                fileState,
            });
            ctx.fileCheckpoints = runtime;
            const tools = createToolRuntime();
            const checkpoint = await runtime.beginTurn({prompt: "修改两个文件"});

            const created = await tools.executeTool(
                "write_file",
                JSON.stringify({path: "new.txt", content: "new\n"}),
                ctx,
                "create-file"
            );
            expect(created.outcome).toBe("ok");

            const existingPath = join(cwd, "existing.txt");
            await writeFile(existingPath, "before\n");
            const read = await tools.executeTool(
                "read_file",
                JSON.stringify({path: "existing.txt"}),
                ctx,
                "read-existing"
            );
            expect(read.outcome).toBe("ok");
            const edited = await tools.executeTool(
                "edit_file",
                JSON.stringify({
                    path: "existing.txt",
                    old_string: "before",
                    new_string: "after",
                }),
                ctx,
                "edit-existing"
            );
            expect(edited.outcome).toBe("ok");

            const deletedPath = join(cwd, "deleted.txt");
            await writeFile(deletedPath, "restore me\n");
            expect((await tools.executeTool(
                "read_file",
                JSON.stringify({path: "deleted.txt"}),
                ctx,
                "read-deleted"
            )).outcome).toBe("ok");
            expect((await tools.executeTool(
                "delete_file",
                JSON.stringify({path: "deleted.txt"}),
                ctx,
                "delete-existing"
            )).outcome).toBe("ok");
            await runtime.settleTurn();

            expect(await readFile(existingPath, "utf8")).toBe("after\n");
            const restored = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(restored.status).toBe("complete");
            expect(await readFile(existingPath, "utf8")).toBe("before\n");
            expect(await readFile(deletedPath, "utf8")).toBe("restore me\n");
            await expect(readFile(join(cwd, "new.txt"), "utf8"))
                .rejects.toMatchObject({code: "ENOENT"});

            const staleEdit = await tools.executeTool(
                "edit_file",
                JSON.stringify({
                    path: "existing.txt",
                    old_string: "before",
                    new_string: "again",
                }),
                ctx,
                "edit-after-restore"
            );
            expect(staleEdit.outcome).toBe("failed");
            expect(staleEdit.modelContent).toContain("必须先用 read_file");
        });
    });
});
