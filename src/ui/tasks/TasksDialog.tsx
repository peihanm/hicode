import {useTerminalInput} from "../input/terminalInput.js";
import {agentRunTiming} from "../../tasks/format.js";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Box, Text} from "ink";
import type {TaskSessionLike, TaskSnapshot} from "../../tasks/types.js";
import {PanelViewport} from "../dialogs/PanelViewport.js";
import {COLORS} from "../theme.js";
import {layoutTerminalMarkdown} from "../conversation/TerminalMarkdown.js";
import {panelWindow, usePanelLayout, wrapPanelText} from "../panelLayout.js";
import {stripVTControlCharacters} from "node:util";

const labels = {running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted"};
const markers = {running: "●", completed: "✓", failed: "!", cancelled: "○", interrupted: "◷"};
const statusColors = {running: COLORS.accent, completed: COLORS.diffAdded, failed: COLORS.error, cancelled: COLORS.dim, interrupted: COLORS.dim};
const title = (task: TaskSnapshot) => (task.kind === "shell" ? task.command : task.kind === "memory" ? "Memory consolidation" : task.kind === "review" ? `Task review: rounds ${task.fromRound}-${task.toRound}` : task.description).replace(/\s+/g, " ").trim();
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function metadata(task: TaskSnapshot): string {
    if (task.kind === "agent") return `${clean(task.agentName ?? task.agentType)} · Run ${task.progress.runCount} · ${duration(agentRunTiming(task).runMs)}`;
    const elapsed = (task.completedAt ? Date.parse(task.completedAt) : Date.now()) - Date.parse(task.startedAt);
    return `${task.kind === "shell" ? `Command · ${task.phase} · queued ${duration(task.timing.queuedMs)} / run ${duration(task.timing.runningMs)}` : task.kind === "review" ? "Advisory review" : "Memory"} · ${duration(elapsed)}`;
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
    const {width, height, padding, contentWidth: panelWidth} = usePanelLayout();
    const visibleLines = Math.max(1, height - 10 - (panelWidth < 60 ? 1 : 0));
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
    const outputRows = useMemo(() => layoutTerminalMarkdown(clean(report), panelWidth, detail?.kind !== "shell"), [report, panelWidth, detail?.kind]);
    const rows = detail ? [
        ...wrapPanelText(clean(title(detail)), panelWidth).map((text, i) => <Text key={`title-${i}`} bold>{text}</Text>),
        ...wrapPanelText(`${markers[detail.status]} ${labels[detail.status]} · ${metadata(detail)}`, panelWidth)
            .map((text, i) => <Text key={`metadata-${i}`} color={statusColors[detail.status]}>{text}</Text>),
        ...(detail.kind === "shell" ? wrapPanelText(`Environment · ${detail.executionMode === "host" ? "Host" : "Sandbox"}`, panelWidth)
            .map((text, i) => <Text key={`environment-${i}`} color={COLORS.dim}>{text}</Text>) : []),
        " ", ...outputRows,
    ] : outputRows;
    const start = Math.min(offset, Math.max(0, rows.length - visibleLines));
    useTerminalInput((input, key) => {
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
    const running = items.filter(task => task.status === "running").length;
    const badge = (task: TaskSnapshot) => `${markers[task.status]} ${labels[task.status]}`;
    const actions = detail ? "↑/↓ scroll · r refresh" : items.length ? "↑/↓ select · Enter view output" : "r refresh";
    const secondaryActions = `${active?.status === "running" ? "s stop · " : ""}Esc ${detail ? "back" : "close"}`;
    const titles = items.map(task => wrapPanelText(clean(title(task)), Math.max(1, panelWidth - 2)));
    const summaries = items.map(task => {
        const progress = task.kind === "agent" && task.progress.todosUpdated ? task.progress.todos?.find(todo => todo.status === "in_progress") : undefined;
        return wrapPanelText(`  ${badge(task)} · ${metadata(task)}${progress ? ` · ${clean(progress.activeForm)}` : ""}`, panelWidth);
    });
    const window = panelWindow(items.map((_, i) => titles[i]!.length + summaries[i]!.length + 1), index, height - 10 - wrapPanelText(`${actions} · ${secondaryActions}`, panelWidth).length);
    return <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={padding} width={width}>
        <Box justifyContent="space-between">
            <Text bold color={COLORS.accent}>{detail ? "◆ Task output" : "◆ Tasks"}</Text>
            <Text color={COLORS.dim}>{items.length ? `${index + 1} / ${items.length}` : "0 tasks"}</Text>
        </Box>
        {!detail && <Text color={COLORS.dim}>{loaded ? `${running} running · ${items.length - running} finished` : "Loading tasks…"}</Text>}
        {error && <Text color={COLORS.error}>{clean(error)}</Text>}
        {detail ? <>
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
                {rows.slice(start, start + visibleLines).map((row, rowIndex) => <Text key={rowIndex}>{row || " "}</Text>)}
            </Box>
            <Text color={COLORS.dim}>{`${start + 1}–${Math.min(rows.length, start + visibleLines)} / ${rows.length} lines`}</Text>
        </> : items.length ? <Box flexDirection="column" marginTop={1}>
            <PanelViewport width={panelWidth} height={Math.max(2, height - 10 - wrapPanelText(`${actions} · ${secondaryActions}`, panelWidth).length)} resetKey={items[index]?.id ?? "empty"}
                lines={items.slice(window.start, window.end).flatMap((task, position) => {
                    const focused = index === window.start + position;
                    return [
                        ...titles[window.start + position]!.map((line, i) => <Text key={`title-${i}`} backgroundColor={focused ? COLORS.surface : undefined}>
                            <Text color={focused ? COLORS.accent : COLORS.dim}>{i === 0 && focused ? "❯ " : "  "}</Text><Text bold={focused}>{line}</Text>
                        </Text>),
                        ...summaries[window.start + position]!.map((line, i) => <Text key={`summary-${i}`} color={statusColors[task.status]}>{line}</Text>), " ",
                    ];
                })}/>
        </Box> : loaded && !error ? <Box flexDirection="column" marginTop={1} marginBottom={1}>
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
