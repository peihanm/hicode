import {useState} from "react";
import {Box, Text, useInput} from "ink";
import SelectInput from "ink-select-input";
import type {HookTrustDecision, HookTrustRequest} from "../../hooks/index.js";
import {COLORS} from "../theme.js";
import {DialogFrame, DialogIndicator, DialogItem} from "../dialogs/DialogFrame.js";

const OPTIONS: Array<{label: string; value: HookTrustDecision}> = [
    {label: "1. Allow for this run", value: "once"},
    {label: "2. Always allow these definitions", value: "always"},
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
    const [page, setPage] = useState(0);
    const pages = Math.max(1, Math.ceil(request.hooks.length / 8));
    useInput((_input, key) => {
        if (key.escape) onDecision("deny");
        if (key.leftArrow) setPage(value => Math.max(0, value - 1));
        if (key.rightArrow) setPage(value => Math.min(pages - 1, value + 1));
    });
    return (
        <DialogFrame
            title="Hook definition request"
            subtitle={
                <Text>当前项目配置了会执行命令或调用模型的 Hooks</Text>
            }
            footer="↑↓ 选择 · ←→ 查看定义 · Enter 确认 · Esc 拒绝"
        >
            <Box marginTop={1} flexDirection="column">
                {request.hooks.slice(page * 8, (page + 1) * 8).map((hook, index) => (
                    <Box key={`${hook.event}-${index}`} flexDirection="column">
                        <Text>
                            {hook.event} · {hook.type}: {boundedHandler(
                                hook.type === "command"
                                    ? hook.command ?? JSON.stringify([hook.executable, ...(hook.args ?? [])])
                                    : hook.prompt ?? ""
                            )}
                        </Text>
                        <Text color={COLORS.dim}>
                            {hook.purpose} · {hook.hookId.slice(0, 12)} · {hook.matcher ?? "*"} ·
                            {hook.condition ? `if: ${hook.condition} · ` : ""}
                            {hook.shell ? `shell: ${hook.shell} · ` : ""}
                            {hook.once ? "once · " : ""}
                            {hook.source}: {hook.source === "host"
                                ? hook.id
                                : hook.path}
                        </Text>
                    </Box>
                ))}
                {request.hooks.length > 8 && (
                    <Text color={COLORS.dim}>
                        定义 {page + 1}/{pages} 页 · 共 {request.hooks.length} 个 Hook（←→ 翻页）
                    </Text>
                )}
                <Text color={COLORS.dim}>Project: {request.projectPath}</Text>
                <Text color={COLORS.dim}>
                    批准绑定以上定义；引用脚本正文的变化不在指纹范围内。
                </Text>
            </Box>
            <Box marginTop={1}>
                <SelectInput
                    items={OPTIONS}
                    onSelect={(item) => onDecision(item.value)}
                    indicatorComponent={DialogIndicator}
                    itemComponent={DialogItem}
                />
            </Box>
        </DialogFrame>
    );
}
