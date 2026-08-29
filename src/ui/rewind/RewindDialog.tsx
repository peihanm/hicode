import {useEffect, useMemo, useState} from "react";
import {Box, Text, useInput, useStdout} from "ink";
import SelectInput, {type IndicatorProps, type ItemProps,} from "ink-select-input";
import stringWidth from "string-width";
import type {CheckpointRestorePlan, CheckpointRestoreResult, FileCheckpointRecord,} from "../../checkpoints/index.js";
import {COLORS} from "../theme.js";

interface SelectItem<T> {
    label: string;
    value: T;
}

function relativeTime(timestamp: string): string {
    const milliseconds = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "<1m";
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function truncateDisplay(value: string, maxWidth: number): string {
    if (stringWidth(value) <= maxWidth) return value;
    const limit = Math.max(1, maxWidth - 1);
    let result = "";
    let width = 0;
    for (const {segment} of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
    }).segment(value)) {
        const nextWidth = stringWidth(segment);
        if (width + nextWidth > limit) break;
        result += segment;
        width += nextWidth;
    }
    return `${result.trimEnd()}…`;
}

function RewindIndicator({isSelected}: IndicatorProps) {
    return (
        <Text color={isSelected ? COLORS.accent : undefined}>
            {isSelected ? "❯ " : "  "}
        </Text>
    );
}

function RewindItem({isSelected, label}: ItemProps) {
    return (
        <Text color={isSelected ? COLORS.accent : undefined} bold={isSelected}>
            {label}
        </Text>
    );
}

function formatCheckpointLabel(
    checkpoint: FileCheckpointRecord,
    index: number,
    panelWidth = 96
): string {
    const coverage = checkpoint.fileCoverage === "incomplete"
        ? "文件捕获不完整"
        : checkpoint.coverageWarnings.length === 0
            ? "文件覆盖完整"
            : "存在外部副作用";
    const prefix = `${index + 1}  ${relativeTime(checkpoint.createdAt)} · ${checkpoint.mutations.length} 个文件 · ${coverage} · `;
    const previewWidth = Math.max(10, panelWidth - stringWidth(prefix) - 6);
    return `${prefix}${truncateDisplay(checkpoint.promptPreview, previewWidth)}`;
}

function planSummary(plan: CheckpointRestorePlan): string[] {
    const changed = plan.files.filter((file) => file.action !== "noop");
    const created = changed.filter((file) => file.action === "create").length;
    const updated = changed.filter((file) => file.action === "update").length;
    const deleted = changed.filter((file) => file.action === "delete").length;
    return [
        `将变更 ${changed.length} 个文件（创建 ${created}、恢复 ${updated}、删除 ${deleted}）`,
        ...changed.slice(0, 12).map((file) => {
            const stats = file.change &&
                file.change.linesAdded !== null &&
                file.change.linesRemoved !== null
                ? ` (+${file.change.linesAdded} -${file.change.linesRemoved})`
                : "";
            return `  ${file.action.padEnd(6)} ${file.path}${stats}`;
        }),
        ...(changed.length > 12 ? [`  …另有 ${changed.length - 12} 个文件`] : []),
    ];
}

