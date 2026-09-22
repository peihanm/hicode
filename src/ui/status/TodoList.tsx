import {Box, Text} from "ink";
import {useEffect, useState} from "react";
import type {Todo} from "../../todos.js";
import {COLORS, SYMBOLS} from "../theme.js";

// TodoList stays above the input and shows current progress.
//
// pending -> gray checkbox
// in_progress -> themed dot, with a spinner while the agent runs
// completed -> green check, hidden after 30 seconds
//
// Show completion feedback without accumulating old completed items.
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

// Hide completed items after 30 seconds.
const COMPLETED_TTL_MS = 30_000;

export function TodoList({
                             todos,
                             paused = false,
                         }: {
    todos: Todo[];
    paused?: boolean;
}) {
    // Key by content because Todo has no ID. Update UI state only inside effects,
    // avoiding mutations during Ink render.
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

    // Filter items completed more than 30 seconds ago.
    const visibleTodos = todos.filter((t) => {
        if (t.status !== "completed") return true;
        const ts = completionTimes.get(t.content);
        if (!ts) return true; // Show items without a recorded completion time initially.
        return now - ts < COMPLETED_TTL_MS;
    });

    // Schedule a redraw when a visible completed item is about to expire.
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
