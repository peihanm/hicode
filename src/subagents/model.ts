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
    inheritLabel = "Inherit parent model",
    fastModel?: string
): string {
    if (selection === "inherit") return inheritLabel;
    return fastModel
        ? `fast (${fastModel})`
        : "fast (configured fast model)";
}
