import {useTerminalInput} from "../input/terminalInput.js";
import {useState} from "react";
import {Box, Text} from "ink";
import {TextInput} from "../input/TextInput.js";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";

import type {UserQuestion, UserAnswers} from "../../runtime/userQuestions.js";

const MAX_CUSTOM_ANSWER_CHARS = 16_384;

export function AskDialog({
                              req,
                              onDone,
                          }: {
    req: ConfirmReq;
    onDone: () => void;
}) {
    const askInput = req.input as { questions: UserQuestion[] };
    const questions = askInput.questions;
    const totalQuestions = questions.length;

    // Question index: 0..totalQuestions-1; totalQuestions selects the Submit screen.
    const [currentIndex, setCurrentIndex] = useState(0);
    // Submitted answers: Record<question_text, answer>.
    const [answers, setAnswers] = useState<UserAnswers>({});

    // State for Type something text entry.
    const [isTyping, setIsTyping] = useState(false);
    const [typedValue, setTypedValue] = useState("");
    // Text-entry focus: input or submit (submits text for the current question).
    const [focus, setFocus] = useState<"input" | "submit">("input");

    // Each question starts at selection index 0; the key change triggers useReset.
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selected, setSelected] = useState<number[]>([]);
    const typing = isTyping || (currentIndex < totalQuestions && !questions[currentIndex]!.options);


    // Submit all answers to executeTool.
    const submitAll = (finalAnswers: UserAnswers) => {
        req.resolve({
            behavior: "allow",
            answers: finalAnswers,
        });
        onDone();
    };

    // Record the current answer and advance.
    const recordAnswerAndAdvance = (answer: string | string[]) => {
        const currentQ = questions[currentIndex];
        const newAnswers = {...answers, [currentQ.question]: answer};

        // Single-question shortcut: submit directly without the review screen.
        if (totalQuestions === 1) {
            submitAll(newAnswers);
            return;
        }

        setAnswers(newAnswers);
        setCurrentIndex((i) => i + 1);
        // Reset selection so each new question starts at its first option.
        setSelectedIndex(0);
        setSelected([]);
        setTypedValue("");
        setFocus("input");
        setIsTyping(false);
    };

    // Text entry after selecting Type something.
    const exitTyping = () => {
        setIsTyping(false);
        setTypedValue("");
        setFocus("input");
    };

    useTerminalInput((_input, key) => {
        // Text-entry mode.
        if (typing) {
            if (focus === "input") {
                if (key.downArrow || key.tab) {
                    setFocus("submit");
                    return;
                }
                if (key.escape) {
                    exitTyping();
                    return;
                }
                return; // TextInput handles other keys.
            }
            // Focus is on the Submit button for the current answer.
            if (key.upArrow) {
                setFocus("input");
                return;
            }
            if (key.return || key.tab) {
                const trimmed = typedValue.trim();
                if (trimmed) {
                    setIsTyping(false);
                    setTypedValue("");
                    setFocus("input");
                    recordAnswerAndAdvance(questions[currentIndex]!.multi_select
                        ? [...selected.map(i => questions[currentIndex]!.options![i]!.label), trimmed].filter((v, i, a) => a.indexOf(v) === i) : trimmed);
                }
                return;
            }
            if (key.escape) {
                exitTyping();
                return;
            }
            return;
        }

        // Submit screen after all questions are answered.
        if (currentIndex === totalQuestions) {
            if (key.escape) {
                // App owns Turn cancellation so model and tool execution abort together.
                return;
            }
            if (key.return) {
                submitAll(answers);
                return;
            }
            return; // The Submit screen ignores other keys.
        }

        // Selection mode for the current question.
        if (key.escape) {
            // App owns cancellation of the current Turn.
            return;
        }

        const currentQ = questions[currentIndex];
        const typeSomethingIndex = (currentQ.options?.length ?? 0);
        const totalOptions = typeSomethingIndex + (currentQ.multi_select ? 2 : 1);

        if (key.upArrow) {
            setSelectedIndex((i) => (i - 1 + totalOptions) % totalOptions);
        } else if (key.downArrow) {
            setSelectedIndex((i) => (i + 1) % totalOptions);
        } else if (_input === " " && currentQ.multi_select && selectedIndex < typeSomethingIndex) {
            setSelected(values => values.includes(selectedIndex) ? values.filter(i => i !== selectedIndex) : [...values, selectedIndex].sort((a, b) => a - b));
        } else if (key.return) {
            if (currentQ.multi_select && selectedIndex === typeSomethingIndex + 1) {
                if (selected.length) recordAnswerAndAdvance(selected.map(i => currentQ.options![i]!.label));
            } else if (selectedIndex === typeSomethingIndex) {
                // Type something was selected; enter text-entry mode.
                setIsTyping(true);
                setFocus("input");
            } else {
                // Record the preset answer and advance.
                if (currentQ.multi_select) {
                    setSelected(values => values.includes(selectedIndex) ? values.filter(i => i !== selectedIndex) : [...values, selectedIndex].sort((a, b) => a - b));
                } else recordAnswerAndAdvance(currentQ.options![selectedIndex]!.label);
            }
        }
    });

    // recordAnswerAndAdvance calls setSelectedIndex(0) when changing questions.
    // This starts the new question at its first option rather than retaining the previous index.

    // Submit screen.
    if (currentIndex === totalQuestions) {
        return (
            <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
                <Text color={COLORS.dim}>Confirm answers · {totalQuestions}/{totalQuestions} answered</Text>
                <Box marginTop={1} flexDirection="column">
                    {questions.map((q, i) => (
                        <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
                            <Text color={COLORS.accent} bold>
                                {i + 1}. {q.question}
                            </Text>
                            <Box marginLeft={2}>
                                <Text color={COLORS.dim}>→ </Text>
                                <Text>{[answers[q.question]].flat().join(", ") || "(unanswered)"}</Text>
                            </Box>
                        </Box>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.accent} bold>
                        ❯ Submit answers
                    </Text>
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>Enter submit · Esc cancel</Text>
                </Box>
            </Box>
        );
    }

    // Current question screen.
    const currentQ = questions[currentIndex];
    const typeSomethingIndex = (currentQ.options?.length ?? 0);

    // Shortcut hints depend on the current state.
    const hint = typing
        ? focus === "input"
            ? currentQ.options ? "Enter/↓ next · Esc back to options" : "Enter/↓ next · Esc cancel"
            : currentQ.options ? "↑ edit · Enter confirm · Esc back to options" : "↑ edit · Enter confirm · Esc cancel"
        : currentQ.multi_select ? "↑↓ move · Space toggle · Select Confirm choices · Esc cancel" : "↑↓ select · Enter confirm · Esc cancel";

    // Show question progress for multiple questions.
    const progress =
        totalQuestions > 1
            ? `Question ${currentIndex + 1}/${totalQuestions}`
            : null;

    return (
        <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
            <Text color={COLORS.dim}>{req.questionDelivery === "async" ? "Question · Answer when ready" : "Confirmation needed"}{progress ? ` · ${progress}` : ""}</Text>
            <Box marginTop={1}>
                <Text bold>{currentQ.question}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                {(currentQ.options ?? []).map((opt, i) => {
                    const isSelected = i === selectedIndex && !typing;
                    return (
                        <Box key={i} marginTop={i > 0 ? 1 : 0}>
                            <Box width={5} flexShrink={0}>
                                <Text color={isSelected ? COLORS.accent : COLORS.dim}>
                                    {isSelected ? "❯" : " "} {i + 1}.{" "}
                                </Text>
                            </Box>
                            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                                <Text color={isSelected ? COLORS.accent : undefined} bold={isSelected}>
                                    {currentQ.multi_select ? `${selected.includes(i) ? "[x]" : "[ ]"} ${opt.label}` : opt.label}
                                </Text>
                                {opt.description && <Text color={COLORS.dim}>{opt.description}</Text>}
                            </Box>
                        </Box>
                    );
                })}

                <Box
                    marginTop={(currentQ.options?.length ?? 0) > 0 ? 1 : 0}
                    flexDirection="column"
                >
                    {typing ? (
                        <>
                            <Box>
                                <Text color={COLORS.dim}>{"  "}</Text>
                                <Text color={COLORS.accent} bold>
                                    {typeSomethingIndex + 1}.{" "}
                                </Text>
                                {focus === "input" ? (
                                    <TextInput
                                        value={typedValue}
                                        onChange={(value) =>
                                            setTypedValue(
                                                value.slice(0, MAX_CUSTOM_ANSWER_CHARS)
                                            )
                                        }
                                        onSubmit={() => setFocus("submit")}
                                        placeholder="Enter your answer…"
                                    />
                                ) : (
                                    <Text color={COLORS.dim}>
                                        {typedValue || "Enter your answer…"}
                                    </Text>
                                )}
                            </Box>
                            <Box marginTop={1}>
                                <Text color={focus === "submit" ? COLORS.accent : COLORS.dim}>
                                    {focus === "submit" ? "❯ " : "  "}
                                </Text>
                                <Text
                                    color={focus === "submit" ? COLORS.accent : COLORS.dim}
                                    bold={focus === "submit"}
                                >
                                    Confirm input
                                </Text>
                            </Box>
                        </>
                    ) : (
                        <Box>
                            <Text
                                color={
                                    selectedIndex === typeSomethingIndex
                                        ? COLORS.accent
                                        : COLORS.dim
                                }
                            >
                                {selectedIndex === typeSomethingIndex ? "❯ " : "  "}
                            </Text>
                            <Text
                                color={
                                    selectedIndex === typeSomethingIndex
                                        ? COLORS.accent
                                        : COLORS.dim
                                }
                                bold={selectedIndex === typeSomethingIndex}
                            >
                                {typeSomethingIndex + 1}. Enter your own answer…
                            </Text>
                        </Box>
                    )}
                </Box>
                {currentQ.multi_select && !typing && <Box marginTop={1}>
                    <Text color={selectedIndex === typeSomethingIndex + 1 ? COLORS.accent : COLORS.dim}>
                        {selectedIndex === typeSomethingIndex + 1 ? "❯ " : "  "}Confirm choices ({selected.length})
                    </Text>
                </Box>}
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>{hint}</Text>
            </Box>
        </Box>
    );
}
