import {Box, Text} from "ink";
import {useEffect, useState} from "react";
import type {Todo} from "../../todos.js";
import {COLORS, SYMBOLS} from "../theme.js";

// TodoList 渲染：固定在输入框上方，展示当前进度
//
// pending     → ☐ 灰色
// in_progress → ● 主题色（agent 在跑时加 spinner）
// completed   → ✓ 绿色，30 秒后自动隐藏
//
// 30 秒隐藏参考 claude-code TaskListV2.tsx:27 RECENT_COMPLETED_TTL_MS
// 让用户看到完成反馈，但不堆积历史完成项

// pending     → ☐ 灰色
// in_progress → ● 主题色（paused 时静态，否则 spinner）
// completed   → ✓ 绿色（30 秒后隐藏）
function TodoItem({todo, paused}: { todo: Todo; paused: boolean }) {
    if (todo.status === "completed") {
        return (
            <Box>
                <Text color="green">✓ </Text>
                <Text color={COLORS.dim}>{todo.content}</Text>
            </Box>
        );
    }
    if (todo.status === "in_progress") {
        return (
            <Box>
                <Text color={COLORS.accent}>
                    {paused ? SYMBOLS.assistantMark : SYMBOLS.spinner}
                </Text>
                <Text color={COLORS.accent}> {todo.activeForm}</Text>
            </Box>
        );
    }
    return (
        <Box>
            <Text color={COLORS.dim}>☐ {todo.content}</Text>
        </Box>
    );
}

// 30 秒后隐藏 completed 项
const COMPLETED_TTL_MS = 30_000;

export function TodoList({
                             todos,
                             paused = false,
                         }: {
    todos: Todo[];
    paused?: boolean;
}) {
    // key = content（当前 Todo 协议没有 id）。只在 effect 中更新 UI 状态，
    // 避免 Ink render 本身产生 mutation。
    const [completionTimes, setCompletionTimes] = useState<Map<string, number>>(
        () => new Map()
    );
    const [, forceUpdate] = useState(0);

    const now = Date.now();
    const currentCompleted = new Set(
        todos.filter((t) => t.status === "completed").map((t) => t.content)
    );

    useEffect(() => {
        setCompletionTimes((previous) => {
            const next = new Map(previous);
            let changed = false;
            for (const content of currentCompleted) {
                if (!next.has(content)) {
                    next.set(content, Date.now());
                    changed = true;
                }
            }
            for (const content of next.keys()) {
                if (!currentCompleted.has(content)) {
                    next.delete(content);
                    changed = true;
                }
            }
            return changed ? next : previous;
        });
    }, [todos]);

    // 过滤掉 30 秒前完成的
    const visibleTodos = todos.filter((t) => {
        if (t.status !== "completed") return true;
        const ts = completionTimes.get(t.content);
        if (!ts) return true; // 没记录的先显示（防御）
        return now - ts < COMPLETED_TTL_MS;
    });

    // 如果有即将过期的 completed，设定时器触发重渲染
    useEffect(() => {
        if (completionTimes.size === 0) return;
        let earliestExpiry = Infinity;
        for (const ts of completionTimes.values()) {
            const expiry = ts + COMPLETED_TTL_MS;
            if (expiry > Date.now() && expiry < earliestExpiry) {
                earliestExpiry = expiry;
            }
        }
        if (earliestExpiry === Infinity) return;
        const delay = earliestExpiry - Date.now();
        const timer = setTimeout(() => forceUpdate((n) => n + 1), delay);
        return () => clearTimeout(timer);
    }, [completionTimes]);

    if (visibleTodos.length === 0) return null;

    return (
        <Box flexDirection="column" marginTop={1}>
            {visibleTodos.map((todo, i) => (
                <TodoItem key={i} todo={todo} paused={paused}/>
            ))}
        </Box>
    );
}
