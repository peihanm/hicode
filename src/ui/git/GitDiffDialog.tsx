import {basename} from "node:path";
import {useEffect, useMemo, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {GitDiffFile, GitDiffSnapshotResult,} from "../../git/index.js";
import {type DiffHunk, type FileChange, mergeFileChanges,} from "../../fileChanges/index.js";
import type {PersistedUIEvent} from "../../session/index.js";
import {StructuredDiff} from "../fileChanges/StructuredDiff.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

interface DiffViewFile {
    path: string;
    additions: number | null;
    deletions: number | null;
    hunks: DiffHunk[];
    diffStatus: "complete" | "truncated" | "unavailable";
    omittedDiffLines?: number;
    note?: string;
    label: string;
}

type DialogSource =
    | {id: "current"; label: string; kind: "git"}
    | {
        id: string;
        label: string;
        kind: "turn";
        turnNumber: number;
        turnId?: string;
        changes: FileChange[];
    };

type ViewMode = "list" | "detail";

type ViewState =
    | {status: "loading"}
    | {status: "error"; message: string}
    | {
        status: "ready";
        files: DiffViewFile[];
        repository?: string;
        branch?: string;
        truncated?: boolean;
        head?: string;
    };

function historicalSources(events: readonly PersistedUIEvent[]): DialogSource[] {
    const groups = new Map<string, FileChange[]>();
    for (const event of events) {
        if (event.type !== "file_change") continue;
        groups.set(event.turnId, [
            ...(groups.get(event.turnId) ?? []),
            event.change,
        ]);
    }
    return [...groups.entries()].map(([turnId, changes], index) => ({
        id: `turn:${turnId}`,
        label: `任务 ${index + 1}`,
        kind: "turn" as const,
        turnNumber: index + 1,
        turnId,
        changes: mergeFileChanges(changes),
    }));
}

function buildGitDiffDialogSources(
    events: readonly PersistedUIEvent[]
): DialogSource[] {
    const turns = historicalSources(events);
    return [
        {id: "current", label: "当前修改", kind: "git"},
        ...turns,
    ];
}

function sourceTitle(source: DialogSource): string {
    return source.kind === "git"
        ? "当前未提交修改"
        : `会话任务 ${source.turnNumber} 的修改`;
}

function gitFileLabel(kind: GitDiffFile["status"]["kind"]): string {
    if (kind === "untracked" || kind === "added") return "新增";
    if (kind === "deleted") return "删除";
    if (kind === "renamed") return "重命名";
    if (kind === "copied") return "复制";
    if (kind === "conflicted") return "冲突";
    if (kind === "type-changed") return "类型变化";
    return "修改";
}

function fromGitFile(file: GitDiffFile): DiffViewFile {
    return {
        path: file.status.path,
        additions: file.additions,
        deletions: file.deletions,
        hunks: [...file.hunks],
        diffStatus: file.diffStatus,
        omittedDiffLines: file.omittedDiffLines,
        note: file.unavailableReason,
        label: gitFileLabel(file.status.kind),
    };
}

function fromFileChange(change: FileChange): DiffViewFile {
    return {
        path: change.path,
        additions: change.linesAdded,
        deletions: change.linesRemoved,
        hunks: change.hunks,
        diffStatus: change.diffStatus,
        omittedDiffLines: change.omittedDiffLines,
        note: change.diffUnavailableReason,
        label: change.kind === "create"
            ? "新增"
            : change.kind === "delete"
                ? "删除"
                : "修改",
    };
}

function visibleFileWindow(files: readonly DiffViewFile[], selected: number) {
    const limit = 6;
    const start = Math.max(0, Math.min(selected - 2, files.length - limit));
    return {start, files: files.slice(start, start + limit)};
}

function truncateStart(value: string, width: number): string {
    if (stringWidth(value) <= width) return value;
    const suffixWidth = Math.max(1, width - 1);
    const segments = [...new Intl.Segmenter(undefined, {
        granularity: "grapheme",
    }).segment(value)].map(({segment}) => segment);
    let suffix = "";
    let used = 0;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index]!;
        const nextWidth = stringWidth(segment);
        if (used + nextWidth > suffixWidth) break;
        suffix = segment + suffix;
        used += nextWidth;
    }
    return `…${suffix}`;
}

