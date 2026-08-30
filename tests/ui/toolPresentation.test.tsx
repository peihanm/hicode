import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import {projectDefaultThreads} from "../../src/ui/conversation/projection.js";
import {reduceThreads, threadsFromHistory,} from "../../src/ui/conversation/threadReducer.js";
import type {UIThread} from "../../src/ui/conversation/types.js";

afterEach(() => cleanup());

function completeTool(
    threads: UIThread[],
    input: {
        id: string;
        name: string;
        args: Record<string, unknown>;
        result: string;
        outcome?: "ok" | "failed" | "denied" | "interrupted";
    }
): UIThread[] {
    const started = reduceThreads(threads, {
        type: "tool_call_start",
        turnId: "turn-1",
        toolCallId: input.id,
        name: input.name,
        args: JSON.stringify(input.args),
    });
    return reduceThreads(started, {
        type: "tool_call_end",
        turnId: "turn-1",
        toolCallId: input.id,
        result: input.result,
        outcome: input.outcome ?? "ok",
    });
}

describe("Claude-style tool presentation", () => {
    test("连续成功探索合并为一条活动摘要，tool_search 静默吸收", () => {
        let threads: UIThread[] = [];
        threads = completeTool(threads, {
            id: "search-tool",
            name: "tool_search",
            args: {query: "select:glob"},
            result: "Loaded glob",
        });
        threads = completeTool(threads, {
            id: "list",
            name: "list_files",
            args: {dir: "src"},
            result: "agent/\nruntime/",
        });
        threads = completeTool(threads, {
            id: "grep",
            name: "grep",
            args: {pattern: "createRuntime", path: "src"},
            result: "src/runtime/resources.ts:10",
        });
        threads = completeTool(threads, {
            id: "read",
            name: "read_file",
            args: {path: "src/runtime/resources.ts"},
            result: "文件: src/runtime/resources.ts\n行范围: 1-20 / 20\n\n内容",
        });

        expect(projectDefaultThreads(threads)).toHaveLength(1);
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("searched 1 pattern, read 1 file, listed 1 directory");
        expect(frame).not.toContain("Tool search");
        expect(frame).not.toContain("createRuntime");
    });

    test("Session outcome 元数据让恢复后的成功探索保持同一投影", () => {
        const threads = threadsFromHistory([
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "read-1",
                    type: "function",
                    function: {
                        name: "read_file",
                        arguments: JSON.stringify({path: "src/a.ts"}),
                    },
                }],
            },
            {
                role: "tool",
                tool_call_id: "read-1",
                content: "文件: src/a.ts\n行范围: 1-1 / 1\n\n1\ta",
            },
        ], [{
            version: 1,
            type: "tool_call",
            turnId: "turn-1",
            toolCallId: "read-1",
            timestamp: "2026-07-28T00:00:00.000Z",
            outcome: "ok",
        }]);

        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("● Read src/a.ts");
        expect(frame).toContain("⎿ Read 1 line");
        expect(frame).not.toContain("read 1 file");
    });

    test("单个探索调用保留目标，多次调用才生成活动摘要", () => {
        const single = completeTool([], {
            id: "read-one",
            name: "read_file",
            args: {path: "src/server.ts"},
            result: "文件: src/server.ts\n行范围: 1-20 / 20\n\n内容",
        });
        const singleFrame = render(
            <MessageList threads={single}/>
        ).lastFrame() ?? "";
        expect(singleFrame).toContain("● Read src/server.ts");
        expect(singleFrame).toContain("⎿ Read 20 lines");
        expect(singleFrame).not.toContain("read 1 file");

        const multiple = completeTool(single, {
            id: "read-two",
            name: "read_file",
            args: {path: "src/client.ts"},
            result: "文件: src/client.ts\n行范围: 1-10 / 10\n\n内容",
        });
        const multipleFrame = render(
            <MessageList threads={multiple}/>
        ).lastFrame() ?? "";
        expect(multipleFrame).toContain("read 2 files");
        expect(multipleFrame).not.toContain("● Read src/server.ts");
    });

    test("失败的搜索保持独立错误行，并切断前后活动组", () => {
        let threads: UIThread[] = [];
        threads = completeTool(threads, {
            id: "read-before",
            name: "read_file",
            args: {path: "before.ts"},
            result: "文件: before.ts\n行范围: 1-1 / 1\n\n1\tbefore",
        });
        threads = completeTool(threads, {
            id: "grep-failed",
            name: "grep",
            args: {pattern: "x", path: "missing"},
            result: "工具执行出错: 搜索目录不存在",
            outcome: "failed",
        });
        threads = completeTool(threads, {
            id: "read-after",
            name: "read_file",
            args: {path: "after.ts"},
            result: "文件: after.ts\n行范围: 1-1 / 1\n\n1\tafter",
        });

        const projected = projectDefaultThreads(threads);
        expect(projected).toHaveLength(3);
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("● Read before.ts");
        expect(frame).toContain("● Read after.ts");
        expect(frame).toContain("● Search pattern: \"x\", path: missing");
        expect(frame).toContain("工具执行出错: 搜索目录不存在");
    });

    test("Bash 默认保留前三行和明确的折叠边界", () => {
        const threads = completeTool([], {
            id: "bash",
            name: "bash",
            args: {command: "bun test"},
            result: ["one", "two", "three", "four", "five"].join("\n"),
        });
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("⎿ one");
        expect(frame).toContain("three");
        expect(frame).toContain("… +2 lines (ctrl+o to expand)");
        expect(frame).not.toContain("five");

        const transcript = render(
            <MessageList threads={threads} transcript/>
        ).lastFrame() ?? "";
        expect(transcript).toContain("five");
    });

    test("拒绝结果在标记后保留固定间距", () => {
        const threads = completeTool([], {
            id: "write-denied",
            name: "write_file",
            args: {path: "/tmp/existing.txt", content: "content"},
            result: "权限拒绝: 文件已存在，请先读取后再修改。",
            outcome: "denied",
        });

        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("⎿ 权限拒绝: 文件已存在，请先读取后再修改。");
        expect(frame).not.toContain("⎿权限拒绝");
        expect(frame).toContain("● Write /tmp/existing.txt");
        expect(frame).not.toContain("content=content");
    });

    test("Bash 忽略首尾空白行但保留正文内部空行", () => {
        const threads = completeTool([], {
            id: "bash-whitespace",
            name: "bash",
            args: {command: "npm install"},
            result: "\n\nadded 1 package\n\naudit complete\n\n",
        });
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("⎿ added 1 package");
        expect(frame).toContain("audit complete");

        const empty = completeTool([], {
            id: "bash-empty",
            name: "bash",
            args: {command: "true"},
            result: "\n  \n",
        });
        expect(render(<MessageList threads={empty}/>).lastFrame()).toContain(
            "⎿ (no output)"
        );
    });

    test("运行中 Agent 仅展示最近三次工具活动，Transcript 保留完整进度", () => {
        let threads = reduceThreads([], {
            type: "tool_call_start",
            turnId: "turn-1",
            toolCallId: "agent",
            name: "agent",
            args: JSON.stringify({
                subagent_type: "Explore",
                description: "调查 Runtime",
            }),
        });
        threads = reduceThreads(threads, {
            type: "subagent_start",
            agentId: "child",
            agentType: "Explore",
            description: "调查 Runtime",
            parentToolCallId: "agent",
        });
        for (let index = 1; index <= 4; index++) {
            threads = reduceThreads(threads, {
                type: "subagent_progress",
                agentId: "child",
                event: {
                    type: "tool_start",
                    toolCallId: `read-${index}`,
                    name: "read_file",
                    args: JSON.stringify({path: `src/${index}.ts`}),
                },
            });
        }

        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("+1 more tool use (ctrl+o to expand)");
        expect(frame).not.toContain("src/1.ts");
        expect(frame).toContain("src/4.ts");

        const transcript = render(
            <MessageList threads={threads} transcript/>
        ).lastFrame() ?? "";
        expect(transcript).toContain("src/1.ts");
        expect(transcript).toContain("src/4.ts");
    });

    test("同一批并行 Agent 使用树形批次摘要", () => {
        const threads: UIThread[] = [
            {
                id: "a1",
                role: "tool_call",
                turnId: "turn-1",
                toolCallId: "a1",
                name: "agent",
                args: JSON.stringify({
                    subagent_type: "Explore",
                    description: "调查前端",
                }),
                status: "done",
                outcome: "ok",
                result: "Done (3 tool calls · 2 iterations · 1s)",
            },
            {
                id: "a2",
                role: "tool_call",
                turnId: "turn-1",
                toolCallId: "a2",
                name: "agent",
                args: JSON.stringify({
                    subagent_type: "Explore",
                    description: "调查后端",
                }),
                status: "done",
                outcome: "ok",
                result: "Done (4 tool calls · 3 iterations · 2s)",
            },
        ];
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("● 2 agents finished");
        expect(frame).toContain("├─ Explore · 调查前端");
        expect(frame).toContain("└─ Explore · 调查后端");
    });

    test("后台任务失败使用专用行并直接展示首要原因", () => {
        const threads: UIThread[] = [{
            id: "task-notification",
            role: "task_notification",
            taskId: "task-1",
            ownerToolCallId: "bash-1",
            kind: "shell",
            label: "node server.js",
            status: "failed",
            summary: "exit 1 · Error: listen EADDRINUSE :::3000",
            resultId: "task_task-1",
        }];
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("● Background task failed · node server.js");
        expect(frame).toContain("⎿ exit 1 · Error: listen EADDRINUSE :::3000");
        expect(frame).toContain("Full output: read_tool_result(task_task-1)");
        expect(frame).not.toContain("完整输出可通过");
    });
});
