import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {GitDiffDialog} from "../../src/ui/git/GitDiffDialog.js";
import type {GitDiffSnapshotResult} from "../../src/git/index.js";
import type {GitFileStatus} from "../../src/git/types.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import stringWidth from "string-width";

afterEach(() => cleanup());

const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 20));

function result(): GitDiffSnapshotResult {
    return {
        status: "available",
        snapshot: {
            version: 1,
            repository: {
                version: 1,
                repositoryRoot: "/project",
                branch: "main",
                headOid: "a".repeat(40),
                detached: false,
                unborn: false,
                operation: "normal",
            clean: false,
            files: [],
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
                } as GitFileStatus,
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

describe("GitDiffDialog", () => {
    test("App rerenders preserve the open diff; Escape returns before closing", async () => {
        await withTempProject(async cwd => {
            const resources = createTestRuntimeResources(cwd);
            let reads = 0;
            const configured = {...resources, gitWorkspace: {...resources.gitWorkspace,
                diff: async () => {reads++; return result();},
            }};
            const view = render(<AppForTest resources={configured}/>);
            try {
                await waitForRender();
                view.stdin.write("/diff"); await waitForRender();
                view.stdin.write("\r"); await waitForRender();
                view.stdin.write("\r"); await waitForRender();
                expect((view.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Esc back to files");
                expect(view.lastFrame()).not.toContain("ctrl+o transcript");
                const before = reads;
                view.rerender(<AppForTest resources={configured}/>);
                await waitForRender();
                expect(reads).toBe(before);
                expect((view.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Esc back to files");
                view.stdin.write("\u000f"); await waitForRender();
                expect((view.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Esc back to files");
                view.stdin.write("\u001b"); await waitForRender();
                expect(view.lastFrame()).toContain("Enter view");
                view.stdin.write("\u001b"); await waitForRender();
                expect(view.lastFrame()).toContain("Ask HiCode");
                expect(view.lastFrame()).toContain("ctrl+o transcript");
            } finally {view.unmount(); await resources.close();}
        });
    });

    test("refresh preserves file identity across reorder and a failed read", async () => {
        const initial = result();
        if (initial.status !== "available") throw new Error("fixture unavailable");
        const file = initial.snapshot.files[0]!;
        const other = {...file, status: {...file.status, path: "other.ts"}};
        let reads = 0;
        const view = render(<GitDiffDialog onClose={() => {}} loadDiff={async () => {
            reads++;
            if (reads === 3) throw new Error("Temporary Git error");
            return {...initial, snapshot: {...initial.snapshot, files: reads === 1 ? [file, other] : [other, file]}};
        }}/>);
        await waitForRender();
        view.stdin.write("\r"); await waitForRender();
        for (let index = 0; index < 3; index++) {
            view.stdin.write("r"); await waitForRender();
            expect((view.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Esc back to files");
        }
        expect(reads).toBe(4);
        expect(view.lastFrame()).toContain("current.ts");
        expect(view.lastFrame()).not.toContain("other.ts");
        view.stdin.write("\u001b"); await waitForRender();
        expect(view.lastFrame()).toContain("❯ current.ts");
    });

    test("borderless list and detail fit narrow terminals", async () => {
        const view = render(<GitDiffDialog loadDiff={async () => result()} onClose={() => {}}/>);
        let columns = 90;
        Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
        for (const width of [90, 56, 32]) {
            columns = width; view.stdout.emit("resize");
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(view.lastFrame()).not.toMatch(/[╭╰│]/);
            expect(view.lastFrame()).not.toContain("Ctrl+O");
            expect((view.lastFrame() ?? "").split("\n").every(line => stringWidth(line) <= width)).toBe(true);
            view.stdin.write("\r"); await waitForRender();
            expect((view.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("Esc back to files");
            expect((view.lastFrame() ?? "").split("\n").every(line => stringWidth(line) <= width)).toBe(true);
            view.stdin.write("\u001b"); await waitForRender();
        }
    });

    test("只加载当前 Git 修改，左右键不切换来源", async () => {
        let loaded = 0;
        const view = render(<GitDiffDialog loadDiff={async () => {loaded++; return result();}} onClose={() => {}} />);
        await waitForRender();
        expect(view.lastFrame()).toContain("Current uncommitted changes");
        expect(view.lastFrame()).toContain("current.ts");
        expect(view.lastFrame()).not.toContain("Sources");
        expect(view.lastFrame()).not.toContain("任务 1");
        view.stdin.write("\u001B[C");
        view.stdin.write("\u001B[D");
        await waitForRender();
        expect(view.lastFrame()).toContain("current.ts");
        expect(loaded).toBe(1);
    });

    test("当前文件可展开完整差异并返回列表，r 读取最新 Git 状态", async () => {
        const current = result();
        if (current.status !== "available") throw new Error("fixture unavailable");
        current.snapshot.files[0]!.hunks[0]!.lines = Array.from({length: 43}, (_, index) => ({
            type: "add", content: `line-${index + 1}`, newLineNumber: index + 1,
        }));
        let loaded = 0;
        let closed = 0;
        const view = render(<GitDiffDialog loadDiff={async () => {
            loaded++;
            return loaded === 1 ? current : {...current, snapshot: {...current.snapshot, files: []}};
        }} onClose={() => {closed++;}} />);
        await waitForRender();
        expect(view.lastFrame()).not.toContain("line-43");
        view.stdin.write("\r");
        await waitForRender();
        expect(view.lastFrame()).toContain("line-43");
        view.stdin.write("\u001b");
        await waitForRender();
        expect(view.lastFrame()).not.toContain("line-43");
        expect(closed).toBe(0);
        view.stdin.write("\r");
        await waitForRender();
        expect(view.lastFrame()).toContain("line-43");
        view.stdin.write("r");
        await waitForRender();
        expect(loaded).toBe(2);
        expect(view.lastFrame()).toContain("No uncommitted changes");
        view.stdin.write("\u001B");
        await waitForRender();
        expect(closed).toBe(1);
    });

    test("读取失败后可以刷新重试，关闭时取消加载", async () => {
        const signals: AbortSignal[] = [];
        const view = render(<GitDiffDialog loadDiff={async signal => {
            signals.push(signal);
            if (signals.length === 1) throw new Error("Git unavailable");
            return result();
        }} onClose={() => {}} />);
        await waitForRender();
        expect(view.lastFrame()).toContain("Git unavailable");
        view.stdin.write("r");
        await waitForRender();
        expect(signals[0]!.aborted).toBe(true);
        expect(view.lastFrame()).toContain("current.ts");
        view.unmount();
        await waitForRender();
        expect(signals[1]!.aborted).toBe(true);
    });
});
