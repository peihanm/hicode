import {describe, expect, test} from "bun:test";
import {mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorktreeManifestStore} from "../../src/worktrees/manifest.js";
import type {AgentWorktreeRecord} from "../../src/worktrees/types.js";

function record(): AgentWorktreeRecord {
    return {
        version: 2,
        taskId: "task/with/path",
        sessionId: "session-a",
        sourceCwd: "/repo",
        sourceGitRoot: "/repo",
        mainGitRoot: "/repo",
        path: "/repo/.pillar/worktrees/agent-taskwithpath",
        branch: "pillar-agent-taskwithpath",
        baseCommit: "a".repeat(40),
        sourceHadChanges: false,
        createdAt: "2026-07-26T00:00:00.000Z",
        state: "active",
    };
}

describe("WorktreeManifestStore", () => {
    test("task identity 使用安全文件名，v2 可以原子创建和更新", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pillar-worktree-manifest-"));
        try {
            const store = new WorktreeManifestStore(directory);
            const initial = record();
            await store.create(initial);
            const files = await readdir(directory);
            expect(files.some((file) => file.includes("task/with/path"))).toBe(false);
            expect(await store.load(initial.taskId, initial.sessionId)).toEqual(initial);
            const updated = await store.update(
                initial.taskId,
                initial.sessionId,
                async (current) => ({...current, state: "changed"})
            );
            expect(updated.state).toBe("changed");
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    });

    test("旧版本、未知字段和错误 Session fail closed", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pillar-worktree-manifest-"));
        try {
            const store = new WorktreeManifestStore(directory);
            const initial = record();
            await store.create(initial);
            const file = (await readdir(directory)).find((name) => name.endsWith(".json"));
            if (!file) throw new Error("缺少 Manifest fixture");
            await writeFile(join(directory, file), JSON.stringify({
                ...initial,
                version: 1,
                changedFiles: [],
            }));
            await expect(store.load(initial.taskId, initial.sessionId))
                .rejects.toThrow("格式无效");
            await expect(store.load(initial.taskId, "other-session"))
                .rejects.toThrow("格式无效");
        } finally {
            await rm(directory, {recursive: true, force: true});
        }
    });
});
