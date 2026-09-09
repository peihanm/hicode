import {createLLMCaller} from "../../llm/index.js";
import type {LLMCaller} from "../../llm/types.js";
import type {ProjectInstructions} from "../../prompt/instructions.js";
import type {ModelSourceSettings, ModelTargetSettings} from "../../settings/types.js";
import type {PillarStorageLayout} from "../../persistence/index.js";
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
        storage: PillarStorageLayout;
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
                if (!normalized) throw new Error("请先描述需要创建的 Agent");
                if (normalized.length > 8_000) {
                    throw new Error("Agent 创建需求超过 8000 字符上限");
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
                        "模型同时返回了普通正文；Agent 候选必须只通过提交工具返回"
                    );
                }
                if (result.toolCalls.length !== 1) {
                    throw new Error("模型没有提交唯一的 Agent 候选定义");
                }
                const call = result.toolCalls[0]!;
                if (call.function.name !== "submit_agent_definition") {
                    throw new Error(`模型调用了未知的候选提交工具: ${call.function.name}`);
                }
                let raw: unknown;
                try {
                    raw = JSON.parse(call.function.arguments);
                } catch {
                    throw new Error("模型返回的 Agent 候选参数不是合法 JSON");
                }
                const parsed = generatedAgentDefinitionSchema.safeParse(raw);
                if (!parsed.success) {
                    throw new Error(`Agent 候选校验失败: ${parsed.error.message}`);
                }
                const suggestedTools = [...new Set(parsed.data.suggested_tools)];
                const forbidden = suggestedTools.filter((tool) =>
                    CUSTOM_AGENT_FORBIDDEN_TOOLS.has(tool)
                );
                if (forbidden.length > 0) {
                    throw new Error(`模型建议了禁止工具: ${forbidden.join(", ")}`);
                }
                const unknown = suggestedTools.filter((tool) => !allowedTools.has(tool));
                if (unknown.length > 0) {
                    throw new Error(`模型建议了当前 Runtime 不存在的工具: ${unknown.join(", ")}`);
                }
                if (getExistingAgentNames().some((name) =>
                    name.toLocaleLowerCase("en-US") ===
                    parsed.data.name.toLocaleLowerCase("en-US")
                )) {
                    throw new Error(`Agent 名称已经存在: ${parsed.data.name}`);
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
    storage: PillarStorageLayout;
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
