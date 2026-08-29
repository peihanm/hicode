export type ConfiguredReasoningEffort = "high" | "max";

export function getConfiguredReasoningEffort(): ConfiguredReasoningEffort {
    const configured = process.env.PILLAR_REASONING_EFFORT
        ?.trim()
        .toLowerCase();
    if (configured && configured !== "high" && configured !== "max") {
        throw new Error("PILLAR_REASONING_EFFORT 只支持 high 或 max");
    }
    return configured === "max" ? "max" : "high";
}
