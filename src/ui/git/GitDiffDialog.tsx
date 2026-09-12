import {basename} from "node:path";
import {useEffect, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {GitDiffFile, GitDiffSnapshotResult,} from "../../git/index.js";
import type {DiffHunk} from "../../fileChanges/index.js";
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
    };

function gitFileLabel(kind: GitDiffFile["status"]["kind"]): string {
    if (kind === "untracked" || kind === "added") return "Added";
    if (kind === "deleted") return "Delete";
    if (kind === "renamed") return "Renamed";
    if (kind === "copied") return "Copied";
    if (kind === "conflicted") return "Conflict";
    if (kind === "type-changed") return "Type changed";
    return "Modified";
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
                                  onClose,
}: {
    loadDiff: (signal: AbortSignal) => Promise<GitDiffSnapshotResult>;
    onClose: () => void;
}) {
    const width = useTerminalWidth();
    const [selectedFile, setSelectedFile] = useState(0);
    const [viewMode, setViewMode] = useState<ViewMode>("list");
    const [reloadRevision, setReloadRevision] = useState(0);
    const [view, setView] = useState<ViewState>({status: "loading"});

    useEffect(() => {
        setSelectedFile(0);
        setViewMode("list");
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
            });
        }).catch((error) => {
            if (!controller.signal.aborted) {
                setView({
                    status: "error",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        });
        return () => controller.abort("diff-view-reloaded-or-closed");
    }, [loadDiff, reloadRevision]);

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
            } else if (input === "r") {
                setReloadRevision((current) => current + 1);
            }
            return;
        }
        if (view.status !== "ready") {
            if (input === "r") {
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
        } else if (input === "r") {
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
                <Text color={COLORS.dim}>  View code changes</Text>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                <Text bold>Current uncommitted changes</Text>
                {view.status === "loading" && (
                    <Text color={COLORS.dim}>Reading Git changes…</Text>
                )}
                {view.status === "error" && (
                    <Text color={COLORS.error}>Cannot read changes: {view.message}</Text>
                )}
                {view.status === "ready" && (
                    <Text color={COLORS.dim}>
                        {view.repository
                            ? `${basename(view.repository)} · ${view.branch ?? "unknown"} · `
                            : ""}
                        {view.files.length} files
                        {" · "}
                        <Text color={COLORS.diffAdded}>+{totalAdditions ?? "?"}</Text>
                        {" "}
                        <Text color={COLORS.diffRemoved}>-{totalDeletions ?? "?"}</Text>
                        {view.truncated ? " · results truncated" : ""}
                    </Text>
                )}
            </Box>

            {view.status === "ready" && view.files.length === 0 && (
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>No uncommitted changes.</Text>
                </Box>
            )}

            {view.status === "ready" && view.files.length > 0 && viewMode === "list" && (
                <Box flexDirection="column" marginTop={1}>
                    {fileWindow.start > 0 && (
                        <Text color={COLORS.dim}>↑ Above: {fileWindow.start} files</Text>
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
                            ↓ Below: {view.files.length - fileWindow.start - fileWindow.files.length} files
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
                            Cannot display diff ({selected.note ?? "unknown error"})
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
                        ? "↑/↓ select · Enter/Ctrl+O view · r refresh · Esc close"
                        : "←/Esc back to list · Ctrl+O back · r refresh"}
                </Text>
            </Box>
        </Box>
    );
}
