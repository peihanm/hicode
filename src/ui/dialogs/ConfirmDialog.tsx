import {useRef, useState} from "react";
import {Box, Text} from "ink";
import SelectInput from "ink-select-input";
import type {PermissionDecision} from "../../permissions/index.js";
import {generateRuleForTool} from "../../permissions/index.js";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {DialogFrame, DialogIndicator, DialogItem} from "./DialogFrame.js";

interface ConfirmOption {
    label: string;
    value: "yes" | "yes_no_ask" | "no";
}

const TOOL_OPTIONS: ConfirmOption[] = [
    {label: "1. Yes", value: "yes"},
    {
        label: "2. Yes, and don't ask again for this project",
        value: "yes_no_ask",
    },
    {
        label: "3. No, and tell pillar what to do differently",
        value: "no",
    },
];

const BASIC_OPTIONS: ConfirmOption[] = [
    {label: "1. Yes", value: "yes"},
    {
        label: "2. No, and tell pillar what to do differently",
        value: "no",
    },
];

function boundedErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.replace(/\s+/g, " ").trim();
    return normalized.length > 300
        ? `${normalized.slice(0, 297)}...`
        : normalized || "未知错误";
}

// 菜单式确认对话框：上下箭头切换，回车确认
// 仿 codebuddy 风格
// resolve 返回 PermissionDecision（allow/deny），不是 boolean
// 选 "yes_no_ask" 时调 onAddToAllowList 生成规则 + 写入配置文件
export function ConfirmDialog({
                                  req,
                                  onDone,
                                  onAddToAllowList,
                              }: {
    req: ConfirmReq;
    onDone: () => void;
    onAddToAllowList?: (rule: string) => Promise<void>;
}) {
    const options = req.allowAddToAllowList === false ? BASIC_OPTIONS : TOOL_OPTIONS;
    const savingRef = useRef(false);
    const completedRef = useRef(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const handleSelect = async (opt: ConfirmOption) => {
        if (savingRef.current || completedRef.current) return;

        // 选 "yes_no_ask" 时：生成规则 + 写入配置 + 视为 allow
        if (
            opt.value === "yes_no_ask" &&
            req.allowAddToAllowList !== false &&
            onAddToAllowList
        ) {
            const rule = generateRuleForTool(req.toolName, req.input);
            if (rule) {
                savingRef.current = true;
                setSaving(true);
                setSaveError(null);
                try {
                    await onAddToAllowList(rule);
                } catch (error) {
                    setSaveError(boundedErrorMessage(error));
                    return;
                } finally {
                    savingRef.current = false;
                    setSaving(false);
                }
            }
        }

        completedRef.current = true;
        const decision: PermissionDecision =
            opt.value === "no"
                ? {behavior: "deny", message: "用户拒绝"}
                : {behavior: "allow"};
        // yes / yes_no_ask 都当 allow 处理
        req.resolve(decision);
        onDone();
    };

    return (
        <DialogFrame
            title="Permission request"
            subtitle={<Text>{req.question}</Text>}
            footer="↑↓ 选择 · Enter 确认 · Esc 取消"
        >
            <Box marginTop={1}>
                <SelectInput
                    items={options}
                    onSelect={handleSelect}
                    isFocused={!saving}
                    indicatorComponent={DialogIndicator}
                    itemComponent={DialogItem}
                />
            </Box>
            {saving && (
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>正在保存项目权限规则…</Text>
                </Box>
            )}
            {saveError && (
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.error}>
                        未能保存项目权限规则：{saveError}
                    </Text>
                    <Text color={COLORS.dim}>
                        可以重试，或选择 1 仅允许本次调用。
                    </Text>
                </Box>
            )}
        </DialogFrame>
    );
}
