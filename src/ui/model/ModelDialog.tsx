import {useMemo, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {ModelTargetSettings} from "../../settings/types.js";
import {formatModelTarget} from "../../llm/modelCatalog.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const SOURCE_LABELS: Record<ModelTargetSettings["source"], string> = {
    glm: "ZHIPU GLM",
    qwen: "ALIBABA QWEN",
    deepseek: "DEEPSEEK",
    openrouter: "OPENROUTER",
};

function sameTarget(left: ModelTargetSettings, right: ModelTargetSettings): boolean {
    return left.source === right.source && left.model === right.model;
}

function fitRow(value: string, width: number): string {
    let result = "";
    for (const segment of Array.from(value)) {
        if (stringWidth(result + segment) > width) break;
        result += segment;
    }
    return result + " ".repeat(Math.max(0, width - stringWidth(result)));
}

export function ModelDialog({
    models,
    current,
    onSelect,
    onClose,
    escapeAction = "back",
}: {
    models: readonly ModelTargetSettings[];
    current: ModelTargetSettings;
    onSelect(target: ModelTargetSettings): Promise<void>;
    onClose(): void;
    escapeAction?: "back" | "exit";
}) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const initialIndex = Math.max(
        0,
        models.findIndex((target) => sameTarget(target, current))
    );
    const [selectedIndex, setSelectedIndex] = useState(initialIndex);
    const rowWidth = Math.max(16, Math.min(52, useTerminalWidth() - 6));
    const groups = useMemo(() => {
        const result: Array<{
            source: ModelTargetSettings["source"];
            entries: Array<{target: ModelTargetSettings; index: number}>;
        }> = [];
        models.forEach((target, index) => {
            const group = result.find((entry) => entry.source === target.source);
            if (group) group.entries.push({target, index});
            else result.push({source: target.source, entries: [{target, index}]});
        });
        return result;
    }, [models]);

    useInput((_input, key) => {
        if (saving) return;
        if (key.escape) {
            onClose();
            return;
        }
        if (models.length === 0) return;
        if (key.upArrow) {
            setSelectedIndex((index) => (index - 1 + models.length) % models.length);
        } else if (key.downArrow) {
            setSelectedIndex((index) => (index + 1) % models.length);
        } else if (key.return) {
            const target = models[selectedIndex];
            if (target) {
                setSaving(true); setError("");
                void onSelect(target).catch(reason => setError(reason instanceof Error ? reason.message : "Could not save model selection"))
                    .finally(() => setSaving(false));
            }
        }
    });

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.accent} bold>◆ MODEL</Text>

            {groups.length > 0 ? (
                <Box marginTop={1} flexDirection="column">
                    {groups.map((group) => (
                        <Box
                            key={group.source}
                            flexDirection="column"
                        >
                            <Text color={COLORS.dim} bold>
                                {SOURCE_LABELS[group.source]}
                            </Text>
                            {group.entries.map(({target, index}) => {
                                const focused = index === selectedIndex;
                                const active = sameTarget(target, current);
                                const row = fitRow(
                                    `${focused ? "›" : " "} ${active ? "●" : " "} ${formatModelTarget(target)}`,
                                    rowWidth
                                );
                                return (
                                    <Text
                                        key={`${target.source}:${target.model}`}
                                        backgroundColor={focused ? COLORS.accent : undefined}
                                        color={focused ? "white" : undefined}
                                        bold={focused}
                                    >
                                        {row}
                                    </Text>
                                );
                            })}
                        </Box>
                    ))}
                </Box>
            ) : (
                <Box marginTop={1}>
                    <Text color={COLORS.warning}>
                        No models available. Use /providers to add an API key.
                    </Text>
                </Box>
            )}

            {error && <Text color={COLORS.error}>{error}</Text>}
            <Box marginTop={1}>
                <Text color={COLORS.dim}>{saving ? "Saving…" : `↑↓ select · enter switch and save · esc ${escapeAction}`}</Text>
            </Box>
        </Box>
    );
}