export function RewindDialog({
                                 listCheckpoints,
                                 previewCheckpoint,
                                 restoreCheckpoint,
                                 onClose,
                             }: {
    listCheckpoints: () => Promise<FileCheckpointRecord[]>;
    previewCheckpoint: (checkpointId: string) => Promise<CheckpointRestorePlan>;
    restoreCheckpoint: (checkpointId: string) => Promise<CheckpointRestoreResult>;
    onClose: () => void;
}) {
    const {stdout} = useStdout();
    const panelWidth = Math.max(32, Math.min(96, stdout.columns || 80));
    const [checkpoints, setCheckpoints] = useState<FileCheckpointRecord[]>();
    const [selected, setSelected] = useState<FileCheckpointRecord>();
    const [plan, setPlan] = useState<CheckpointRestorePlan>();
    const [stage, setStage] = useState<
        "loading" | "checkpoint" | "preview" | "restoring" | "result" | "error"
    >("loading");
    const [result, setResult] = useState<CheckpointRestoreResult>();
    const [error, setError] = useState<string>();

    useEffect(() => {
        let active = true;
        void listCheckpoints().then((items) => {
            if (!active) return;
            setCheckpoints(items);
            setStage("checkpoint");
        }).catch((reason) => {
            if (!active) return;
            setError(reason instanceof Error ? reason.message : String(reason));
            setStage("error");
        });
        return () => {
            active = false;
        };
    }, [listCheckpoints]);

    useInput((_input, key) => {
        if (key.escape && stage !== "restoring") onClose();
    });

    const checkpointItems = useMemo<SelectItem<string>[]>(
        () => (checkpoints ?? []).map((checkpoint, index) => ({
            label: formatCheckpointLabel(checkpoint, index, panelWidth),
            value: checkpoint.checkpointId,
        })),
        [checkpoints, panelWidth]
    );

    const beginPreview = async (checkpoint: FileCheckpointRecord) => {
        setSelected(checkpoint);
        setStage("loading");
        try {
            setPlan(await previewCheckpoint(checkpoint.checkpointId));
            setStage("preview");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setStage("error");
        }
    };

    const apply = async () => {
        if (!selected) return;
        setStage("restoring");
        try {
            const restored = await restoreCheckpoint(selected.checkpointId);
            setResult(restored);
            setStage("result");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setStage("error");
        }
    };

    const controls = stage === "restoring"
        ? undefined
        : stage === "checkpoint" && checkpointItems.length > 0
            ? "↑↓ 选择  ·  Enter 预览  ·  Esc 关闭"
                : stage === "preview" && (plan?.conflicts.length ?? 0) === 0
                    ? "↑↓ 选择  ·  Enter 确认  ·  Esc 关闭"
                    : stage === "result"
                        ? "Enter 完成  ·  Esc 关闭"
                        : "Esc 返回";

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box
                width={panelWidth}
                flexDirection="column"
                borderStyle="round"
                borderColor={COLORS.border}
                paddingX={1}
            >
                <Box>
                    <Text bold color={COLORS.accent}>↶ Rewind</Text>
                    <Text color={COLORS.dim}>  恢复代码与对话状态</Text>
                </Box>

                {stage === "loading" && (
                    <Box marginTop={1}>
                        <Text color={COLORS.dim}>正在读取 Checkpoint…</Text>
                    </Box>
                )}

                {stage === "checkpoint" && checkpointItems.length === 0 && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text bold>◇ 暂无可恢复点</Text>
                        <Text color={COLORS.dim}>
                            当前 Session 还没有保存过可恢复的 Checkpoint。
                        </Text>
                    </Box>
                )}

                {stage === "checkpoint" && checkpointItems.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text bold>选择要撤销的任务</Text>
                        <Text color={COLORS.dim}>
                            代码与对话将恢复到该问题提交前。
                        </Text>
                        <SelectInput
                            items={checkpointItems}
                            indicatorComponent={RewindIndicator}
                            itemComponent={RewindItem}
                            onSelect={(item: SelectItem<string>) => {
                                const checkpoint = checkpoints!.find(
                                    (candidate) => candidate.checkpointId === item.value
                                );
                                if (checkpoint) void beginPreview(checkpoint);
                            }}
                        />
                        <Text color={COLORS.dim}>
                            文件捕获不完整时禁止恢复；Bash、MCP 或 Hook 的外部副作用无法撤销
                        </Text>
                    </Box>
                )}

                {stage === "preview" && plan && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text bold>恢复预览</Text>
                        {selected && (
                            <Text color={COLORS.dim}>
                                目标 · 恢复代码与对话到“{selected.promptPreview}”提交前
                            </Text>
                        )}
                        {planSummary(plan).map((line) => (
                            <Text key={line}>{line}</Text>
                        ))}
                        {plan.coverageWarnings.map((warning, index) => (
                            <Text color={COLORS.warning} key={`${warning.code}-${index}`}>
                                警告：{warning.message}
                            </Text>
                        ))}
                        {plan.conflicts.map((conflict) => (
                            <Text color={COLORS.error} key={conflict.path}>
                                冲突：{conflict.path} · {conflict.message}
                            </Text>
                        ))}
                        {plan.conflicts.length > 0 ? (
                            <Text color={COLORS.dim}>恢复范围不完整或存在冲突，已禁止恢复。</Text>
                        ) : (
                            <SelectInput
                                items={[
                                    {label: "1  确认恢复", value: "yes"},
                                    {label: "2  取消", value: "no"},
                                ]}
                                indicatorComponent={RewindIndicator}
                                itemComponent={RewindItem}
                                onSelect={(item: SelectItem<"yes" | "no">) => {
                                    if (item.value === "yes") void apply();
                                    else onClose();
                                }}
                            />
                        )}
                    </Box>
                )}

                {stage === "restoring" && (
                    <Box marginTop={1}>
                        <Text color={COLORS.dim}>正在恢复，请勿关闭 Pillar…</Text>
                    </Box>
                )}

                {stage === "result" && result && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text
                            bold
                            color={result.status === "complete" ? COLORS.accent : COLORS.error}
                        >
                            {result.status === "complete" ? "恢复完成" : `恢复状态 · ${result.status}`}
                        </Text>
                        <Text>
                            {result.status === "complete"
                                ? "代码与对话已恢复。"
                                : "恢复未完整完成；对话只会在代码恢复成功后回退。"}
                        </Text>
                        <Text>
                            文件：恢复 {result.restoredFiles.length} 个，删除 {result.deletedFiles.length} 个新建文件。
                        </Text>
                        {result.failures.map((failure) => (
                            <Text color={COLORS.error} key={`${failure.path}-${failure.message}`}>
                                {failure.path}: {failure.message}
                            </Text>
                        ))}
                        <SelectInput
                            items={[{label: "完成", value: "done"}]}
                            indicatorComponent={RewindIndicator}
                            itemComponent={RewindItem}
                            onSelect={onClose}
                        />
                    </Box>
                )}

                {stage === "error" && (
                    <Box flexDirection="column" marginTop={1}>
                        <Text bold color={COLORS.error}>无法打开 Rewind</Text>
                        <Text color={COLORS.error}>{error}</Text>
                    </Box>
                )}

                <Box marginTop={1}>
                    <Text color={COLORS.dim}>
                        范围 · 仅恢复 Pillar 文件工具捕获的修改；外部程序与服务不在恢复范围内。
                    </Text>
                </Box>
            </Box>
            {controls && (
                <Box marginLeft={1}>
                    <Text color={COLORS.dim}>{controls}</Text>
                </Box>
            )}
        </Box>
    );
}
