import {describe, expect, test} from "bun:test";
import {
    mkdir,
    readFile,
    realpath,
    stat,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import {dirname, join} from "node:path";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {
    getCheckpointBlobPath,
    getCheckpointManifestPath,
    getCheckpointMutationLogPath,
} from "../../src/checkpoints/paths.js";
import {hashCheckpointContent} from "../../src/checkpoints/fingerprint.js";
import {createFileStateTracker} from "../../src/tools/shared/fileState.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestFileCheckpointStore} from "../helpers/checkpointStore.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

function createRuntime(cwd: string, hardBoundary: string = cwd) {
    return createFileCheckpointRuntime({
        storage: createPillarStorageLayout({
            pillarHome: join(cwd, ".pillar-test-checkpoints"),
        }),
        cwd,
        hardBoundary,
        sessionId: "checkpoint-session",
        enabled: true,
        fileState: createFileStateTracker(),
    });
}

describe("File Checkpoint Store", () => {
    test("通过父目录 alias 创建项目外文件时使用 canonical root", async () => {
        await withTempProject(async (root) => {
            const cwd = join(root, "project");
            const externalDirectory = join(root, "external");
            const aliasDirectory = join(root, "external-alias");
            await mkdir(cwd);
            await mkdir(externalDirectory);
            await symlink(externalDirectory, aliasDirectory, "dir");
            const canonicalExternalDirectory = await realpath(externalDirectory);
            const aliasPath = join(aliasDirectory, "new.txt");
            const canonicalPath = join(canonicalExternalDirectory, "new.txt");
            const runtime = createRuntime(cwd, root);
            const checkpoint = await runtime.beginTurn({prompt: "创建外部文件"});

            expect((await runtime.beforeWrite({
                path: aliasPath,
                content: null,
                toolCallId: "external-create",
            })).captured).toBe(true);
            await writeFile(aliasPath, "created\n");
            expect((await runtime.afterWrite({
                path: aliasPath,
                content: "created\n",
                toolCallId: "external-create",
            })).captured).toBe(true);
            await runtime.settleTurn();

            const listed = await runtime.listCheckpoints();
            expect(listed[0]?.mutations[0]).toMatchObject({
                root: canonicalExternalDirectory,
                path: "new.txt",
            });
            const restored = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(restored.status).toBe("complete");
            await expect(stat(canonicalPath)).rejects.toMatchObject({code: "ENOENT"});
        });
    });

    test("记录并恢复 Host 边界内的项目外文件", async () => {
        await withTempProject(async (root) => {
            const cwd = join(root, "project");
            const externalDirectory = join(root, "external");
            await mkdir(cwd);
            await mkdir(externalDirectory);
            const canonicalExternalDirectory = await realpath(externalDirectory);
            const path = join(externalDirectory, "shared.txt");
            await writeFile(path, "before\n");
            const runtime = createRuntime(cwd, root);
            const checkpoint = await runtime.beginTurn({prompt: "修改外部文件"});

            expect((await runtime.beforeWrite({
                path,
                content: "before\n",
                toolCallId: "external-edit",
            })).captured).toBe(true);
            await writeFile(path, "after\n");
            expect((await runtime.afterWrite({
                path,
                content: "after\n",
                toolCallId: "external-edit",
            })).captured).toBe(true);
            await runtime.settleTurn();

            const listed = await runtime.listCheckpoints();
            expect(listed[0]?.mutations[0]).toMatchObject({
                root: canonicalExternalDirectory,
                path: "shared.txt",
            });
            const preview = await runtime.previewRestore(checkpoint!.checkpointId);
            expect(preview.files[0]).toMatchObject({
                path: join(canonicalExternalDirectory, "shared.txt"),
                root: canonicalExternalDirectory,
                relativePath: "shared.txt",
                action: "update",
            });
            const restored = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(restored.status).toBe("complete");
            expect(restored.restoredFiles).toEqual([
                join(canonicalExternalDirectory, "shared.txt"),
            ]);
            expect(await readFile(path, "utf8")).toBe("before\n");
        });
    });

    test("同一 Turn 多次写入只保留第一次 Preimage", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "app.ts");
            await writeFile(path, "const value = 1;\n");
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "修改 value"});
            expect(checkpoint).not.toBeNull();

            expect((await runtime.beforeWrite({
                path,
                content: "const value = 1;\n",
                toolCallId: "call-1",
            })).captured).toBe(true);
            await writeFile(path, "const value = 2;\n");
            await runtime.afterWrite({
                path,
                content: "const value = 2;\n",
                toolCallId: "call-1",
            });

            await runtime.beforeWrite({
                path,
                content: "const value = 2;\n",
                toolCallId: "call-2",
            });
            await writeFile(path, "const value = 3;\n");
            await runtime.afterWrite({
                path,
                content: "const value = 3;\n",
                toolCallId: "call-2",
            });
            await runtime.settleTurn();

            const listed = await runtime.listCheckpoints();
            expect(listed).toHaveLength(1);
            expect(listed[0]?.mutations).toHaveLength(1);
            expect(listed[0]?.mutations[0]?.firstToolCallId).toBe("call-1");
            expect(listed[0]?.mutations[0]?.lastToolCallId).toBe("call-2");

            const result = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(result.status).toBe("complete");
            expect(await readFile(path, "utf8")).toBe("const value = 1;\n");
        });
    });

    test("新建文件恢复为 missing 并删除", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "new.txt");
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "新建文件"});
            await runtime.beforeWrite({
                path,
                content: null,
                toolCallId: "create-1",
            });
            await writeFile(path, "created\n");
            await runtime.afterWrite({
                path,
                content: "created\n",
                toolCallId: "create-1",
            });
            await runtime.settleTurn();

            const preview = await runtime.previewRestore(checkpoint!.checkpointId);
            expect(preview.files[0]?.action).toBe("delete");
            const result = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(result.deletedFiles).toEqual(["new.txt"]);
            await expect(readFile(path, "utf8")).rejects.toMatchObject({
                code: "ENOENT",
            });
        });
    });

    test("外部修改触发 conflict 且不覆盖文件", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "config.json");
            await writeFile(path, "old\n");
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "修改配置"});
            await runtime.beforeWrite({
                path,
                content: "old\n",
                toolCallId: "edit-1",
            });
            await writeFile(path, "agent\n");
            await runtime.afterWrite({
                path,
                content: "agent\n",
                toolCallId: "edit-1",
            });
            await runtime.settleTurn();
            await writeFile(path, "external\n");

            const result = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(result.status).toBe("conflict");
            expect(result.conflicts[0]?.reason).toBe("external_change");
            expect(await readFile(path, "utf8")).toBe("external\n");
        });
    });

    test("恢复时拒绝 mutation root 越过 Host 边界", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "guarded.txt");
            await writeFile(path, "before\n");
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "修改受保护文件"});
            await runtime.beforeWrite({
                path,
                content: "before\n",
                toolCallId: "guarded-edit",
            });
            await writeFile(path, "after\n");
            await runtime.afterWrite({
                path,
                content: "after\n",
                toolCallId: "guarded-edit",
            });
            await runtime.settleTurn();

            const store = createTestFileCheckpointStore(cwd, "checkpoint-session");
            const mutationPath = getCheckpointMutationLogPath(
                store.directory,
                checkpoint!.checkpointId
            );
            const outsideRoot = await realpath(dirname(cwd));
            const events = (await readFile(mutationPath, "utf8"))
                .trim()
                .split("\n")
                .map((line) => ({...JSON.parse(line), root: outsideRoot}));
            await writeFile(
                mutationPath,
                `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
            );

            const preview = await runtime.previewRestore(checkpoint!.checkpointId);
            expect(preview.conflicts[0]).toMatchObject({
                reason: "unsupported_path",
                message: expect.stringContaining("Host 边界"),
            });
            expect((await runtime.restoreCode(checkpoint!.checkpointId).then(
                (result) => result.status
            ))).toBe("conflict");
            expect(await readFile(path, "utf8")).toBe("after\n");
        });
    });

    test("Blob 损坏时预览和恢复均拒绝覆盖当前文件", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "safe.txt");
            await writeFile(path, "before\n");
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "修改 safe"});
            await runtime.beforeWrite({
                path,
                content: "before\n",
                toolCallId: "edit-safe",
            });
            await writeFile(path, "after\n");
            await runtime.afterWrite({
                path,
                content: "after\n",
                toolCallId: "edit-safe",
            });
            await runtime.settleTurn();
            const record = (await runtime.listCheckpoints())[0]!;
            const blobId = record.mutations[0]!.beforeBlobId!;
            const store = createTestFileCheckpointStore(
                cwd,
                "checkpoint-session"
            );
            await writeFile(getCheckpointBlobPath(store.directory, blobId), "corrupt");

            const preview = await runtime.previewRestore(checkpoint!.checkpointId);
            expect(preview.conflicts[0]?.reason).toBe("corrupt_blob");
            const restored = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(restored.status).toBe("conflict");
            expect(await readFile(path, "utf8")).toBe("after\n");
        });
    });

    test("再次捕获相同内容时修复同名损坏 Blob", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "repair.txt");
            await writeFile(path, "before\n");
            const runtime = createRuntime(cwd);
            await runtime.beginTurn({prompt: "第一次修改"});
            await runtime.beforeWrite({
                path,
                content: "before\n",
                toolCallId: "first",
            });
            await runtime.settleTurn();

            const store = createTestFileCheckpointStore(cwd, "checkpoint-session");
            const blobPath = getCheckpointBlobPath(
                store.directory,
                hashCheckpointContent("before\n")
            );
            await writeFile(blobPath, "corrupt");

            await runtime.beginTurn({prompt: "第二次修改"});
            await runtime.beforeWrite({
                path,
                content: "before\n",
                toolCallId: "second",
            });

            expect(await readFile(blobPath, "utf8")).toBe("before\n");
        });
    });

    test("manifest head 指向不存在的 Checkpoint 时拒绝恢复", async () => {
        await withTempProject(async (cwd) => {
            const runtime = createRuntime(cwd);
            await runtime.beginTurn({prompt: "建立 checkpoint"});
            const store = createTestFileCheckpointStore(cwd, "checkpoint-session");
            const manifestPath = getCheckpointManifestPath(store.directory);
            const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
            manifest.head.checkpointId = "missing-checkpoint";
            await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

            await expect(runtime.listCheckpoints()).rejects.toMatchObject({
                message: expect.stringContaining("无法读取 Checkpoint manifest"),
                cause: {
                    message: "Checkpoint manifest head 不在当前索引中",
                },
            });
        });
    });

    test("Checkpoint 目录、manifest 和 mutation log 拒绝 Symlink", async () => {
        await withTempProject(async (cwd) => {
            const store = createTestFileCheckpointStore(cwd, "directory-symlink");
            const redirected = join(cwd, "redirected-checkpoints");
            await mkdir(dirname(store.directory), {recursive: true});
            await mkdir(redirected);
            await symlink(redirected, store.directory);
            await expect(store.beginCheckpoint({prompt: "不得重定向"}))
                .rejects.toThrow("Pillar storage 目录不安全");
        });

        await withTempProject(async (cwd) => {
            const store = createTestFileCheckpointStore(cwd, "file-symlink");
            const checkpoint = await store.beginCheckpoint({prompt: "初始"});
            const manifestPath = getCheckpointManifestPath(store.directory);
            const originalManifest = await readFile(manifestPath, "utf8");
            const redirectedManifest = join(cwd, "redirected-manifest.json");
            await writeFile(redirectedManifest, originalManifest, "utf8");
            await unlink(manifestPath);
            await symlink(redirectedManifest, manifestPath);

            await expect(store.listCheckpoints()).rejects.toThrow(
                "无法读取 Checkpoint manifest"
            );
            expect(await readFile(redirectedManifest, "utf8"))
                .toBe(originalManifest);

            await unlink(manifestPath);
            await writeFile(manifestPath, originalManifest, "utf8");
            const mutationPath = getCheckpointMutationLogPath(
                store.directory,
                checkpoint.checkpointId
            );
            const redirectedMutation = join(cwd, "redirected-mutation.jsonl");
            await mkdir(dirname(mutationPath), {recursive: true});
            await writeFile(redirectedMutation, "", "utf8");
            await symlink(redirectedMutation, mutationPath);
            await expect(store.captureBefore(checkpoint.checkpointId, {
                path: join(cwd, "safe.txt"),
                content: null,
                toolCallId: "must-not-follow",
            })).rejects.toThrow();
            expect(await readFile(redirectedMutation, "utf8")).toBe("");
        });
    });

    test("Bash 等未捕获副作用进入 partial coverage", async () => {
        await withTempProject(async (cwd) => {
            const runtime = createRuntime(cwd);
            await runtime.beginTurn({prompt: "运行脚本"});
            await runtime.markCoverageWarning({
                code: "bash_side_effects",
                message: "Bash 可能修改文件",
            });
            await runtime.settleTurn();
            const listed = await runtime.listCheckpoints();
            expect(listed[0]?.coverageWarnings).toEqual([{
                code: "bash_side_effects",
                message: "Bash 可能修改文件",
            }]);
            expect(listed[0]?.fileCoverage).toBe("incomplete");
            const preview = await runtime.previewRestore(
                listed[0]!.checkpointId
            );
            expect(preview.conflicts[0]?.reason).toBe("incomplete_checkpoint");
        });
    });

    test("超过 500 个文件时继续使用分片 mutation log 完整记录", async () => {
        await withTempProject(async (cwd) => {
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "批量生成文件"});
            for (let index = 0; index < 600; index++) {
                const path = join(cwd, `generated-${index}.txt`);
                expect((await runtime.beforeWrite({
                    path,
                    content: null,
                    toolCallId: `write-${index}`,
                })).captured).toBe(true);
                await writeFile(path, `${index}\n`);
                expect((await runtime.afterWrite({
                    path,
                    content: `${index}\n`,
                    toolCallId: `write-${index}`,
                })).captured).toBe(true);
            }
            await runtime.settleTurn();

            const listed = await runtime.listCheckpoints();
            expect(listed[0]?.mutations).toHaveLength(600);
            expect(listed[0]?.fileCoverage).toBe("complete");

            const store = createTestFileCheckpointStore(
                cwd,
                "checkpoint-session"
            );
            const manifest = await readFile(
                getCheckpointManifestPath(store.directory),
                "utf8"
            );
            expect(manifest).not.toContain("mutations");
            expect((await stat(getCheckpointMutationLogPath(
                store.directory,
                checkpoint!.checkpointId
            ))).size).toBeGreaterThan(0);

            const result = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(result.status).toBe("complete");
            expect(result.deletedFiles).toHaveLength(600);
            await expect(readFile(join(cwd, "generated-599.txt"), "utf8"))
                .rejects.toMatchObject({code: "ENOENT"});
        });
    });

    test("文件 Preimage 捕获失败后禁止把恢复描述成完整成功", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "safe.txt");
            await writeFile(path, "before\n");
            const runtime = createRuntime(cwd);
            const checkpoint = await runtime.beginTurn({prompt: "修改多个文件"});
            await runtime.beforeWrite({
                path,
                content: "before\n",
                toolCallId: "edit-safe",
            });
            await writeFile(path, "after\n");
            await runtime.afterWrite({
                path,
                content: "after\n",
                toolCallId: "edit-safe",
            });
            await runtime.markCoverageWarning({
                code: "checkpoint_write_failed",
                path: "not-captured.txt",
                message: "无法保存 Preimage",
            });
            await runtime.settleTurn();

            const listed = await runtime.listCheckpoints();
            expect(listed[0]?.fileCoverage).toBe("incomplete");
            const preview = await runtime.previewRestore(checkpoint!.checkpointId);
            expect(preview.conflicts[0]?.reason).toBe("incomplete_checkpoint");
            const result = await runtime.restoreCode(checkpoint!.checkpointId);
            expect(result.status).toBe("conflict");
            expect(result.restoredFiles).toEqual([]);
            expect(await readFile(path, "utf8")).toBe("after\n");
        });
    });

    test("超过 100 个 Checkpoint 后淘汰旧 metadata 并回收无引用 Blob", async () => {
        await withTempProject(async (cwd) => {
            const path = join(cwd, "rolling.txt");
            await writeFile(path, "v0\n");
            const runtime = createRuntime(cwd);
            for (let index = 0; index < 101; index++) {
                await runtime.beginTurn({prompt: `turn-${index}`});
                const before = `v${index}\n`;
                const after = `v${index + 1}\n`;
                await runtime.beforeWrite({
                    path,
                    content: before,
                    toolCallId: `write-${index}`,
                });
                await writeFile(path, after);
                await runtime.afterWrite({
                    path,
                    content: after,
                    toolCallId: `write-${index}`,
                });
                await runtime.settleTurn();
            }

            expect(await runtime.listCheckpoints()).toHaveLength(100);
            const store = createTestFileCheckpointStore(
                cwd,
                "checkpoint-session"
            );
            await expect(stat(getCheckpointBlobPath(
                store.directory,
                hashCheckpointContent("v0\n")
            ))).rejects.toMatchObject({code: "ENOENT"});
            await expect(stat(getCheckpointBlobPath(
                store.directory,
                hashCheckpointContent("v1\n")
            ))).resolves.toBeDefined();
        });
    });
});
