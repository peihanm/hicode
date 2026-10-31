import {useTerminalInput} from "../input/terminalInput.js";
import {reasoningCapability, type ReasoningEffort} from "../../llm/reasoningPolicy.js";
import {useMemo, useState} from "react";
import {Box, Text} from "ink";
import type {ModelTargetSettings} from "../../settings/types.js";
import {formatModelTarget} from "../../llm/modelCatalog.js";
import {PanelViewport} from "../dialogs/PanelViewport.js";
import {COLORS} from "../theme.js";
import {panelWindow, usePanelLayout, wrapPanelText} from "../panelLayout.js";

const SOURCE_LABELS: Record<ModelTargetSettings["source"], string> = {
    glm: "ZHIPU GLM",
    qwen: "ALIBABA QWEN",
    "qwen-token-plan": "QWEN TOKEN PLAN",
    "ark-agent-plan": "ARK AGENT PLAN",
    deepseek: "DEEPSEEK",
    openrouter: "OPENROUTER",
};

function sameTarget(left: ModelTargetSettings, right: ModelTargetSettings): boolean {
    return left.source === right.source && left.model === right.model;
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
    const {width, height, padding, contentWidth: panelWidth} = usePanelLayout();
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

    const ordered = groups.flatMap(group => group.entries);
    const window = panelWindow(ordered.map(({target}) => wrapPanelText(`› ● ${formatModelTarget(target)}`, panelWidth).length + 1),
        ordered.findIndex(entry => entry.index === selectedIndex), height - 9);
    const visible = new Set(ordered.slice(window.start, window.end).map(entry => entry.index));
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
    useTerminalInput((input, key) => {
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
        <Box flexDirection="column" paddingX={padding} width={width}>
            <Text color={COLORS.accent} bold>
                ◆ MODEL{choosingReasoning && <Text color={COLORS.dim} bold={false}> · 2/2 Reasoning</Text>}
            </Text>

            {choosingReasoning && selected ? (
                <Box marginTop={1} flexDirection="column" width={panelWidth} borderStyle="round" borderColor={COLORS.border} paddingX={1}>
                    <Text bold>{selected.label}</Text>
                    <Box marginTop={1} flexDirection="column">
                        {efforts.map((effort, index) => {
                            const focused = index === effortIndex;
                            const row = `${focused ? "›" : " "} ${effort === savedEffort ? "●" : " "} ${effort}`;
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
                    <PanelViewport width={panelWidth} height={Math.max(2, height - 8)} resetKey={selected ? `${selected.source}:${selected.model}` : "empty"}
                        lines={groups.filter(group => group.entries.some(entry => visible.has(entry.index))).flatMap(group => [
                            ...wrapPanelText(SOURCE_LABELS[group.source], panelWidth).map((line, i) => <Text key={`source-${group.source}-${i}`} color={COLORS.dim} bold>{line}</Text>),
                            ...group.entries.filter(entry => visible.has(entry.index)).flatMap(({target, index}) => {
                                const focused = index === selectedIndex;
                                const active = sameTarget(target, current);
                                return wrapPanelText(`${focused ? "›" : " "} ${active ? "●" : " "} ${formatModelTarget(target)}`, panelWidth)
                                    .map((line, i) => <Text key={`${target.source}:${target.model}:${i}`}
                                        backgroundColor={focused ? COLORS.accent : undefined} color={focused ? "white" : undefined} bold={focused}>{line}</Text>);
                            }),
                        ])}/>
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
