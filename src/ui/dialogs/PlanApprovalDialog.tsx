import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import type {PermissionMode} from "../../permissions/index.js";
import type {ConfirmReq} from "../turn/types.js";
import {TerminalMarkdown} from "../conversation/TerminalMarkdown.js";
import {COLORS} from "../theme.js";
import {DialogFrame, DialogIndicator, DialogItem} from "./DialogFrame.js";
import {useTerminalWidth} from "../terminalSize.js";

const MAX_PLAN_PREVIEW_CHARS = 4000;

type ExitPermissionMode = Exclude<PermissionMode, "plan">;

interface ApprovalOption {
    label: string;
    value: ExitPermissionMode | "keep_planning";
}

function readPlan(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null || !("plan" in input)) {
        return undefined;
    }
    const plan = input.plan;
    if (typeof plan !== "string" || !plan.trim()) return undefined;
    return plan.trim();
}

function primaryApprovalOption(
    bypassPermissionsAvailable: boolean
): ApprovalOption {
    if (bypassPermissionsAvailable) {
        return {
            label: "1. Yes, and bypass permissions",
            value: "bypassPermissions",
        };
    }
    return {
        label: "1. Yes, auto-accept edits",
        value: "acceptEdits",
    };
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
                                       bypassPermissionsAvailable = false,
                                       onApprove,
                                       onDone,
                                   }: {
    req: ConfirmReq;
    bypassPermissionsAvailable?: boolean;
    onApprove: (mode: ExitPermissionMode) => void;
    onDone: () => void;
}) {
    const width = Math.max(1, useTerminalWidth() - 4);
    const plan = readPlan(req.input);
    const preview = plan ? planPreview(plan) : undefined;
    const completedRef = useRef(false);
    const [feedbackMode, setFeedbackMode] = useState(false);
    const [feedback, setFeedback] = useState("");

    const finishDeny = (message: string) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve({behavior: "deny", message});
        onDone();
    };

    useInput((_input, key) => {
        if (!key.escape || completedRef.current) return;
        if (feedbackMode) {
            setFeedback("");
            setFeedbackMode(false);
            return;
        }
        finishDeny("用户取消计划审批，继续留在 Plan 模式");
    });

    if (!plan || !preview) {
        return (
            <DialogFrame
                title="无法审批计划"
                tone="error"
                subtitle={<Text>exit_plan_mode 输入缺少有效 plan。</Text>}
                footer="Esc 关闭并继续留在 Plan 模式"
            />
        );
    }

    const options: ApprovalOption[] = [
        primaryApprovalOption(bypassPermissionsAvailable),
        {
            label: "2. Yes, manually approve edits",
            value: "default",
        },
        {
            label: "3. No, keep planning",
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
        onApprove(option.value);
        req.resolve({behavior: "allow"});
        onDone();
    };

    const submitFeedback = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        finishDeny(trimmed);
    };

    return (
        <DialogFrame
            title="Ready to code?"
            footer={feedbackMode
                ? "Enter 提交 · Esc 返回选项"
                : "↑↓ 选择 · Enter 确认 · Esc 继续规划"}
        >
            <Box marginTop={1} flexDirection="column">
                <TerminalMarkdown value={preview.value} width={width}/>
                {preview.truncated && (
                    <Text color={COLORS.dim}>…计划预览已截断，批准后仍会使用完整计划。</Text>
                )}
            </Box>
            {feedbackMode ? (
                <Box marginTop={1} flexDirection="column">
                    <Text>No, keep planning · Tell pillar what to change</Text>
                    <Box>
                        <Text color={COLORS.accent}>❯ </Text>
                        <TextInput
                            value={feedback}
                            onChange={setFeedback}
                            onSubmit={submitFeedback}
                            focus
                        />
                    </Box>
                </Box>
            ) : (
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>Would you like to proceed?</Text>
                    <SelectInput
                        items={options}
                        onSelect={handleSelect}
                        indicatorComponent={DialogIndicator}
                        itemComponent={DialogItem}
                    />
                </Box>
            )}
        </DialogFrame>
    );
}
