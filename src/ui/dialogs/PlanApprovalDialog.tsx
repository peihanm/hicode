import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import TextInput from "ink-text-input";
import stringWidth from "string-width";
import type {ConfirmReq} from "../turn/types.js";
import {TerminalMarkdown} from "../conversation/TerminalMarkdown.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const MAX_PLAN_PREVIEW_CHARS = 4000;
const MAX_PLAN_FEEDBACK_CHARS = 16_384;

interface ApprovalOption {
    label: string;
    value: "build" | "keep_planning";
}

function readPlan(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null || !("plan" in input)) {
        return undefined;
    }
    const plan = input.plan;
    if (typeof plan !== "string" || !plan.trim()) return undefined;
    return plan.trim();
}

function fitRow(value: string, width: number): string {
    let result = "";
    for (const segment of Array.from(value)) {
        if (stringWidth(result + segment) > width) break;
        result += segment;
    }
    return result + " ".repeat(Math.max(0, width - stringWidth(result)));
}

function planPreview(plan: string): {value: string; truncated: boolean} {
    if (plan.length <= MAX_PLAN_PREVIEW_CHARS) {
        return {value: plan, truncated: false};
    }
    return {
        value: plan.slice(0, MAX_PLAN_PREVIEW_CHARS),
        truncated: true,
    };
}

export function PlanApprovalDialog({
                                       req,
                                       onDone,
                                   }: {
    req: ConfirmReq;
    onDone: () => void;
}) {
    const contentWidth = Math.max(20, useTerminalWidth() - 6);
    const menuWidth = contentWidth;
    const plan = readPlan(req.input);
    const preview = plan ? planPreview(plan) : undefined;
    const completedRef = useRef(false);
    const [feedbackMode, setFeedbackMode] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);

    const finishDeny = (message: string) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve({behavior: "deny", message});
        onDone();
    };

    const options: ApprovalOption[] = [
        {
            label: "Build now",
            value: "build",
        },
        {
            label: "Keep planning",
            value: "keep_planning",
        },
    ];

    const handleSelect = (option: ApprovalOption) => {
        if (completedRef.current) return;
        if (option.value === "keep_planning") {
            setFeedbackMode(true);
            return;
        }
        completedRef.current = true;
        req.resolve({behavior: "allow"});
        onDone();
    };

    useInput((_input, key) => {
        if (completedRef.current) return;
        if (feedbackMode) {
            if (key.escape) {
                setFeedback("");
                setFeedbackMode(false);
            }
            return;
        }
        if (key.escape) {
            finishDeny("用户取消计划审批，继续留在 Plan 模式");
        } else if (!plan || !preview) {
            return;
        } else if (key.upArrow) {
            setSelectedIndex((index) =>
                (index - 1 + options.length) % options.length
            );
        } else if (key.downArrow) {
            setSelectedIndex((index) => (index + 1) % options.length);
        } else if (key.return) {
            const selected = options[selectedIndex];
            if (selected) handleSelect(selected);
        }
    });

    if (!plan || !preview) {
        return (
            <Box flexDirection="column" paddingLeft={2}>
                <Text color={COLORS.error} bold>◆ INVALID PLAN</Text>
                <Box marginTop={1}>
                    <Text>exit_plan_mode 输入缺少有效 plan。</Text>
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>esc 关闭并继续留在 Plan 模式</Text>
                </Box>
            </Box>
        );
    }

    const submitFeedback = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        finishDeny(trimmed);
    };

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Box flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>PLAN</Text>
                <TerminalMarkdown value={preview.value} width={contentWidth}/>
                {preview.truncated && (
                    <Text color={COLORS.dim}>…计划预览已截断，批准后仍会使用完整计划。</Text>
                )}
            </Box>
            {feedbackMode ? (
                <Box marginTop={1} flexDirection="column" width={contentWidth}>
                    <Text color={COLORS.dim} bold>FEEDBACK</Text>
                    <Text>Tell Pillar what to change before building.</Text>
                    <Box>
                        <Text color={COLORS.accent}>❯ </Text>
                        <TextInput
                            value={feedback}
                            onChange={(value) =>
                                setFeedback(
                                    value.slice(0, MAX_PLAN_FEEDBACK_CHARS)
                                )
                            }
                            onSubmit={submitFeedback}
                            focus
                        />
                    </Box>
                </Box>
            ) : (
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim} bold>ACTION</Text>
                    {options.map((option, index) => {
                        const focused = index === selectedIndex;
                        const row = fitRow(
                            `${focused ? "›" : " "} ${option.label}`,
                            menuWidth
                        );
                        return (
                            <Text
                                key={option.value}
                                backgroundColor={focused ? COLORS.accent : undefined}
                                color={focused ? "white" : undefined}
                                bold={focused}
                            >
                                {row}
                            </Text>
                        );
                    })}
                </Box>
            )}
            <Box marginTop={1}>
                <Text color={COLORS.dim}>
                    {feedbackMode
                        ? "enter 提交  ·  esc 返回选项"
                        : "↑↓ 选择  ·  enter 确认  ·  esc 继续规划"}
                </Text>
            </Box>
        </Box>
    );
}
