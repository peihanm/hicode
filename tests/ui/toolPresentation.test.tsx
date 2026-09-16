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

describe("phase-based tool presentation", () => {
    test("连续成功探索合并为项目检查阶段，tool_search 静默吸收", () => {
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
            result: "File: src/runtime/resources.ts\nLine range: 1-20 / 20\n\n内容",
        });

        expect(projectDefaultThreads(threads)).toHaveLength(1);
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("● Inspecting project");
        expect(frame).toContain("✓ Listed src · Found 2 results");
        expect(frame).toContain("✓ Searched for \"createRuntime\"");
        expect(frame).toContain("✓ Read src/runtime/resources.ts · 20 lines");
        expect(frame).not.toContain("Tool search");
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
                content: "File: src/a.ts\nLine range: 1-1 / 1\n\n1\ta",
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
        expect(frame).toContain("● Inspecting project");
        expect(frame).toContain("✓ Read src/a.ts · 1 line");
    });

    test("单个和连续探索调用都保留具体目标", () => {
        const single = completeTool([], {
            id: "read-one",
            name: "read_file",
            args: {path: "src/server.ts"},
            result: "File: src/server.ts\nLine range: 1-20 / 20\n\n内容",
        });
        const singleFrame = render(
            <MessageList threads={single}/>
        ).lastFrame() ?? "";
        expect(singleFrame).toContain("● Inspecting project");
        expect(singleFrame).toContain("✓ Read src/server.ts · 20 lines");

        const multiple = completeTool(single, {
            id: "read-two",
            name: "read_file",
            args: {path: "src/client.ts"},
            result: "File: src/client.ts\nLine range: 1-10 / 10\n\n内容",
        });
        const multipleFrame = render(
            <MessageList threads={multiple}/>
        ).lastFrame() ?? "";
        expect(multipleFrame).toContain("● Inspecting project");
        expect(multipleFrame).toContain("✓ Read src/server.ts · 20 lines");
        expect(multipleFrame).toContain("✓ Read src/client.ts · 10 lines");
        expect(multipleFrame).not.toContain("● Read src/server.ts");
    });

    test("失败的搜索保持独立错误行，并切断前后活动组", () => {
        let threads: UIThread[] = [];
        threads = completeTool(threads, {
            id: "read-before",
            name: "read_file",
            args: {path: "before.ts"},
            result: "File: before.ts\nLine range: 1-1 / 1\n\n1\tbefore",
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
            result: "File: after.ts\nLine range: 1-1 / 1\n\n1\tafter",
        });

        const projected = projectDefaultThreads(threads);
        expect(projected).toHaveLength(3);
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame.match(/● Inspecting project/g)).toHaveLength(2);
        expect(frame).toContain("✓ Read before.ts · 1 line");
        expect(frame).toContain("✓ Read after.ts · 1 line");
        expect(frame).toContain("● Search pattern: \"x\", path: missing");
        expect(frame).toContain("工具执行出错: 搜索目录不存在");
    });

    test("Bash 默认显示真实命令与预览，Transcript 保留完整输出", () => {
        const threads = completeTool([], {
            id: "bash",
            name: "bash",
            args: {command: "bun test"},
            result: ["one", "two", "three", "four", "five"].join("\n"),
        });
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).not.toContain("● Verifying");
        expect(frame).not.toContain("Project checks passed");
        expect(frame).toContain("bun test");
        expect(frame).toContain("one");
        expect(frame).not.toContain("five");

        const transcript = render(
            <MessageList threads={threads} transcript/>
        ).lastFrame() ?? "";
        expect(transcript).toContain("● Bash bun test");
        expect(transcript).toContain("five");
    });

    test.each(["echo npm test", "bun test", "node --check app.js", "curl -sf http://localhost:8000", "node server.js"])("Bash %s 不派生验证或服务结论", command => {
        const threads = completeTool([], {id: "bash", name: "bash", args: {command}, result: "original output"});
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("● Bash");
        expect(frame).toContain(command);
        expect(frame).toContain("original output");
        expect(frame).not.toContain("checks passed");
        expect(frame).not.toContain("Service running");
    });

    test("普通后台命令默认结果保留生命周期说明", () => {
        const threads = completeTool([], {
            id: "background-worker",
            name: "bash",
            args: {command: "node worker.js", run_in_background: true},
            result: "Background task started.\nTask: worker-123\nLifecycle: managed by the current HiCode Runtime; terminates when HiCode exits.\nStatus: running\nCwd: .\nUse task to inspect output, completion status or stop the task.",
        });
        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).toContain("worker-123");
        expect(frame).toContain("terminates when HiCode exits");
    });

    test("curl 批次即使 exit 0 也不会把 000FAIL 包装成验证通过", () => {
        const threads = completeTool([], {
            id: "endpoint-false-positive",
            name: "bash",
            args: {
                command: "for f in / /app.js; do curl -sf http://127.0.0.1:8173$f || echo FAIL; done",
            },
            result: "/ -> 000FAIL\n/app.js -> 000FAIL",
        });

        const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
        expect(frame).not.toContain("Local endpoint checks passed");
        expect(frame).toContain("● Bash");
        expect(frame).toContain("000FAIL");
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
        expect(frame).not.toContain("⎿Permission denied");
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
        expect(frame).toContain("Full output is available in task details");
        expect(frame).not.toContain("完整输出可通过");
    });
});
