import {basename} from "node:path";
import {useEffect, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {GitDiffFile, GitDiffSnapshotResult,} from "../../git/index.js";
import type {DiffHunk} from "../../fileChanges/index.js";
import {StructuredDiff} from "../fileChanges/StructuredDiff.js";
import {COLORS} from "../theme.js";
import {panelWindow, usePanelLayout, wrapPanelText} from "../panelLayout.js";

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

export function GitDiffDialog({
                                  loadDiff,
                                  onClose,
}: {
    loadDiff: (signal: AbortSignal) => Promise<GitDiffSnapshotResult>;
    onClose: () => void;
}) {
    const {width, height, padding, contentWidth} = usePanelLayout();
    const [selection, setSelection] = useState<{mode: ViewMode; path?: string}>({mode: "list"});
    const [reloadRevision, setReloadRevision] = useState(0);
    const [view, setView] = useState<ViewState>({status: "loading"});

    useEffect(() => {
        const controller = new AbortController();
        setView({status: "loading"});
        void loadDiff(controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            if (result.status === "unavailable") {
                setView({status: "error", message: result.message});
                return;
            }
            const repository = result.snapshot.repository;
            const files = result.snapshot.files.map(fromGitFile);
            setSelection(current => files.some(file => file.path === current.path)
                ? current
                : {mode: "list", path: files[0]?.path});
            setView({
                status: "ready",
                files,
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

    const viewMode = selection.mode;
    const selectedFile = view.status === "ready"
        ? Math.max(0, view.files.findIndex(file => file.path === selection.path)) : 0;

    useInput((input, key) => {
        if (key.escape) {
            if (viewMode === "detail") {
                setSelection(current => ({...current, mode: "list"}));
            } else {
                onClose();
            }
            return;
        }
        if (key.ctrl || key.meta) return;
        if (input === "r") {
            setReloadRevision((current) => current + 1);
            return;
        }
        if (viewMode === "detail" || view.status !== "ready") return;
        if (key.upArrow) {
            setSelection({mode: "list", path: view.files[Math.max(0, selectedFile - 1)]?.path});
        } else if (key.downArrow) {
            setSelection({mode: "list", path: view.files[Math.min(view.files.length - 1, selectedFile + 1)]?.path});
        } else if (
            key.return &&
            view.files[selectedFile]
        ) {
            setSelection({mode: "detail", path: view.files[selectedFile].path});
        }
    });

    const selected = view.status === "ready"
        ? view.files[selectedFile]
        : undefined;
    const files = view.status === "ready" ? view.files : [];
    const pathWidth = contentWidth < 60 ? contentWidth : Math.max(1, contentWidth - 26);
    const range = panelWindow(files.map(file => wrapPanelText(`❯ ${file.path}`, pathWidth).length + (contentWidth < 60 ? 2 : 0)), selectedFile, height - 11);
    const fileWindow = {start: range.start, files: files.slice(range.start, range.end)};
    const totalAdditions = view.status === "ready" &&
        view.files.every((file) => file.additions !== null)
        ? view.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
        : null;
    const totalDeletions = view.status === "ready" &&
        view.files.every((file) => file.deletions !== null)
        ? view.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
        : null;
    const compact = contentWidth < 60;

    return (
        <Box
            flexDirection="column"
            marginTop={1}
            marginBottom={1}
            width={width}
            paddingX={padding}
        >
            <Box>
                <Text bold color={COLORS.accent}>± Changes</Text>
            </Box>

            <Box flexDirection="column" marginTop={1}>
                <Text color={COLORS.dim}>Current uncommitted changes</Text>
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
                        const maxPathWidth = Math.max(1, contentWidth - (compact ? 0 : 26));
                        return (
                            <Box key={file.path} flexDirection={compact ? "column" : "row"} marginBottom={compact ? 1 : 0}>
                                <Box width={compact ? contentWidth : Math.max(1, contentWidth - 26)} flexShrink={0}><Text
                                    bold={isSelected}
                                    color={isSelected ? COLORS.accent : undefined}
                                >
                                    {wrapPanelText(`${isSelected ? "❯ " : "  "}${file.path}`, maxPathWidth).join("\n")}
                                </Text></Box>
                                {!compact && <Box flexGrow={1}/>}
                                <Text>
                                    {compact ? "  " : ""}
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
                    <Box flexDirection="column">
                        <Text bold>{selected.path}</Text>
                        <Text color={COLORS.dim}>{selected.label}</Text>
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
                    {viewMode === "detail"
                        ? "r refresh · Esc back to files"
                        : view.status === "ready" && view.files.length > 0
                            ? "↑↓ select · Enter view · r refresh · Esc close"
                            : "r refresh · Esc close"}
                </Text>
            </Box>
        </Box>
    );
}
