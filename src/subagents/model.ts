export type SubagentModelOverride = "inherit" | "fast";

export function resolveSubagentModel({
    definitionModel,
    parentModel,
    fastModel,
    override,
}: {
    definitionModel: string;
    parentModel: string;
    fastModel: string;
    override?: SubagentModelOverride;
}): string {
    const selection = override ?? definitionModel;
    if (selection === "inherit") return parentModel;
    if (selection === "fast") return fastModel;
    return selection;
}

export function formatSubagentModel(
    selection: string,
    inheritLabel = "继承父模型",
    fastModel?: string
): string {
    if (selection === "inherit") return inheritLabel;
    if (selection === "fast") {
        return fastModel
            ? `fast (${fastModel})`
            : "fast（使用配置的快速模型）";
    }
    return selection;
}