export function GitDiffDialog({
                                  loadDiff,
                                  listFileChangeEvents,
                                  onClose,
}: {
    loadDiff: (signal: AbortSignal) => Promise<GitDiffSnapshotResult>;
    listFileChangeEvents: () => PersistedUIEvent[];
    onClose: () => void;
}) {
    const width = useTerminalWidth();
    const sources = useMemo(
        () => buildGitDiffDialogSources(listFileChangeEvents()),
        [listFileChangeEvents]
    );
    const [sourceIndex, setSourceIndex] = useState(0);
    const [selectedFile, setSelectedFile] = useState(0);
    const [viewMode, setViewMode] = useState<ViewMode>("list");
    const [reloadRevision, setReloadRevision] = useState(0);
    const [view, setView] = useState<ViewState>({status: "loading"});
    const source = sources[sourceIndex]!;

    useEffect(() => {
        setSelectedFile(0);
        setViewMode("list");
        if (source.kind === "turn") {
            setView({
                status: "ready",
                files: source.changes.map(fromFileChange),
            });
            return;
        }
        const controller = new AbortController();
        setView({status: "loading"});
        void loadDiff(controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            if (result.status === "unavailable") {
                setView({status: "error", message: result.message});
                return;
            }
            const repository = result.snapshot.repository;
            setView({
                status: "ready",
                files: result.snapshot.files.map(fromGitFile),
                repository: repository.repositoryRoot,
                branch: repository.detached
                    ? `detached ${repository.headOid?.slice(0, 12) ?? ""}`
                    : repository.branch ?? "unknown",
                truncated: result.snapshot.truncated,
                head: repository.headOid?.slice(0, 12),
            });
        }).catch((error) => {
            if (!controller.signal.aborted) {
                setView({
                    status: "error",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        });
        return () => controller.abort("source-changed");
    }, [loadDiff, reloadRevision, source]);

    useInput((input, key) => {
        if (key.escape) {
            if (viewMode === "detail") {
                setViewMode("list");
            } else {
                onClose();
            }
            return;
        }
        if (viewMode === "detail") {
            if (key.leftArrow || (key.ctrl && input === "o")) {
                setViewMode("list");
            } else if (input === "r" && source.kind === "git") {
                setReloadRevision((current) => current + 1);
            }
            return;
        }
        if (key.leftArrow || key.rightArrow) {
            const direction = key.leftArrow ? -1 : 1;
            setSourceIndex((current) =>
                (current + direction + sources.length) % sources.length
            );
            return;
        }
        if (view.status !== "ready") {
            if (input === "r" && source.kind === "git") {
                setReloadRevision((current) => current + 1);
            }
            return;
        }
        if (key.upArrow) {
            setSelectedFile((current) => Math.max(0, current - 1));
        } else if (key.downArrow) {
            setSelectedFile((current) =>
                Math.max(0, Math.min(view.files.length - 1, current + 1))
            );
        } else if (
            (key.return || (key.ctrl && input === "o")) &&
            view.files[selectedFile]
        ) {
            setViewMode("detail");
        } else if (input === "r" && source.kind === "git") {
            setReloadRevision((current) => current + 1);
        }
    });

    const selected = view.status === "ready"
        ? view.files[selectedFile]
        : undefined;
    const fileWindow = view.status === "ready"
        ? visibleFileWindow(view.files, selectedFile)
        : {start: 0, files: []};
    const totalAdditions = view.status === "ready" &&
        view.files.every((file) => file.additions !== null)
        ? view.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
        : null;
    const totalDeletions = view.status === "ready" &&
        view.files.every((file) => file.deletions !== null)
        ? view.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
        : null;
    const panelWidth = Math.max(40, Math.min(120, width - 1));
    const contentWidth = Math.max(30, panelWidth - 4);

    return (
        <Box
            flexDirection="column"
            marginTop={1}
            width={panelWidth}
            borderStyle="round"
            borderColor={COLORS.border}
            paddingX={1}
        >
            <Box>
                <Text bold color={COLORS.accent}>± Changes</Text>
                <Text color={COLORS.dim}>  查看代码修改</Text>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                <Box>
                    <Text color={COLORS.dim}>{"来源  "}</Text>
                    {sources.map((item, index) => (
                        <Text
                            key={item.id}
                            bold={index === sourceIndex}
                            inverse={index === sourceIndex}
                            dimColor={index !== sourceIndex}
                        >
                            {`${index > 0 ? "  " : ""}${item.label}`}
                        </Text>
                    ))}
                </Box>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                <Text bold>{sourceTitle(source)}</Text>
                {view.status === "loading" && (
                    <Text color={COLORS.dim}>正在读取 Git 修改…</Text>
                )}
                {view.status === "error" && (
                    <Text color={COLORS.error}>无法读取修改：{view.message}</Text>
                )}
                {view.status === "ready" && (
                    <Text color={COLORS.dim}>
                        {view.repository
                            ? `${basename(view.repository)} · ${view.branch ?? "unknown"} · `
                            : ""}
                        {view.files.length} 个文件
                        {" · "}
                        <Text color={COLORS.diffAdded}>+{totalAdditions ?? "?"}</Text>
                        {" "}
                        <Text color={COLORS.diffRemoved}>-{totalDeletions ?? "?"}</Text>
                        {view.truncated ? " · 结果已截断" : ""}
                    </Text>
                )}
            </Box>

            {view.status === "ready" && view.files.length === 0 && (
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>当前来源没有文件修改。</Text>
                </Box>
            )}

            {view.status === "ready" && view.files.length > 0 && viewMode === "list" && (
                <Box flexDirection="column" marginTop={1}>
                    {fileWindow.start > 0 && (
                        <Text color={COLORS.dim}>↑ 上方还有 {fileWindow.start} 个文件</Text>
                    )}
                    {fileWindow.files.map((file, offset) => {
                        const index = fileWindow.start + offset;
                        const isSelected = index === selectedFile;
                        const maxPathWidth = Math.max(18, contentWidth - 24);
                        return (
                            <Box key={file.path}>
                                <Text
                                    bold={isSelected}
                                    inverse={isSelected}
                                    color={isSelected ? COLORS.accent : undefined}
                                >
                                    {isSelected ? "❯ " : "  "}
                                    {truncateStart(file.path, maxPathWidth)}
                                </Text>
                                <Box flexGrow={1}/>
                                <Text>
                                    {file.additions !== 0 && (
                                        <Text color={COLORS.diffAdded}>+{file.additions ?? "?"}</Text>
                                    )}
                                    {file.additions !== 0 && file.deletions !== 0 ? " " : ""}
                                    {file.deletions !== 0 && (
                                        <Text color={COLORS.diffRemoved}>-{file.deletions ?? "?"}</Text>
                                    )}
                                    <Text color={COLORS.dim}>  {file.label}</Text>
                                </Text>
                            </Box>
                        );
                    })}
                    {fileWindow.start + fileWindow.files.length < view.files.length && (
                        <Text color={COLORS.dim}>
                            ↓ 下方还有 {view.files.length - fileWindow.start - fileWindow.files.length} 个文件
                        </Text>
                    )}
                </Box>
            )}

            {view.status === "ready" && selected && viewMode === "detail" && (
                <Box flexDirection="column" marginTop={1}>
                    <Box>
                        <Text bold>{selected.path}</Text>
                        <Text color={COLORS.dim}>  {selected.label}</Text>
                    </Box>
                    <Text color={COLORS.dim}>{"─".repeat(contentWidth)}</Text>
                    {selected.diffStatus === "unavailable" ? (
                        <Text color={COLORS.dim}>
                            无法展示 Diff（{selected.note ?? "unknown error"}）
                        </Text>
                    ) : (
                        <StructuredDiff
                            hunks={selected.hunks}
                            width={contentWidth}
                            expanded
                            omittedDiffLines={selected.omittedDiffLines}
                        />
                    )}
                </Box>
            )}

            <Box marginTop={1}>
                <Text color={COLORS.dim} italic>
                    {viewMode === "list"
                        ? `${sources.length > 1 ? "←/→ 切换来源 · " : ""}↑/↓ 选择 · Enter/Ctrl+O 查看${source.kind === "git" ? " · r 刷新" : ""} · Esc 关闭`
                        : `←/Esc 返回列表 · Ctrl+O 返回${source.kind === "git" ? " · r 刷新" : ""}`}
                </Text>
            </Box>
        </Box>
    );
}
