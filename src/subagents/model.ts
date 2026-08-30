export type SubagentModelOverride = "inherit" | "fast";

export function resolveSubagentModel({
    definitionModel,
    parentModel,
    fastModel,
    override,
}: {
    definitionModel: SubagentModelOverride;
    parentModel: string;
    fastModel: string;
    override?: SubagentModelOverride;
}): string {
    const selection = override ?? definitionModel;
    if (selection === "inherit") return parentModel;
    return fastModel;
}

export function formatSubagentModel(
    selection: SubagentModelOverride,
    inheritLabel = "继承父模型",
    fastModel?: string
): string {
    if (selection === "inherit") return inheritLabel;
    return fastModel
        ? `fast (${fastModel})`
        : "fast（使用配置的快速模型）";
}
