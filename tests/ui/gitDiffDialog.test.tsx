import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {GitDiffDialog} from "../../src/ui/git/GitDiffDialog.js";
import type {GitDiffSnapshotResult} from "../../src/git/index.js";
import type {GitSessionFileStatus} from "../../src/git/types.js";
import type {PersistedUIEvent} from "../../src/session/index.js";

afterEach(() => cleanup());

const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 20));

function result(): GitDiffSnapshotResult {
    return {
        status: "available",
        snapshot: {
            version: 1,
            repository: {
                version: 1,
                repositoryIdentity: "/project/.git",
                repositoryRoot: "/project",
                branch: "main",
                headOid: "a".repeat(40),
                detached: false,
                unborn: false,
                upstream: null,
                ahead: 0,
                behind: 0,
                operation: "normal",
            clean: false,
            files: [],
            recentCommitTitles: [],
            },
            files: [{
                status: {
                    path: "current.ts",
                    kind: "modified",
                    indexStatus: "M",
                    worktreeStatus: null,
                    staged: true,
                    unstaged: false,
                    submodule: null,
                    provenance: "pillar-observed",
                } as GitSessionFileStatus,
                additions: 1,
                deletions: 1,
                binary: false,
                diffStatus: "complete",
                hunks: [{
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: [
                        {type: "remove", content: "old", oldLineNumber: 1},
                        {type: "add", content: "current", newLineNumber: 1},
                    ],
                }],
            }],
            patch: "patch",
            truncated: false,
            omittedFiles: 0,
        },
    };
}

const turnEvent: PersistedUIEvent = {
    version: 1,
    type: "file_change",
    turnId: "turn-one",
    toolCallId: "call-one",
    timestamp: "2026-07-20T00:00:00.000Z",
    change: {
        version: 1,
        path: "history.ts",
        kind: "update",
        scope: "turn",
        linesAdded: 1,
        linesRemoved: 0,
        diffStatus: "complete",
        hunks: [{
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{type: "add", content: "historical", newLineNumber: 1}],
        }],
    },
};

describe("GitDiffDialog", () => {
    test("先加载当前修改，并可用左右键切换到历史任务", async () => {
        let loaded = 0;
        const view = render(
            <GitDiffDialog
                loadDiff={async () => {
                    loaded += 1;
                    return result();
                }}
                listFileChangeEvents={() => [turnEvent]}
                onClose={() => {}}
            />
        );
        await waitForRender();
        expect(view.lastFrame()).toContain("current.ts");
        expect(view.lastFrame()).toContain("当前未提交修改");
        expect(view.lastFrame()).toContain("当前修改");
        expect(view.lastFrame()).toContain("修改");
        view.stdin.write("\u001B[C");
        await waitForRender();
        expect(view.lastFrame()).toContain("history.ts");
        expect(view.lastFrame()).toContain("会话任务 1 的修改");
        expect(loaded).toBe(1);
    });

    test("没有历史任务时只展示当前修改", async () => {
        let loaded = 0;
        const view = render(
            <GitDiffDialog
                loadDiff={async () => {
                    loaded += 1;
                    return result();
                }}
                listFileChangeEvents={() => []}
                onClose={() => {}}
            />
        );
        await waitForRender();
        expect(view.lastFrame()).toContain("当前修改");
        expect(view.lastFrame()).not.toContain("暂无任务");
        expect(loaded).toBe(1);
    });

    test("历史任务先展示文件列表，ctrl+o 进入并退出 Diff 详情", async () => {
        const longTurnEvent: PersistedUIEvent = {
            ...turnEvent,
            turnId: "turn-long",
            change: {
                ...turnEvent.change,
                path: "long.ts",
                linesAdded: 43,
                hunks: [{
                    oldStart: 1,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 43,
                    lines: Array.from({length: 43}, (_, index) => ({
                        type: "add" as const,
                        content: `line-${index + 1}`,
                        newLineNumber: index + 1,
                    })),
                }],
            },
        };
        const view = render(
            <GitDiffDialog
                loadDiff={async () => result()}
                listFileChangeEvents={() => [longTurnEvent]}
                onClose={() => {}}
            />
        );
        await waitForRender();
        view.stdin.write("\u001B[C");
        await waitForRender();
        expect(view.lastFrame()).not.toContain("line-43");

        view.stdin.write("\u000f");
        await waitForRender();
        expect(view.lastFrame()).toContain("line-43");
        expect(view.lastFrame()).toContain("Ctrl+O 返回");

        view.stdin.write("\u000f");
        await waitForRender();
        expect(view.lastFrame()).not.toContain("line-43");
    });
});
