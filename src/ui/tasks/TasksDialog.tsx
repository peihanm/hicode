import {agentRunTiming} from "../../tasks/timing.js";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {TaskSessionLike, TaskSnapshot} from "../../tasks/types.js";
import {COLORS} from "../theme.js";
import {layoutTerminalMarkdown} from "../conversation/TerminalMarkdown.js";
import {useTerminalSize} from "../terminalSize.js";
import {stripVTControlCharacters} from "node:util";
import stringWidth from "string-width";

const labels = {running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted"};
const markers = {running: "●", completed: "✓", failed: "!", cancelled: "○", interrupted: "◷"};
const statusColors = {running: COLORS.accent, completed: COLORS.diffAdded, failed: COLORS.error, cancelled: COLORS.dim, interrupted: COLORS.dim};
const title = (task: TaskSnapshot) => (task.kind === "shell" ? task.command : task.kind === "memory" ? "Memory consolidation" : task.description).replace(/\s+/g, " ").trim();
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
const graphemes = new Intl.Segmenter(undefined, {granularity: "grapheme"});

function fit(value: string, width: number): string {
    if (stringWidth(value) <= width) return value + " ".repeat(Math.max(0, width - stringWidth(value)));
    let result = "";
    for (const {segment} of graphemes.segment(value)) {
        if (stringWidth(result + segment) > width - 1) break;
        result += segment;
    }
    return result + "…" + " ".repeat(Math.max(0, width - stringWidth(result) - 1));
}

function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function metadata(task: TaskSnapshot): string {
    if (task.kind === "agent") return `${clean(task.agentName ?? task.agentType)} · Run ${task.progress.runCount} · ${duration(agentRunTiming(task).runMs)}`;
    const elapsed = (task.completedAt ? Date.parse(task.completedAt) : Date.now()) - Date.parse(task.startedAt);
    return `${task.kind === "shell" ? "Command" : "Memory"} · ${duration(elapsed)}`;
}

export function TasksDialog({tasks, stopTask, onClose}: {
    tasks: TaskSessionLike;
    stopTask(id: string): Promise<void>;
    onClose(): void;
}) {
    const [items, setItems] = useState<readonly TaskSnapshot[]>([]);
    const [selectedId, setSelectedId] = useState<string>();
    const [detail, setDetail] = useState<TaskSnapshot>();
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [loaded, setLoaded] = useState(false);
    const alive = useRef(false);
    const revision = useRef(0);
    const detailId = useRef<string>();
    const {width, height} = useTerminalSize();
    const panelWidth = Math.max(8, Math.min(120, width - 4));
    const visibleTasks = Math.max(1, Math.floor((height - 13) / 3));
    const visibleLines = Math.max(2, height - 15 - (panelWidth < 60 ? 1 : 0));
    const compact = panelWidth < 60;
    const refresh = useCallback(async () => {
        const current = ++revision.current;
        try {
            const next = await tasks.list();
            const snapshot = detailId.current ? await tasks.get(detailId.current) : undefined;
            if (!alive.current || current !== revision.current) return;
            const sorted = [...next].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt.localeCompare(a.startedAt));
            setItems(sorted);
            setSelectedId(current => sorted.some(task => task.id === current) ? current : sorted[0]?.id);
            setDetail(snapshot);
            setLoaded(true);
        } catch (reason) {if (alive.current && current === revision.current) {setError(String(reason).slice(0, 500)); setLoaded(true);}}
    }, [tasks]);
    useEffect(() => {
        alive.current = true;
        void refresh();
        const unsubscribe = tasks.subscribe(() => {void refresh();});
        return () => {alive.current = false; revision.current++; unsubscribe();};
    }, [refresh, tasks]);
    const index = Math.max(0, items.findIndex(task => task.id === selectedId));
    const active = detail ?? items[index];
    const output = detail?.kind === "shell" ? detail.output : detail?.resultPreview;
    const report = detail?.kind === "agent" ? [
        `Total execution: ${duration(agentRunTiming(detail).totalMs)}`,
        `Todos this run: ${detail.progress.todosUpdated ? "updated" : "not updated"}`,
        "",
        ...(detail.progress.todos?.length ? [detail.progress.todosUpdated ? "## Progress" : "## Unfinished plan from previous run", ...detail.progress.todos.map(todo => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "›" : "☐"} ${todo.content}`), ""] : []),
        ...(detail.progress.lastMessage ? ["## Latest message", detail.progress.lastMessage, ""] : []),
        "## Result", output || detail.outputIssue || (detail.status === "running" ? "Working…" : "No output yet"),
    ].join("\n") : output || detail?.outputIssue || "No output yet";
    const rows = useMemo(() => layoutTerminalMarkdown(clean(report), panelWidth, detail?.kind !== "shell"), [report, panelWidth, detail?.kind]);
    const start = Math.min(offset, Math.max(0, rows.length - visibleLines));
    useInput((input, key) => {
        if (key.escape) {if (detailId.current) {detailId.current = undefined; setDetail(undefined); setOffset(0);} else onClose(); return;}
        if (busy) return;
        if (input === "r") {setError(undefined); void refresh(); return;}
        if (input === "s" && active?.status === "running") {
            setBusy(true); setError(undefined);
            void stopTask(active.id).then(() => refresh()).catch(reason => {if (alive.current) setError(String(reason).slice(0, 500));})
                .finally(() => {if (alive.current) setBusy(false);});
            return;
        }
        if (key.return && !detailId.current && active) {detailId.current = active.id; setOffset(0); void refresh();}
        if (key.upArrow || key.downArrow) {
            const delta = key.upArrow ? -1 : 1;
            if (detailId.current) setOffset(Math.max(0, Math.min(start + delta, rows.length - visibleLines)));
            else setSelectedId(items[Math.max(0, Math.min(index + delta, items.length - 1))]?.id);
        }
    });
    const listStart = Math.max(0, index - visibleTasks + 1);
    const running = items.filter(task => task.status === "running").length;
    const badge = (task: TaskSnapshot) => `${markers[task.status]} ${labels[task.status]}`;
    const actions = detail ? "↑/↓ scroll · r refresh" : items.length ? "↑/↓ select · Enter view output" : "r refresh";
    const secondaryActions = `${active?.status === "running" ? "s stop · " : ""}Esc ${detail ? "back" : "close"}`;
    return <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2} width={panelWidth + 2}>
        <Box justifyContent="space-between">
            <Text bold color={COLORS.accent}>{detail ? "◆ Task output" : "◆ Tasks"}</Text>
            <Text color={COLORS.dim}>{items.length ? `${index + 1} / ${items.length}` : "0 tasks"}</Text>
        </Box>
        {!detail && <Text color={COLORS.dim} wrap="truncate-end">{loaded ? `${running} running · ${items.length - running} finished` : "Loading tasks…"}</Text>}
        {error && <Text color={COLORS.error} wrap="truncate-end">{clean(error)}</Text>}
        {detail ? <>
            <Box marginTop={1}><Text bold wrap="truncate-end">{clean(title(detail))}</Text></Box>
            <Text wrap="truncate-end"><Text color={statusColors[detail.status]}>{badge(detail)}</Text><Text color={COLORS.dim}>{` · ${metadata(detail)}`}</Text></Text>
            {detail.kind === "shell" && <Text color={COLORS.dim} wrap="truncate-end">{`Environment · ${detail.executionMode === "host" ? "Host" : "Sandbox"}`}</Text>}
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
                {rows.slice(start, start + visibleLines).map((row, rowIndex) => <Text key={rowIndex}>{row || " "}</Text>)}
            </Box>
            <Text color={COLORS.dim} wrap="truncate-end">{`${start + 1}–${Math.min(rows.length, start + visibleLines)} / ${rows.length} lines`}</Text>
        </> : items.length ? <Box flexDirection="column" marginTop={1}>{items.slice(listStart, listStart + visibleTasks).map((task, position) => {
            const focused = index === listStart + position;
            const progress = task.kind === "agent" && task.progress.todosUpdated ? task.progress.todos?.find(todo => todo.status === "in_progress") : undefined;
            return <Box key={task.id} flexDirection="column" marginBottom={1}>
                <Text backgroundColor={focused ? COLORS.surface : undefined}>
                    <Text color={focused ? COLORS.accent : COLORS.dim}>{focused ? "❯ " : "  "}</Text>
                    <Text bold={focused}>{fit(clean(title(task)), panelWidth - 2)}</Text>
                </Text>
                <Text wrap="truncate-end"><Text color={statusColors[task.status]}>{`  ${badge(task)}`}</Text><Text color={COLORS.dim}>{` · ${metadata(task)}${progress ? ` · ${clean(progress.activeForm)}` : ""}`}</Text></Text>
            </Box>;
        })}</Box> : loaded && !error ? <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text>○ No background tasks</Text>
            <Text color={COLORS.dim}>Background commands and Agents will appear here.</Text>
        </Box> : null}
        <Box marginTop={1} flexDirection="column">
            {busy ? <Text color={COLORS.accent}>Stopping the selected task…</Text> : compact ? <>
                <Text color={COLORS.dim}>{actions}</Text><Text color={COLORS.dim}>{secondaryActions}</Text>
            </> : <Text color={COLORS.dim}>{`${actions} · ${secondaryActions}`}</Text>}
        </Box>
    </Box>;
}
