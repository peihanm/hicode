import {useState} from "react";
import {Box, Text, useInput} from "ink";
import TextInput from "ink-text-input";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";

// 多选题对话框：LLM 调 ask_user 工具时弹出
//
// 设计参考 claude-code AskUserQuestionPermissionRequest：
//   - 支持 1-4 个问题，逐个显示（不是一次全显示）
//   - 单选选了自动跳下一个（auto-advance）
//   - Type something 选了进入输入模式 + Submit 按钮
//   - 最后一个问题答完 → 进入 Submit 视图（回顾所有 Q&A + Submit/Cancel）
//   - 单问题时 short-circuit：答完直接提交，跳过 Submit 视图
//
// 简化点（相对 claude-code）：
//   - 不做 multiSelect（所有问题单选，选了就跳下一个）
//   - 不做 QuestionNavigationBar（进度条 tab）
//   - 不做 Tab/Shift+Tab 在问题间跳转（只能向前）
//   - 不做 preview / annotations
//   - 不做 "Chat about this" / "Respond to Claude" 额外选项
//
// 数据流：
//   LLM 调 ask_user({questions: [...]})
//     → checkPermissions 返回 ask
//     → canUseTool 弹窗（App.tsx 按 toolName 分发到 AskDialog）
//     → 用户逐个回答
//     → resolve({ behavior: 'allow', answers: {Q: A} })
//     → executeTool 经 invocation 提供答案，不替换原问题
//     → tool.execute 返回 "用户回答: ..."

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

    // 当前问题索引：0..totalQuestions-1 是问题，totalQuestions 是 Submit 视图
    const [currentIndex, setCurrentIndex] = useState(0);
    // 已提交的答案：Record<question_text, answer>
    const [answers, setAnswers] = useState<Record<string, string>>({});

    // Type something 输入模式状态
    const [isTyping, setIsTyping] = useState(false);
    const [typedValue, setTypedValue] = useState("");
    // 输入模式下焦点：'input'（输入框）或 'submit'（Submit 按钮，用于提交当前问题的输入）
    const [focus, setFocus] = useState<"input" | "submit">("input");

    // 当前问题的选择索引（每个问题都从 0 开始，useReset 重置由 key 变化触发）
    const [selectedIndex, setSelectedIndex] = useState(0);

    // 提交所有答案给 executeTool
    const submitAll = (finalAnswers: Record<string, string>) => {
        req.resolve({
            behavior: "allow",
            answers: finalAnswers,
        });
        onDone();
    };

    // 记录当前问题答案并前进到下一个
    const recordAnswerAndAdvance = (answer: string) => {
        const currentQ = questions[currentIndex];
        const newAnswers = {...answers, [currentQ.question]: answer};

        // 单问题 short-circuit：答完直接提交，跳过 Submit 视图
        // 参考 claude-code handleQuestionAnswer 的 isSingleQuestion 分支
        if (totalQuestions === 1) {
            submitAll(newAnswers);
            return;
        }

        setAnswers(newAnswers);
        setCurrentIndex((i) => i + 1);
        // 重置选择索引：新问题从第一个选项开始
        setSelectedIndex(0);
    };

    // ── 输入模式（Type something 被选中后）──
    const exitTyping = () => {
        setIsTyping(false);
        setTypedValue("");
        setFocus("input");
    };

    useInput((_input, key) => {
        // ── 输入模式 ──
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
                return; // 其他按键由 TextInput 处理
            }
            // 焦点在 Submit 按钮（提交当前问题的输入）
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

        // ── Submit 视图（所有问题答完）──
        if (currentIndex === totalQuestions) {
            if (key.escape) {
                // 当前 turn 的取消由 App 统一处理，确保同时 abort 模型/工具链。
                return;
            }
            if (key.return) {
                submitAll(answers);
                return;
            }
            return; // Submit 视图不响应其他键
        }

        // ── 选择模式（当前问题）──
        if (key.escape) {
            // 当前 turn 的取消由 App 统一处理。
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
                // 选了 Type something，进入输入模式
                setIsTyping(true);
                setFocus("input");
            } else {
                // 预设选项：记录答案并前进
                recordAnswerAndAdvance(currentQ.options[selectedIndex].label);
            }
        }
    });

    // 切换问题时重置选中索引：recordAnswerAndAdvance 里调 setSelectedIndex(0)
    // 这样新问题从第一个选项开始，不会带上一题的 index 过来

    // ── Submit 视图 ──
    if (currentIndex === totalQuestions) {
        return (
            <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
                <Text color={COLORS.dim}>确认回答 · {totalQuestions}/{totalQuestions} 已回答</Text>
                <Box marginTop={1} flexDirection="column">
                    {questions.map((q, i) => (
                        <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
                            <Text color={COLORS.accent} bold>
                                {i + 1}. {q.question}
                            </Text>
                            <Box marginLeft={2}>
                                <Text color={COLORS.dim}>→ </Text>
                                <Text>{answers[q.question] ?? "(未回答)"}</Text>
                            </Box>
                        </Box>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.accent} bold>
                        ❯ 提交回答
                    </Text>
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>Enter 提交 · Esc 取消</Text>
                </Box>
            </Box>
        );
    }

    // ── 当前问题视图 ──
    const currentQ = questions[currentIndex];
    const typeSomethingIndex = currentQ.options.length;

    // 快捷键提示（根据状态动态显示）
    const hint = isTyping
        ? focus === "input"
            ? "Enter/↓ 下一步 · Esc 返回选项"
            : "↑ 编辑 · Enter 确认 · Esc 返回选项"
        : "↑↓ 选择 · Enter 确认 · Esc 取消";

    // 进度提示（多问题时显示）
    const progress =
        totalQuestions > 1
            ? `问题 ${currentIndex + 1}/${totalQuestions}`
            : null;

    return (
        <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
            <Text color={COLORS.dim}>需要你确认{progress ? ` · ${progress}` : ""}</Text>
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
                                        placeholder="输入你的回答…"
                                    />
                                ) : (
                                    <Text color={COLORS.dim}>
                                        {typedValue || "输入你的回答…"}
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
                                    确认输入
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
                                {typeSomethingIndex + 1}. 自己填写…
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
