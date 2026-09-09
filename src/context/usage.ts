import {createHash} from "node:crypto";
import type {Message, OpenAITool} from "../llm/types.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import {tokenCountWithEstimation} from "./tokens.js";

interface Scope {model: string; provider: LLMProviderName; compactCount: number}
interface Baseline {key: string; schema: string; estimated: number; input: number}

/** Session-owned calibration; never reuse billable totals as request input usage. */
export class ContextUsageTracker {
    private baseline?: Baseline;
    private window?: {key: string; tokens: number};

    reset(): void { this.baseline = undefined; this.window = undefined; }

    contextWindow(scope: Scope): number | undefined {
        return this.window?.key === JSON.stringify([scope.provider, scope.model]) ? this.window.tokens : undefined;
    }

    estimate(scope: Scope, messages: Message[], tools: OpenAITool[]): number {
        const raw = tokenCountWithEstimation(messages, tools);
        const key = JSON.stringify([scope.provider, scope.model, scope.compactCount]);
        const schema = this.schema(messages, tools);
        if (!this.baseline || this.baseline.key !== key || this.baseline.schema !== schema) {
            this.baseline = undefined;
            return raw;
        }
        return Math.max(0, this.baseline.input + raw - this.baseline.estimated);
    }

    record(scope: Scope, messages: Message[], tools: OpenAITool[], input: number | undefined, contextWindow?: number): void {
        if (contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0) {
            this.window = {key: JSON.stringify([scope.provider, scope.model]), tokens: contextWindow};
        }
        if (input === undefined || !Number.isSafeInteger(input) || input <= 0) return;
        this.baseline = {key: JSON.stringify([scope.provider, scope.model, scope.compactCount]),
            schema: this.schema(messages, tools), estimated: tokenCountWithEstimation(messages, tools), input};
    }

    private schema(messages: Message[], tools: OpenAITool[]): string {
        return createHash("sha256").update(JSON.stringify([messages.filter(message => message.role === "system"), tools])).digest("hex");
    }
}
