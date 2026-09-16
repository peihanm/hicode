import {createLLMCaller} from "../../llm/index.js";
import type {LLMCaller} from "../../llm/types.js";
import type {ProjectInstructions} from "../../prompt/instructions.js";
import type {ModelSourceSettings, ModelTargetSettings} from "../../settings/types.js";
import type {HiCodeStorageLayout} from "../../persistence/index.js";
import {CUSTOM_AGENT_FORBIDDEN_TOOLS} from "../custom.js";
import type {AgentDefinitionDraft} from "../store.js";
import {createAgentAuthoringPrompt} from "./prompt.js";
import {generatedAgentDefinitionSchema, submitAgentDefinitionTool,} from "./schema.js";

export interface AgentAuthoringRuntime {
    generate(requirement: string, signal?: AbortSignal): Promise<AgentDefinitionDraft>;
}

interface AgentDefinitionGeneratorDependencies {
    callLLM: LLMCaller;
}

export function createAgentDefinitionGenerator(
    dependencies: AgentDefinitionGeneratorDependencies
) {
    return function createConfiguredAgentAuthoringRuntime({
        storage,
        cwd,
        model,
        instructions,
        availableToolNames,
        getExistingAgentNames,
    }: {
        storage: HiCodeStorageLayout;
        cwd: string;
        model: string;
        instructions: ProjectInstructions;
        availableToolNames: readonly string[];
        getExistingAgentNames(): readonly string[];
    }): AgentAuthoringRuntime {
        const allowedTools = new Set(availableToolNames);
        return {
            async generate(requirement, signal) {
                const normalized = requirement.trim();
                if (!normalized) throw new Error("Describe the Agent to create first");
                if (normalized.length > 8_000) {
                    throw new Error("Agent creation request exceeds 8000 characters");
                }
                const result = await dependencies.callLLM(
                    [{
                        role: "system",
                        content: createAgentAuthoringPrompt({
                            availableToolNames,
                            existingAgentNames: getExistingAgentNames(),
                            instructions,
                        }),
                    }, {role: "user", origin: "runtime" as const, content: normalized}],
                    [submitAgentDefinitionTool],
                    storage,
                    cwd,
                    model,
                    "agent_authoring",
                    signal
                );
                const text = result.message.role === "assistant"
                    ? result.message.content?.trim()
                    : undefined;
                if (text) {
                    throw new Error(
                        "The model also returned ordinary text; Agent candidates must be returned only through the submission tool"
                    );
                }
                if (result.toolCalls.length !== 1) {
                    throw new Error("The model did not submit exactly one Agent candidate");
                }
                const call = result.toolCalls[0]!;
                if (call.function.name !== "submit_agent_definition") {
                    throw new Error(`The model called an unknown candidate submission tool: ${call.function.name}`);
                }
                let raw: unknown;
                try {
                    raw = JSON.parse(call.function.arguments);
                } catch {
                    throw new Error("Agent candidate arguments are not valid JSON");
                }
                const parsed = generatedAgentDefinitionSchema.safeParse(raw);
                if (!parsed.success) {
                    throw new Error(`Agent candidate validation failed: ${parsed.error.message}`);
                }
                const suggestedTools = [...new Set(parsed.data.suggested_tools)];
                const forbidden = suggestedTools.filter((tool) =>
                    CUSTOM_AGENT_FORBIDDEN_TOOLS.has(tool)
                );
                if (forbidden.length > 0) {
                    throw new Error(`The model suggested forbidden tools: ${forbidden.join(", ")}`);
                }
                const unknown = suggestedTools.filter((tool) => !allowedTools.has(tool));
                if (unknown.length > 0) {
                    throw new Error(`The model suggested tools unavailable in this Runtime: ${unknown.join(", ")}`);
                }
                if (getExistingAgentNames().some((name) =>
                    name.toLocaleLowerCase("en-US") ===
                    parsed.data.name.toLocaleLowerCase("en-US")
                )) {
                    throw new Error(`Agent name already exists: ${parsed.data.name}`);
                }
                return {
                    name: parsed.data.name,
                    description: parsed.data.description,
                    systemPrompt: parsed.data.system_prompt,
                    tools: suggestedTools,
                    model: parsed.data.model,
                    maxIterations: parsed.data.max_iterations,
                };
            },
        };
    };
}

export function createAgentAuthoringRuntime(options: {
    storage: HiCodeStorageLayout;
    cwd: string;
    getModelTarget(): ModelTargetSettings;
    getModelSource(source: ModelTargetSettings["source"]): ModelSourceSettings;
    instructions: ProjectInstructions;
    availableToolNames: readonly string[];
    getExistingAgentNames(): readonly string[];
}): AgentAuthoringRuntime {
    return {
        generate(requirement, signal) {
            const target = options.getModelTarget();
            return createAgentDefinitionGenerator({
                callLLM: createLLMCaller(
                    options.getModelSource(target.source)
                ),
            })({
                storage: options.storage,
                cwd: options.cwd,
                model: target.model,
                instructions: options.instructions,
                availableToolNames: options.availableToolNames,
                getExistingAgentNames: options.getExistingAgentNames,
            }).generate(requirement, signal);
        },
    };
}
