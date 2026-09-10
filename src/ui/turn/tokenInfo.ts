import {DEFAULT_CONTEXT_SETTINGS, type ContextSettings} from "../../context/config.js";
import {getTokenWarningState, tokenCountWithEstimation,} from "../../context/index.js";
import {getUserContextBlocks} from "../../prompt/attachments.js";
import {buildInvokeMessages} from "../../prompt/invokeMessages.js";
import type {LoadedSkill} from "../../skills/types.js";
import type {ProjectInstructions} from "../../prompt/instructions.js";
import type {Message, OpenAITool} from "../../llm/types.js";
import type {UITokenInfo} from "./eventStore.js";

export function estimateRestoredTokenInfo(
    history: Message[],
    skills: LoadedSkill[],
    instructions: ProjectInstructions,
    tools: OpenAITool[],
    model: string,
    contextSettings: ContextSettings = DEFAULT_CONTEXT_SETTINGS
): UITokenInfo {
    const invokeMessages = buildInvokeMessages(
        history,
        getUserContextBlocks(skills, instructions)
    );
    const count = tokenCountWithEstimation(invokeMessages, tools);
    const state = getTokenWarningState(count, model, undefined, contextSettings);

    return {
        count,
        percentUsed: state.percentUsed,
        warning: state.warning,
        status: "estimated",
    };
}
