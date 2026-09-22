import {useState} from "react";
import {Box, Text, useInput} from "ink";
import TextInput from "ink-text-input";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";

// Multiple-choice dialog shown when the LLM calls ask_user.
//
// - Supports 1-4 questions, displayed individually.
// - Choosing an option advances automatically.
// - Type something opens text entry with a Submit button.
// - After the last answer, show a review screen with Submit/Cancel.
// - For a single question, submit immediately without the review screen.
//
// Questions are single-choice and advance forward without tab navigation.
//
// Data flow:
// LLM calls ask_user({questions: [...]})
// -> checkPermissions returns ask
// -> canUseTool opens the dialog (App.tsx dispatches to AskDialog by toolName)
// -> the user answers each question
//     → resolve({ behavior: 'allow', answers: {Q: A} })
// -> executeTool supplies answers through invocation without replacing the questions
// -> tool.execute returns "User answers: ..."

type Option = { label: string; description?: string };
type Question = {
    question: string;
    options: Option[];
};

const MAX_CUSTOM_ANSWER_CHARS = 16_384;

export function AskDialog({
                              req,
                              onDone,
                          }: {
    req: ConfirmReq;
    onDone: () => void;
}) {
    const askInput = req.input as { questions: Question[] };
    const questions = askInput.questions;
    const totalQuestions = questions.length;

    // Question index: 0..totalQuestions-1; totalQuestions selects the Submit screen.
    const [currentIndex, setCurrentIndex] = useState(0);
    // Submitted answers: Record<question_text, answer>.
    const [answers, setAnswers] = useState<Record<string, string>>({});

    // State for Type something text entry.
    const [isTyping, setIsTyping] = useState(false);
    const [typedValue, setTypedValue] = useState("");
    // Text-entry focus: input or submit (submits text for the current question).
    const [focus, setFocus] = useState<"input" | "submit">("input");

    // Each question starts at selection index 0; the key change triggers useReset.
    const [selectedIndex, setSelectedIndex] = useState(0);

    // Submit all answers to executeTool.
    const submitAll = (finalAnswers: Record<string, string>) => {
        req.resolve({
            behavior: "allow",
            answers: finalAnswers,
        });
        onDone();
    };

    // Record the current answer and advance.
    const recordAnswerAndAdvance = (answer: string) => {
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
    };

    // Text entry after selecting Type something.
    const exitTyping = () => {
        setIsTyping(false);
        setTypedValue("");
        setFocus("input");
    };

    useInput((_input, key) => {
        // Text-entry mode.
        if (isTyping) {
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
                    recordAnswerAndAdvance(trimmed);
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
        const typeSomethingIndex = currentQ.options.length;
        const totalOptions = typeSomethingIndex + 1;

        if (key.upArrow) {
            setSelectedIndex((i) => (i - 1 + totalOptions) % totalOptions);
        } else if (key.downArrow) {
            setSelectedIndex((i) => (i + 1) % totalOptions);
        } else if (key.return) {
            if (selectedIndex === typeSomethingIndex) {
                // Type something was selected; enter text-entry mode.
                setIsTyping(true);
                setFocus("input");
            } else {
                // Record the preset answer and advance.
                recordAnswerAndAdvance(currentQ.options[selectedIndex].label);
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
                                <Text>{answers[q.question] ?? "(unanswered)"}</Text>
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
    const typeSomethingIndex = currentQ.options.length;

    // Shortcut hints depend on the current state.
    const hint = isTyping
        ? focus === "input"
            ? "Enter/↓ next · Esc back to options"
            : "↑ edit · Enter confirm · Esc back to options"
        : "↑↓ select · Enter confirm · Esc cancel";

    // Show question progress for multiple questions.
    const progress =
        totalQuestions > 1
            ? `Question ${currentIndex + 1}/${totalQuestions}`
            : null;

    return (
        <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
            <Text color={COLORS.dim}>Confirmation needed{progress ? ` · ${progress}` : ""}</Text>
            <Box marginTop={1}>
                <Text bold>{currentQ.question}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                {currentQ.options.map((opt, i) => {
                    const isSelected = i === selectedIndex && !isTyping;
                    return (
                        <Box key={i} marginTop={i > 0 ? 1 : 0}>
                            <Box width={5} flexShrink={0}>
                                <Text color={isSelected ? COLORS.accent : COLORS.dim}>
                                    {isSelected ? "❯" : " "} {i + 1}.{" "}
                                </Text>
                            </Box>
                            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                                <Text color={isSelected ? COLORS.accent : undefined} bold={isSelected}>
                                    {opt.label}
                                </Text>
                                {opt.description && <Text color={COLORS.dim}>{opt.description}</Text>}
                            </Box>
                        </Box>
                    );
                })}

                <Box
                    marginTop={currentQ.options.length > 0 ? 1 : 0}
                    flexDirection="column"
                >
                    {isTyping ? (
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
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>{hint}</Text>
            </Box>
        </Box>
    );
}
