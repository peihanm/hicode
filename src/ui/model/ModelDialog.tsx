import {useMemo} from "react";
import {Box, Text, useInput} from "ink";
import SelectInput from "ink-select-input";
import type {ModelTargetSettings} from "../../settings/types.js";
import {formatModelTarget} from "../../llm/modelCatalog.js";
import {DialogFrame, DialogIndicator, DialogItem,} from "../dialogs/DialogFrame.js";
import {COLORS} from "../theme.js";

interface ModelItem {
    key: string;
    label: string;
    value: ModelTargetSettings;
}

function sameTarget(left: ModelTargetSettings, right: ModelTargetSettings): boolean {
    return left.source === right.source && left.model === right.model;
}

export function ModelDialog({
    models,
    current,
    onSelect,
    onClose,
}: {
    models: readonly ModelTargetSettings[];
    current: ModelTargetSettings;
    onSelect(target: ModelTargetSettings): void;
    onClose(): void;
}) {
    const items = useMemo<ModelItem[]>(() => models.map((target) => ({
        key: `${target.source}:${target.model}`,
        label: `${sameTarget(target, current) ? "●" : " "} ${formatModelTarget(target)}`,
        value: target,
    })), [current, models]);
    const initialIndex = Math.max(
        0,
        models.findIndex((target) => sameTarget(target, current))
    );

    useInput((_input, key) => {
        if (key.escape) onClose();
    });

    return (
        <DialogFrame
            title="SELECT PRIMARY MODEL"
            subtitle={(
                <Text color={COLORS.dim}>
                    只影响主模型；Fast model 保持当前配置
                </Text>
            )}
            footer="↑↓ 选择 · enter 切换 · esc 返回"
        >
            <Box marginTop={1} flexDirection="column">
                {items.length > 0 ? (
                    <SelectInput
                        items={items}
                        initialIndex={initialIndex}
                        onSelect={(item) => onSelect(item.value)}
                        indicatorComponent={DialogIndicator}
                        itemComponent={DialogItem}
                    />
                ) : (
                    <Text color={COLORS.warning}>
                        没有可用主模型。请在 Settings 登记模型，并在 .env 配置对应 API key。
                    </Text>
                )}
            </Box>
        </DialogFrame>
    );
}
