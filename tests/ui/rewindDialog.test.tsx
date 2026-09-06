import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {RewindDialog} from "../../src/ui/rewind/RewindDialog.js";
import type {FileCheckpointRecord} from "../../src/checkpoints/index.js";

afterEach(() => cleanup());

const checkpoint: FileCheckpointRecord = {
    version: 3,
    checkpointId: "checkpoint-1",
    sessionId: "session-1",
    branchId: "branch-1",
    sequence: 1,
    createdAt: new Date().toISOString(),
    prompt: "请修改 app.ts",
    promptPreview: "请修改 app.ts",
    status: "settled",
    fileCoverage: "complete",
    coverageWarnings: [],
    mutations: [],
};

const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("RewindDialog", () => {
    test("没有 checkpoint 时显示明确空状态", async () => {
        const view = render(
            <RewindDialog
                listCheckpoints={async () => []}
                previewCheckpoint={async () => ({
                    checkpointId: "unused",
                    files: [],
                    conflicts: [],
                    coverageWarnings: [],
                })}
                restoreCheckpoint={async () => {
                    throw new Error("should not run");
                }}
                onClose={() => {}}
            />
        );
        await waitForRender();
        const frame = view.lastFrame() ?? "";
        expect(frame).toContain("↶ Rewind  恢复代码与对话状态");
        expect(frame).toContain("◇ 暂无可恢复点");
        expect(frame).toContain("范围 · 恢复捕获的文件");
        expect(frame).toContain("Shell 安装的依赖、包缓存和外部服务不回退");
        expect(frame).toContain("依赖声明变化后需重新安装");
        const lines = frame.split("\n");
        const panelBottom = lines.findIndex((line) => line.startsWith("╰"));
        const controls = lines.findIndex((line) => line.includes("Esc 返回"));
        expect(panelBottom).toBeGreaterThan(0);
        expect(controls).toBeGreaterThan(panelBottom);
    });

    test("任务列表说明恢复边界，序号严格对齐并截断长问题", async () => {
        const longPrompt = "我想做一个能让我自己刷 leetcode 的网站，支持本地写题、运行程序和查看测试结果。".repeat(3);
        const partialCheckpoint: FileCheckpointRecord = {
            ...checkpoint,
            checkpointId: "checkpoint-2",
            sequence: 2,
            prompt: longPrompt,
            promptPreview: longPrompt,
            coverageWarnings: [{
                code: "bash_side_effects",
                message: "Bash 可能产生未捕获副作用",
            }],
        };
        const view = render(
            <RewindDialog
                listCheckpoints={async () => [checkpoint, partialCheckpoint]}
                previewCheckpoint={async () => ({
                    checkpointId: "unused",
                    files: [],
                    conflicts: [],
                    coverageWarnings: [],
                })}
                restoreCheckpoint={async () => {
                    throw new Error("should not run");
                }}
                onClose={() => {}}
            />
        );
        await waitForRender();

        const frame = view.lastFrame() ?? "";
        expect(frame).toContain("选择要撤销的任务");
        expect(frame).toContain("代码与对话将恢复到该问题提交前");
        expect(frame).toContain(
            "文件捕获不完整时禁止恢复；Bash、MCP 或 Hook 的外部副作用无法撤销"
        );
        expect(frame).toContain("文件覆盖完整");
        expect(frame).toContain("存在外部副作用");
        expect(frame).toContain("…");
        const lines = frame.split("\n");
        const first = lines.find((line) => line.includes("1  <1m")) ?? "";
        const second = lines.find((line) => line.includes("2  <1m")) ?? "";
        expect(first).toContain("❯ 1");
        expect(second).not.toContain("❯");
        expect(first.indexOf("1  <1m")).toBe(second.indexOf("2  <1m"));
    });

    test("键盘选择恢复点后直接预览并确认代码与对话恢复", async () => {
        const restoredCheckpoints: string[] = [];
        const view = render(
            <RewindDialog
                listCheckpoints={async () => [checkpoint]}
                previewCheckpoint={async (checkpointId) => ({
                    checkpointId,
                    files: [],
                    conflicts: [],
                    coverageWarnings: [],
                })}
                restoreCheckpoint={async (checkpointId) => {
                    restoredCheckpoints.push(checkpointId);
                    return {
                        status: "complete",
                        checkpointId,
                        restoredFiles: [],
                        deletedFiles: [],
                        conflicts: [],
                        failures: [],
                        coverageWarnings: [],
                    };
                }}
                onClose={() => {}}
            />
        );
        await waitForRender();
        view.stdin.write("\r");
        await waitForRender();
        expect(view.lastFrame()).toContain("恢复预览");
        expect(view.lastFrame()).toContain(
            "目标 · 恢复代码与对话到“请修改 app.ts”提交前"
        );
        expect(view.lastFrame()).not.toContain("选择恢复方式");
        view.stdin.write("\r");
        await waitForRender();
        view.stdin.write("\r");
        await waitForRender();

        expect(restoredCheckpoints).toEqual(["checkpoint-1"]);
    });
});
