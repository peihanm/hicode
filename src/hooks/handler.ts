import type {HookExecution} from "./types.js";
import type {HookJSONOutput} from "./schema.js";

const MAX_HOOK_MESSAGE_LENGTH = 2_000;

export interface HookHandlerResult {
    execution: HookExecution;
    output?: HookJSONOutput;
    interrupted?: boolean;
}

export function boundedHookMessage(message: string): string {
    return message.length <= MAX_HOOK_MESSAGE_LENGTH
        ? message
        : `${message.slice(0, MAX_HOOK_MESSAGE_LENGTH - 1)}…`;
}
