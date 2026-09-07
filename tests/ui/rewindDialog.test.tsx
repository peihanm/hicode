import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {RewindDialog} from "../../src/ui/rewind/RewindDialog.js";
import type {RewindPoint} from "../../src/session/fork.js";

afterEach(() => cleanup());

const checkpoint: RewindPoint = {
    checkpointId: "checkpoint-1", createdAt: new Date().toISOString(), promptPreview: "请修改 app.ts",
    capture: {kind: "available", count: 0, status: "saved"},
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
        expect(frame).toContain("↶ Rewind  选择对话恢复点");
        expect(frame).toContain("◇ 暂无可恢复点");
        expect(frame).toContain("范围 · 仅恢复文件工具记录的修改");
        expect(frame).toContain("Bash 生成的源码、锁文件、依赖、缓存及外部服务不回退");
        const lines = frame.split("\n");
        const panelBottom = lines.findIndex((line) => line.startsWith("╰"));
        const controls = lines.findIndex((line) => line.includes("Esc 返回"));
        expect(panelBottom).toBeGreaterThan(0);
        expect(controls).toBeGreaterThan(panelBottom);
    });

    test("任务列表说明恢复边界，序号严格对齐并截断长问题", async () => {
        const longPrompt = "我想做一个能让我自己刷 leetcode 的网站，支持本地写题、运行程序和查看测试结果。".repeat(3);
        const partialCheckpoint: RewindPoint = {
            ...checkpoint,
            checkpointId: "checkpoint-2",
            promptPreview: longPrompt,
            capture: {kind: "available", count: 0, status: "external"},
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
        expect(frame).toContain("选择历史问题");
        expect(frame).toContain("从该问题提交前重新对话，或同时恢复已记录文件");
        expect(frame).toContain(
            "捕获不完整时仍可重新对话；Bash、MCP 或 Hook 的外部副作用无法撤销"
        );
        expect(frame).toContain("受控文件已保存");
        expect(frame).toContain("含范围外操作");
        expect(frame).toContain("…");
        const lines = frame.split("\n");
        const first = lines.find((line) => line.includes("1  <1m")) ?? "";
        const second = lines.find((line) => line.includes("2  <1m")) ?? "";
        expect(first).toContain("❯ 1");
        expect(second).not.toContain("❯");
        expect(first.indexOf("1  <1m")).toBe(second.indexOf("2  <1m"));
    });

    test("键盘选择恢复点和动作后预览并确认代码与对话恢复", async () => {
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
        expect(view.lastFrame()).toContain("选择恢复方式");
        view.stdin.write("\r");
        await waitForRender();
        expect(view.lastFrame()).toContain("恢复预览");
        expect(view.lastFrame()).toContain(
            "目标 · 恢复对话及已记录文件到“请修改 app.ts”提交前"
        );
        expect(view.lastFrame()).not.toContain("选择恢复方式");
        view.stdin.write("\r");
        await waitForRender();
        view.stdin.write("\r");
        await waitForRender();

        expect(restoredCheckpoints).toEqual(["checkpoint-1"]);
    });
});

test("文件记录不可用时仍能选择对话分支，且不调用文件恢复", async () => {
    let forked: string | undefined;
    const view = render(<RewindDialog
        listCheckpoints={async () => [{...checkpoint, capture: {kind: "unavailable"}}]}
        previewCheckpoint={async () => {throw new Error("should not preview");}}
        restoreCheckpoint={async () => {throw new Error("should not restore");}}
        forkConversation={async id => {forked = id;}}
        onClose={() => {}}
    />);
    await waitForRender(); view.stdin.write("\r"); await waitForRender();
    expect(view.lastFrame()).toContain("从这里重新对话，保留当前文件");
    expect(view.lastFrame()).not.toContain("恢复对话及已记录文件（先预览）");
    view.stdin.write("\r"); await waitForRender();
    expect(forked).toBe(checkpoint.checkpointId);
});
