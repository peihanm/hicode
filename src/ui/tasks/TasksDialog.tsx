import {useCallback, useEffect, useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {TaskSessionLike, TaskSnapshot} from "../../tasks/types.js";
import {COLORS} from "../theme.js";
import {layoutInputRows} from "../input/MultilineTextInput.js";
import {useTerminalWidth} from "../terminalSize.js";
import {stripVTControlCharacters} from "node:util";
import stringWidth from "string-width";

const labels = {running: "运行中", completed: "已完成", failed: "失败", cancelled: "已停止"};
const markers = {running: "●", completed: "✓", failed: "!", cancelled: "○"};
const statusColors = {running: COLORS.accent, completed: COLORS.diffAdded, failed: COLORS.error, cancelled: COLORS.dim};
const visibleTasks = 5;
const title = (task: TaskSnapshot) => (task.kind === "shell" ? task.command : task.kind === "memory" ? "Memory 整理" : task.description).replace(/\s+/g, " ").trim();
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

function metadata(task: TaskSnapshot): string {
    const kind = task.kind === "shell" ? "命令" : task.kind === "agent" ? "Agent" : "Memory";
    const elapsed = Math.max(0, Math.floor(((task.completedAt ? Date.parse(task.completedAt) : Date.now()) - Date.parse(task.startedAt)) / 1000));
    if (!Number.isFinite(elapsed)) return kind;
    const duration = elapsed < 60 ? `${elapsed}s` : elapsed < 3600
        ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${Math.floor(elapsed / 3600)}h ${Math.floor(elapsed / 60) % 60}m`;
    return `${kind} · ${task.status === "running" ? "已运行" : "运行"} ${duration}`;
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
    const width = useTerminalWidth();
    const panelWidth = Math.max(16, Math.min(88, width - 4));
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
    const rows = layoutInputRows(clean(output || detail?.outputIssue || "暂无输出"), Math.max(8, panelWidth - 2));
    const start = Math.min(offset, Math.max(0, rows.length - 12));
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
            if (detailId.current) setOffset(Math.max(0, Math.min(start + delta, rows.length - 12)));
            else setSelectedId(items[Math.max(0, Math.min(index + delta, items.length - 1))]?.id);
        }
    });
    const listStart = Math.max(0, index - visibleTasks + 1);
    const running = items.filter(task => task.status === "running").length;
    const rule = "─".repeat(panelWidth);
    const badge = (task: TaskSnapshot) => `${markers[task.status]} ${labels[task.status]}`;
    const actions = detail ? "↑/↓ 滚动 · r 刷新" : items.length ? "Enter 查看输出 · ↑/↓ 选择" : "r 刷新";
    const secondaryActions = `${active?.status === "running" ? "s 停止 · " : ""}${!detail && items.length ? "r 刷新 · " : ""}Esc 返回`;
    return <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2} width={panelWidth + 2}>
        <Box justifyContent="space-between">
            <Text bold color={COLORS.accent}>{detail ? "◆ 任务输出" : "◆ 后台任务"}</Text>
            <Text color={COLORS.dim}>{items.length ? `${index + 1} / ${items.length}` : "0 项"}</Text>
        </Box>
        {!detail && <Text color={COLORS.dim} wrap="truncate-end">{loaded ? `${running} 运行中 · ${items.length - running} 已结束` : "正在加载任务…"}</Text>}
        <Text color={COLORS.border}>{rule}</Text>
        {error && <Box marginTop={1}><Text color={COLORS.error}>{clean(error)}</Text></Box>}
        {detail ? <>
            <Box marginTop={1}><Text bold>{clean(title(detail))}</Text></Box>
            <Text><Text color={statusColors[detail.status]}>{badge(detail)}</Text><Text color={COLORS.dim}>{` · ${metadata(detail)}`}</Text></Text>
            {detail.kind === "agent" && <Text color={COLORS.dim}>{`${detail.progress.iterations} 轮 · ${detail.progress.toolUseCount} 次工具调用 · ${clean(detail.progress.lastActivity ?? "")}`}</Text>}
            <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
                {rows.slice(start, start + 12).map((row, rowIndex) => <Text key={rowIndex}>{row.text}</Text>)}
            </Box>
            <Text color={COLORS.dim}>{`${start + 1}–${Math.min(rows.length, start + 12)} / ${rows.length} 行 · 当前输出预览`}</Text>
        </> : items.length ? items.slice(listStart, listStart + visibleTasks).map((task, position) => {
            const focused = index === listStart + position;
            const previous = position > 0 ? items[listStart + position - 1] : undefined;
            const groupStart = !previous || (previous.status === "running") !== (task.status === "running");
            const status = badge(task);
            const commandWidth = panelWidth - stringWidth(status) - 5;
            return <Box key={task.id} flexDirection="column">
                {groupStart && <Box marginTop={1} marginBottom={1}><Text color={COLORS.dim} bold>{task.status === "running" ? "运行中" : "最近结束"}</Text></Box>}
                <Text backgroundColor={focused ? COLORS.surface : undefined}>
                    <Text color={focused ? COLORS.accent : COLORS.dim}>{focused ? "❯ " : "  "}</Text>
                    <Text bold={focused} color={focused ? COLORS.accent : undefined}>{fit(clean(title(task)), commandWidth)}</Text>
                    <Text color={statusColors[task.status]}>{`  ${status} `}</Text>
                </Text>
                <Text backgroundColor={focused ? COLORS.surface : undefined} color={COLORS.dim}>{fit(`  ${metadata(task)}`, panelWidth)}</Text>
            </Box>;
        }) : loaded && !error ? <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text>○ 暂无后台任务</Text>
            <Text color={COLORS.dim}>后台命令和 Agent 会显示在这里。</Text>
        </Box> : null}
        <Box marginTop={1}><Text color={COLORS.border}>{rule}</Text></Box>
        {busy ? <Text color={COLORS.accent}>正在停止所选任务…</Text> : compact ? <>
            <Text color={COLORS.dim}>{actions}</Text><Text color={COLORS.dim}>{secondaryActions}</Text>
        </> : <Text color={COLORS.dim}>{`${actions} · ${secondaryActions}`}</Text>}
    </Box>;
}
