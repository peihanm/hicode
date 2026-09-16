import {useRef, useState} from "react";
import {Box, Text} from "ink";
import SelectInput from "ink-select-input";
import type {PermissionDecision} from "../../permissions/index.js";
import {generateRuleForTool} from "../../permissions/index.js";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {DialogIndicator, DialogItem} from "./DialogFrame.js";

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
        label: "3. No, and tell hicode what to do differently",
        value: "no",
    },
];

const BASIC_OPTIONS: ConfirmOption[] = [
    {label: "1. Yes", value: "yes"},
    {
        label: "2. No, and tell hicode what to do differently",
        value: "no",
    },
];

function boundedErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.replace(/\s+/g, " ").trim();
    return normalized.length > 300
        ? `${normalized.slice(0, 297)}...`
        : normalized || "Unknown error";
}

// Menu confirmation dialog: arrow keys select and Enter confirms.
// Codebuddy-style presentation.
// resolve returns a PermissionDecision (allow/deny), not a boolean.
// yes_no_ask invokes onAddToAllowList to generate and persist a rule.
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

        // yes_no_ask generates a rule, writes configuration and permits execution.
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
                ? {behavior: "deny", message: "User denied"}
                : {behavior: "allow"};
        // Both yes and yes_no_ask resolve to allow.
        req.resolve(decision);
        onDone();
    };

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.warning} bold>◆ PERMISSION REQUIRED</Text>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim} bold>REQUEST</Text>
                <Text>{req.question}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim} bold>ACTION</Text>
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
                    <Text color={COLORS.dim}>Saving project permission rules…</Text>
                </Box>
            )}
            {saveError && (
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.error}>
                        Failed to save project permission rules: {saveError}
                    </Text>
                    <Text color={COLORS.dim}>
                        Retry, or choose option 1 to allow this call only.
                    </Text>
                </Box>
            )}
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ select · Enter confirm · Esc cancel</Text>
            </Box>
        </Box>
    );
}
