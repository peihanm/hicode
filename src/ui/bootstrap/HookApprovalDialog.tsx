import {Box, Text} from "ink";
import SelectInput from "ink-select-input";
import type {HookTrustDecision, HookTrustRequest} from "../../hooks/index.js";
import {COLORS} from "../theme.js";

const OPTIONS: Array<{label: string; value: HookTrustDecision}> = [
    {label: "1. Allow once", value: "once"},
    {label: "2. Always allow for this project", value: "always"},
    {label: "3. Deny", value: "deny"},
];

function boundedHandler(handler: string): string {
    const line = handler.replace(/\s+/g, " ").trim();
    return line.length <= 160 ? line : `${line.slice(0, 159)}…`;
}

export function HookApprovalDialog({
                                       request,
                                       onDecision,
                                   }: {
    request: HookTrustRequest;
    onDecision: (decision: HookTrustDecision) => void;
}) {
    return (
        <Box flexDirection="column">
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor={COLORS.confirm}
                paddingX={1}
            >
                <Text color={COLORS.confirm}>
                    当前项目配置了会执行命令或调用模型的 Hooks
                </Text>
                {request.hooks.slice(0, 8).map((hook, index) => (
                    <Box key={`${hook.event}-${index}`} flexDirection="column">
                        <Text>
                            {hook.event} · {hook.type}: {boundedHandler(
                                hook.type === "command"
                                    ? hook.command ?? ""
                                    : hook.prompt ?? ""
                            )}
                        </Text>
                        <Text color={COLORS.dim}>
                            {hook.condition ? `if: ${hook.condition} · ` : ""}
                            {hook.shell ? `shell: ${hook.shell} · ` : ""}
                            {hook.once ? "once · " : ""}
                            {hook.source}: {hook.path}
                        </Text>
                    </Box>
                ))}
                {request.hooks.length > 8 && (
                    <Text color={COLORS.dim}>
                        另有 {request.hooks.length - 8} 个 Hook…
                    </Text>
                )}
                <Text color={COLORS.dim}>Project: {request.projectPath}</Text>
                <Text color={COLORS.dim}>
                    即使处于 Bypass 模式，也必须先信任工作区。
                </Text>
            </Box>
            <Box marginTop={1}>
                <SelectInput
                    items={OPTIONS}
                    onSelect={(item) => onDecision(item.value)}
                />
            </Box>
        </Box>
    );
}
