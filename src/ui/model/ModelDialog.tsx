import {reasoningCapability, type ReasoningEffort} from "../../llm/reasoningPolicy.js";
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
    "qwen-token-plan": "QWEN TOKEN PLAN",
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
    const [choosingReasoning, setChoosingReasoning] = useState(false);
    const [effortIndex, setEffortIndex] = useState(0);
    const initialIndex = Math.max(
        0,
        models.findIndex((target) => sameTarget(target, current))
    );
    const [selectedIndex, setSelectedIndex] = useState(initialIndex);
    const panelWidth = Math.max(12, Math.min(52, useTerminalWidth() - 4));
    const rowWidth = Math.min(52, panelWidth);
    const reasoningWidth = panelWidth - 4;
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

    const selected = models[selectedIndex];
    const capability = selected ? reasoningCapability(selected.source, selected.model) : undefined;
    const efforts = capability?.efforts ?? ["default"];
    const savedEffort = (selected && sameTarget(selected, current) ? current.reasoning : selected?.reasoning) ?? "default";
    const save = (reasoning?: ReasoningEffort) => {
        if (!selected) return;
        setSaving(true); setError("");
        void onSelect({...selected, ...(reasoning ? {reasoning} : {})})
            .catch(reason => setError(reason instanceof Error ? reason.message : "Could not save model selection"))
            .finally(() => setSaving(false));
    };
    useInput((input, key) => {
        if (saving) return;
        if (key.escape || (key.ctrl && input === "c") || input === "\x03") {
            if (choosingReasoning) setChoosingReasoning(false); else onClose();
            return;
        }
        if (models.length === 0) return;
        if (choosingReasoning) {
            if (key.upArrow) setEffortIndex(index => (index - 1 + efforts.length) % efforts.length);
            else if (key.downArrow) setEffortIndex(index => (index + 1) % efforts.length);
            else if (key.return) save(efforts[effortIndex]);
            return;
        }
        if (key.upArrow) {
            setSelectedIndex((index) => (index - 1 + models.length) % models.length);
        } else if (key.downArrow) {
            setSelectedIndex((index) => (index + 1) % models.length);
        } else if (key.return) {
            if (capability && selected) {
                setEffortIndex(Math.max(0, efforts.indexOf(savedEffort)));
                setChoosingReasoning(true);
            } else save();
        }
    });

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.accent} bold>
                ◆ MODEL{choosingReasoning && <Text color={COLORS.dim} bold={false}> · 2/2 Reasoning</Text>}
            </Text>

            {choosingReasoning && selected ? (
                <Box marginTop={1} flexDirection="column" width={panelWidth} borderStyle="round" borderColor={COLORS.border} paddingX={1}>
                    <Text bold wrap="truncate-end">{selected.label}</Text>
                    <Box marginTop={1} flexDirection="column">
                        {efforts.map((effort, index) => {
                            const focused = index === effortIndex;
                            const row = fitRow(
                                `${focused ? "›" : " "} ${effort === savedEffort ? "●" : " "} ${effort}`,
                                reasoningWidth
                            );
                            return (
                                <Text key={effort} backgroundColor={focused ? COLORS.accent : undefined} color={focused ? "white" : undefined} bold={focused}>
                                    {row}
                                </Text>
                            );
                        })}
                    </Box>
                </Box>
            ) : groups.length > 0 ? (
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
                <Text color={COLORS.dim}>{saving ? "Saving…" : choosingReasoning ? "● saved · ↑↓ select · enter save · esc/ctrl+c back" : `↑↓ select · enter configure · esc/ctrl+c ${escapeAction}`}</Text>
            </Box>
        </Box>
    );
}
