import {useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import {COLORS, SYMBOLS} from "../theme.js";
import {getSlashCommandSuggestions} from "../../slash/index.js";
import {MultilineTextInput, type InputBoundaryReplacement, type InputBoundaryState,} from "./MultilineTextInput.js";
import type {InputHistoryStore} from "../../session/inputHistory/index.js";
import {useTerminalWidth} from "../terminalSize.js";
import {
    collapsePromptText,
    EMPTY_PASTE_CAPSULE_STATE,
    expandPasteCapsuleCursor,
    expandPasteCapsules,
    getPasteCapsuleRanges,
    PasteInputBurst,
    type PasteCapsuleState,
    removePasteCapsule,
} from "./pasteCapsules.js";

const INPUT_HISTORY_LIMIT = 100;
const MAX_VISIBLE_SLASH_SUGGESTIONS = 6;
const DEFAULT_CLOCK = () => Date.now();
const EMPTY_INPUT_HISTORY: InputHistoryStore = {
    async load() {
        return [];
    },
    async append() {
    },
};

interface InputBoxDependencies {
    now(): number;

    persistentHistory: InputHistoryStore;
}

export function formatTurnDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes === 0) return `${seconds}s`;
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    if (hours === 0) {
        return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatInputDivider(width: number): string {
    const totalWidth = Math.max(1, width - 1);
    return "─".repeat(totalWidth);
}

function mergeHistory(...groups: readonly string[][]): string[] {
    const merged = groups.flat();
    const seen = new Set<string>();
    const newest: string[] = [];
    for (let index = merged.length - 1; index >= 0; index--) {
        const input = merged[index]!;
        if (seen.has(input)) continue;
        seen.add(input);
        newest.unshift(input);
        if (newest.length >= INPUT_HISTORY_LIMIT) break;
    }
    return newest;
}

function formatCommand(command: string, argumentHint?: string): string {
    return `/${command}${argumentHint ? ` ${argumentHint}` : ""}`;
}

function padCommandLabel(label: string): string {
    const width = 36;
    return label.length >= width ? `${label}  ` : label.padEnd(width, " ");
}

// 输入框：单条下边界与状态栏形成输入区域。disabled 只用于取消收尾等短暂阶段。
export function createInputBox(
    overrides: Partial<InputBoxDependencies> = {}
) {
    const now = overrides.now ?? DEFAULT_CLOCK;
    const defaultPersistentHistory =
        overrides.persistentHistory ?? EMPTY_INPUT_HISTORY;

    return function InputBox({
                                 onSubmit,
                                 disabled,
                                 allowEmpty = false,
                                 terminalWidth,
                                 cwd,
                                 sessionId,
                                 persistentHistory = defaultPersistentHistory,
                                 startedAt,
                                 elapsedMs,
                                 replacement,
                                 clearRevision,
                                 onDraftPresenceChange,
                                 takeQueuedInputsForEditing,
                             }: {
        onSubmit: (input: string) => void;
        disabled: boolean;
        allowEmpty?: boolean;
        terminalWidth?: number;
        cwd?: string;
        sessionId?: string;
        persistentHistory?: InputHistoryStore;
        startedAt?: number;
        elapsedMs?: number;
        replacement?: {
            value: string;
            revision: number;
            appendCurrent?: boolean;
        };
        clearRevision?: number;
        onDraftPresenceChange?: (hasDraft: boolean) => void;
        takeQueuedInputsForEditing?: (
            state: InputBoundaryState
        ) => InputBoundaryReplacement | undefined;
    }) {
        const [value, setValue] = useState("");
        const [pasteCapsules, setPasteCapsules] = useState<PasteCapsuleState>(
            EMPTY_PASTE_CAPSULE_STATE
        );
        const [pasteInput] = useState(() => new PasteInputBurst());
        const [history, setHistory] = useState<string[]>([]);
        const [historyIndex, setHistoryIndex] = useState<number | null>(null);
        const valueRef = useRef(value);
        const pasteCapsulesRef = useRef(pasteCapsules);
        const historyRef = useRef(history);
        const historyIndexRef = useRef<number | null>(historyIndex);
        const historyDraftRef = useRef("");
        const clearRevisionRef = useRef(clearRevision);
        const [selectedSuggestion, setSelectedSuggestion] = useState(0);
        const width = useTerminalWidth(terminalWidth);
        const [currentTime, setCurrentTime] = useState(now);
        useEffect(() => {
            if (startedAt === undefined) return;
            const update = () => setCurrentTime(now());
            update();
            const timer = setInterval(update, 1000);
            timer.unref?.();
            return () => clearInterval(timer);
        }, [now, startedAt]);
        const duration = startedAt === undefined
            ? elapsedMs
            : Math.max(0, currentTime - startedAt);
        const durationLabel = duration === undefined
            ? undefined
            : `${startedAt === undefined ? "Worked" : "Working"} for ${formatTurnDuration(duration)}`;
        const line = formatInputDivider(width);
        const suggestions = useMemo(
            () => getSlashCommandSuggestions(value),
            [value]
        );
        const showSuggestions =
            !disabled && historyIndex === null && suggestions.length > 0;
        const activeSuggestionIndex = Math.min(
            selectedSuggestion,
            Math.max(0, suggestions.length - 1)
        );
        const suggestionWindowStart = Math.min(
            Math.max(
                0,
                activeSuggestionIndex - MAX_VISIBLE_SLASH_SUGGESTIONS + 1
            ),
            Math.max(0, suggestions.length - MAX_VISIBLE_SLASH_SUGGESTIONS)
        );
        const visibleSuggestions = suggestions.slice(
            suggestionWindowStart,
            suggestionWindowStart + MAX_VISIBLE_SLASH_SUGGESTIONS
        );

        valueRef.current = value;
        pasteCapsulesRef.current = pasteCapsules;
        historyRef.current = history;
        historyIndexRef.current = historyIndex;

        const replaceValue = (nextValue: string) => {
            valueRef.current = nextValue;
            setValue(nextValue);
        };

        const replacePasteCapsules = (nextState: PasteCapsuleState) => {
            pasteCapsulesRef.current = nextState;
            setPasteCapsules(nextState);
        };

        const replaceExpandedValue = (nextValue: string) => {
            pasteInput.reset();
            const collapsed = collapsePromptText(nextValue);
            replacePasteCapsules(collapsed.state);
            replaceValue(collapsed.value);
        };

        const expandedValue = () =>
            expandPasteCapsules(valueRef.current, pasteCapsulesRef.current);
        const hasDraft = value.length > 0;

        useEffect(() => {
            onDraftPresenceChange?.(hasDraft);
        }, [hasDraft, onDraftPresenceChange]);

        useEffect(() => {
            if (
                clearRevision === undefined ||
                clearRevision === clearRevisionRef.current
            ) {
                return;
            }
            clearRevisionRef.current = clearRevision;
            pasteInput.reset();
            historyIndexRef.current = null;
            setHistoryIndex(null);
            historyDraftRef.current = "";
            replacePasteCapsules(EMPTY_PASTE_CAPSULE_STATE);
            replaceValue("");
        }, [clearRevision]);

        useEffect(() => {
            if (!cwd || !sessionId) return;
            let active = true;
            void persistentHistory.load(cwd, sessionId).then((loaded) => {
                if (!active) return;
                setHistory((current) => {
                    const merged = mergeHistory(loaded, current);
                    historyRef.current = merged;
                    return merged;
                });
            }).catch(() => {
                // 输入历史是 best-effort，读取失败不阻止主输入框使用。
            });
            return () => {
                active = false;
            };
        }, [cwd, persistentHistory, sessionId]);

        useEffect(() => {
            if (!replacement) return;
            historyIndexRef.current = null;
            setHistoryIndex(null);
            historyDraftRef.current = "";
            const currentValue = expandedValue();
            replaceExpandedValue(
                replacement.appendCurrent && currentValue.trim()
                    ? `${replacement.value}\n\n${currentValue}`
                    : replacement.value
            );
        }, [replacement?.revision]);

        const navigateHistory = (
            direction: -1 | 1,
            state: InputBoundaryState
        ): InputBoundaryReplacement | undefined => {
            const currentHistory = historyRef.current;
            const currentIndex = historyIndexRef.current;
            if (direction === -1) {
                if (currentIndex === null) {
                    const queued = takeQueuedInputsForEditing?.(state);
                    if (queued) {
                        historyDraftRef.current = "";
                        const collapsed = collapsePromptText(queued.value);
                        replacePasteCapsules(collapsed.state);
                        return {
                            value: collapsed.value,
                            cursorOffset: collapsed.cursorOffset,
                        };
                    }
                    if (currentHistory.length === 0) return undefined;
                    historyDraftRef.current = expandedValue();
                    const nextIndex = currentHistory.length - 1;
                    historyIndexRef.current = nextIndex;
                    setHistoryIndex(nextIndex);
                    replaceExpandedValue(currentHistory[nextIndex]!);
                    return undefined;
                }
                const nextIndex = Math.max(0, currentIndex - 1);
                historyIndexRef.current = nextIndex;
                setHistoryIndex(nextIndex);
                replaceExpandedValue(currentHistory[nextIndex]!);
                return undefined;
            }
            if (currentIndex === null) return undefined;
            if (currentIndex < currentHistory.length - 1) {
                const nextIndex = currentIndex + 1;
                historyIndexRef.current = nextIndex;
                setHistoryIndex(nextIndex);
                replaceExpandedValue(currentHistory[nextIndex]!);
                return undefined;
            }
            historyIndexRef.current = null;
            setHistoryIndex(null);
            replaceExpandedValue(historyDraftRef.current);
            return undefined;
        };

        const atomicRanges = useMemo(
            () => getPasteCapsuleRanges(value, pasteCapsules),
            [pasteCapsules, value]
        );

        useEffect(() => {
            setSelectedSuggestion(0);
        }, [value]);

        useInput(
            (_input, key) => {
                if (!showSuggestions) return;
                if (key.upArrow) {
                    setSelectedSuggestion((prev) =>
                        prev <= 0 ? suggestions.length - 1 : prev - 1
                    );
                } else if (key.downArrow) {
                    setSelectedSuggestion((prev) => (prev + 1) % suggestions.length);
                } else if (key.tab) {
                    const suggestion = suggestions[activeSuggestionIndex] || suggestions[0];
                    if (suggestion) {
                        replaceValue(`/${suggestion.name} `);
                    }
                }
            },
            {isActive: showSuggestions}
        );

        if (disabled) {
            return (
                <Box flexDirection="column">
                    {durationLabel && (
                        <Text color={COLORS.dim}>
                            {SYMBOLS.timer} {durationLabel}
                            {startedAt !== undefined ? " (esc to cancel)" : ""}
                        </Text>
                    )}
                    <Box paddingTop={1}>
                        <Text color={COLORS.dim}>...</Text>
                    </Box>
                    <Text color={COLORS.dim}>{line}</Text>
                </Box>
            );
        }

        return (
            <Box flexDirection="column">
                {durationLabel && (
                    <Text color={COLORS.dim}>
                        {SYMBOLS.timer} {durationLabel}
                        {startedAt !== undefined ? " (esc to cancel)" : ""}
                    </Text>
                )}
                <Box paddingTop={1} flexDirection="column">
                    <MultilineTextInput
                        value={value}
                        onChange={replaceValue}
                        width={width}
                        placeholder="Ask Pillar to build, inspect, or fix something"
                        handleVerticalNavigation={!showSuggestions}
                        onVerticalBoundary={(direction, state) =>
                            navigateHistory(direction, {
                                value: expandPasteCapsules(
                                    state.value,
                                    pasteCapsulesRef.current
                                ),
                                cursorOffset: expandPasteCapsuleCursor(
                                    state.value,
                                    state.cursorOffset,
                                    pasteCapsulesRef.current
                                ),
                            })
                        }
                        atomicRanges={atomicRanges}
                        onInputBoundary={() => pasteInput.reset()}
                        onAtomicRangeDelete={(range) => {
                            replacePasteCapsules(
                                removePasteCapsule(
                                    pasteCapsulesRef.current,
                                    range.id
                                )
                            );
                        }}
                        onInsertText={(text, state) => {
                            const insertion = pasteInput.insert(
                                state.value,
                                state.cursorOffset,
                                text,
                                pasteCapsulesRef.current
                            );
                            if (insertion.collapsed) {
                                replacePasteCapsules(insertion.state);
                            }
                            return {
                                value: insertion.value,
                                cursorOffset: insertion.cursorOffset,
                            };
                        }}
                        onSubmit={(v) => {
                            const suggestion = showSuggestions
                                ? suggestions[activeSuggestionIndex] || suggestions[0]
                                : undefined;
                            const submitted = suggestion
                                ? `/${suggestion.name}`
                                : expandPasteCapsules(
                                    v,
                                    pasteCapsulesRef.current
                                ).trim();
                            if (submitted || allowEmpty) {
                                onSubmit(submitted);
                                const isDuplicate = historyRef.current.at(-1) === submitted;
                                const nextHistory = isDuplicate
                                    ? historyRef.current
                                    : mergeHistory(historyRef.current, [submitted]);
                                historyRef.current = nextHistory;
                                setHistory(nextHistory);
                                if (cwd && sessionId && !isDuplicate) {
                                    void persistentHistory.append(
                                        cwd,
                                        sessionId,
                                        submitted
                                    ).catch(() => {
                                        // 持久化失败不能影响已经提交的 turn。
                                    });
                                }
                                historyIndexRef.current = null;
                                setHistoryIndex(null);
                                historyDraftRef.current = "";
                                replacePasteCapsules(EMPTY_PASTE_CAPSULE_STATE);
                                replaceValue("");
                            }
                        }}
                    />
                </Box>
                <Text color={COLORS.border}>{line}</Text>
                {showSuggestions && (
                    <Box flexDirection="column">
                        {visibleSuggestions.map((suggestion, index) => {
                            const suggestionIndex = suggestionWindowStart + index;
                            const selected = suggestionIndex === activeSuggestionIndex;
                            const label = formatCommand(suggestion.name, suggestion.argumentHint);
                            return (
                                <Box key={suggestion.name}>
                                    <Text color={selected ? COLORS.prompt : COLORS.dim}>
                                        {selected ? `${SYMBOLS.prompt} ` : "  "}
                                    </Text>
                                    <Text
                                        color={selected ? COLORS.toolName : COLORS.dim}
                                        bold={selected}
                                    >
                                        {padCommandLabel(label)}
                                    </Text>
                                    <Text color={COLORS.dim}>{suggestion.description}</Text>
                                </Box>
                            );
                        })}
                        {suggestions.length > MAX_VISIBLE_SLASH_SUGGESTIONS && (
                            <Text color={COLORS.dim}>
                                {"  ↑/↓ 选择 · Tab 补全 · "}
                                {suggestionWindowStart + 1}–{suggestionWindowStart + visibleSuggestions.length}
                                {` / ${suggestions.length}`}
                            </Text>
                        )}
                    </Box>
                )}
            </Box>
        );
    };
}

export const InputBox = createInputBox();
