import {deepseekProvider} from "./providers/deepseek.js";
import {glmProvider} from "./providers/glm.js";
import {qwenProvider} from "./providers/qwen.js";
import {openrouterProvider} from "./providers/openrouter.js";
import {arkAgentPlanProvider} from "./providers/arkAgentPlan.js";
import type {LLMProviderName} from "./providerRegistry.js";
import type {LLMCaller, LLMProvider, LLMSourceConnection} from "./types.js";

const providers: Record<LLMProviderName, LLMProvider> = {
    glm: glmProvider,
    qwen: qwenProvider,
    "qwen-token-plan": qwenProvider,
    deepseek: deepseekProvider,
    openrouter: openrouterProvider,
    "ark-agent-plan": arkAgentPlanProvider,
};

// Public LLM domain entry point.
// Configuration explicitly selects the Provider; model is used only for capabilities and remote routing.
// Agent/context layers do not depend on concrete endpoint APIs.
export function createLLMCaller(
    source: LLMSourceConnection
): LLMCaller {
    const provider = providers[source.id];

    return options => provider.call(options, source);
}
