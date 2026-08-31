import {beginPromptLog} from "../../promptLog.js";
import type {LLMProvider, PromptLogResponse} from "../../types.js";
import type {CodexAppServerRuntimeLike} from "./appServer.js";

export function createCodexProvider(
    runtime: CodexAppServerRuntimeLike
): LLMProvider {
    return {
        name: "codex",
        supports(model) {
            return model.toLowerCase().startsWith("gpt-");
        },
        async call(options) {
            const request = {
                transport: "codex-app-server",
                ephemeral: true,
                sandbox: "restricted-read-only",
                reasoningEffort: "high",
                messages: options.messages,
                tools: options.tools,
            };
            const log = beginPromptLog(
                options.storage,
                options.cwd,
                options.kind,
                options.model,
                request,
                []
            );
            try {
                const result = await runtime.call(options);
                const response: PromptLogResponse = {
                    usage: result.usage,
                    rawMessage: result.message,
                    rawResponse: {
                        transport: "codex-app-server",
                        toolCalls: result.toolCalls.length,
                    },
                };
                log.finish(response);
                return result;
            } catch (error) {
                log.finish({
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        },
    };
}
