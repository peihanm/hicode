import {throwIfTurnAborted} from "../runtime/abort.js";
import type {LLMCaller, Message} from "../llm/types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {getModelInputBudget} from "./window.js";
import {estimateMessageTokens} from "./tokens.js";
import {buildCompactPrompt, parseCompactSummary} from "./compactPrompt.js";
import {renderHandoff, type HandoffSources} from "./handoff.js";
import {selectCompactInput} from "./compactInput.js";

interface CompactSummaryDependencies {
    callLLM: LLMCaller;
}

export function createCompactSummaryGenerator(dependencies: CompactSummaryDependencies) {
    return (input: Parameters<typeof generateCompactSummaryCore>[0]) =>
        generateCompactSummaryCore(input, dependencies.callLLM);
}

async function generateCompactSummaryCore(input: {
    system: Extract<Message, {role: "system"}>;
    conversation: Message[];
    signal: AbortSignal;
    storage: PillarStorageLayout;
    cwd: string;
    model: string;
    customInstructions?: string;
    contextWindow?: number;
    sources?: HandoffSources;
}, callLLM: LLMCaller): Promise<string> {
    const {signal, storage, cwd, model, sources, contextWindow} = input;
    throwIfTurnAborted(signal);
    const inputBudget = getModelInputBudget(model, contextWindow);
    const selected = selectCompactInput({...input, prompt: buildCompactPrompt(input.customInstructions, sources),
        budget: Math.min(64_000, Math.floor(inputBudget * 0.8))});
    // One bounded request. Provider errors never trigger silent proportional history deletion.
    const {message} = await callLLM(selected.messages, [], storage, cwd, model, "compact", signal);
    throwIfTurnAborted(signal);
    if (message.role !== "assistant" || message.tool_calls?.length) throw new Error("工作交接必须是无工具调用的助手文本");
    const summary = typeof message.content === "string"
        ? sources ? renderHandoff(message.content, sources) : parseCompactSummary(message.content) : "";
    if (!summary) throw new Error("compact summary 为空");
    const result = [summary, selected.coverage].filter(Boolean).join("\n\n");
    if (estimateMessageTokens({role: "user", origin: "runtime" as const, content: result}) > Math.min(8000, Math.floor(inputBudget * 0.2))) {
        throw new Error("工作交接输出超过独立 token 预算，原历史已保留");
    }
    return result;
}
