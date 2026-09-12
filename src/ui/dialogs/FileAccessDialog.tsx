import {Box, Text} from "ink";
import SelectInput from "ink-select-input";
import type {PermissionDecision} from "../../permissions/index.js";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {DialogIndicator, DialogItem} from "./DialogFrame.js";

interface FileAccessOption {
    label: string;
    value: "once" | "session" | "project" | "deny";
}

export function isFileAccessRequest(
    request: ConfirmReq
): request is ConfirmReq & {
    presentation: Extract<
        NonNullable<ConfirmReq["presentation"]>,
        {kind: "filesystem_access"}
    >;
} {
    return request.presentation?.kind === "filesystem_access";
}

export function FileAccessDialog({
    req,
    onDone,
}: {
    req: ConfirmReq & {
        presentation: Extract<
            NonNullable<ConfirmReq["presentation"]>,
            {kind: "filesystem_access"}
        >;
    };
    onDone: () => void;
}) {
    const {operation, targetPath, suggestedDirectory} = req.presentation;
    const action = operation === "delete"
        ? "Delete"
        : operation === "edit"
            ? "Edit"
            : "Write";
    const options: FileAccessOption[] = [
        {label: "1. Allow this change once", value: "once"},
        {
            label: `2. Allow ${suggestedDirectory} for this session`,
            value: "session",
        },
        {
            label: `3. Always allow ${suggestedDirectory} for this project`,
            value: "project",
        },
        {label: "4. Deny", value: "deny"},
    ];

    const handleSelect = (option: FileAccessOption) => {
        const decision: PermissionDecision = option.value === "deny"
            ? {behavior: "deny", message: "User denied directory access"}
            : {behavior: "allow", directoryScope: option.value};
        req.resolve(decision);
        onDone();
    };

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.warning} bold>◆ FILE ACCESS</Text>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim} bold>{action.toUpperCase()}</Text>
                <Text>{targetPath}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim} bold>ACTION</Text>
                <SelectInput
                    items={options}
                    onSelect={handleSelect}
                    indicatorComponent={DialogIndicator}
                    itemComponent={DialogItem}
                />
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ select · Enter confirm · Esc cancel</Text>
            </Box>
        </Box>
    );
}
