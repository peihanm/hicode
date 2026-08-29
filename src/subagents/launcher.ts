import type {Message} from "../llm/types.js";
import type {AgentTaskSnapshot} from "../tasks/index.js";
import type {ToolContext} from "../tools/types.js";
import {buildForkContextSnapshot} from "./fork.js";
import type {ForkSubagentRequest, RegisteredSubagentRequest, SubagentResult, SubagentRunner,} from "./types.js";
import type {SubagentModelOverride} from "./model.js";

type SubagentLaunchInput =
    | {
    kind: "registered";
    agentType: string;
    description: string;
    prompt: string;
    parentToolCallId: string;
    model?: SubagentModelOverride;
    runInBackground: boolean;
    isolation?: "worktree";
}
    | {
    kind: "fork";
    name: string;
    description: string;
    prompt: string;
    parentToolCallId: string;
    runInBackground: true;
    isolation?: "worktree";
};

type SubagentLaunchResult =
    | {kind: "foreground"; result: SubagentResult}
    | {kind: "background"; task: AgentTaskSnapshot};

export interface SubagentLauncher {
    launch(input: SubagentLaunchInput): Promise<SubagentLaunchResult>;
}

export function createSubagentLauncher({
    parentContext,
    getHistory,
    runSubagent,
}: {
    parentContext: ToolContext;
    getHistory(): readonly Message[];
    runSubagent: SubagentRunner;
}): SubagentLauncher {
    return {
        async launch(input) {
            let request: RegisteredSubagentRequest | ForkSubagentRequest;
            if (input.kind === "fork") {
                request = {
                    kind: "fork",
                    agentType: "fork",
                    name: input.name,
                    description: input.description,
                    prompt: input.prompt,
                    parentToolCallId: input.parentToolCallId,
                    isolation: input.isolation,
                    contextSnapshot: buildForkContextSnapshot(
                        getHistory(),
                        input.parentToolCallId
                    ),
                };
            } else {
                request = {
                    kind: "registered",
                    agentType: input.agentType,
                    description: input.description,
                    prompt: input.prompt,
                    parentToolCallId: input.parentToolCallId,
                    ...(input.model ? {model: input.model} : {}),
                };
            }

            if (input.runInBackground) {
                if (!parentContext.tasks) {
                    throw new Error("当前运行入口不支持后台 Agent Task");
                }
                const task = await parentContext.tasks.startAgent({
                    request,
                    parentContext,
                    ...(input.isolation ? {isolation: input.isolation} : {}),
                });
                return {kind: "background", task};
            }
            if (request.kind === "fork") {
                throw new Error("Fork Agent 必须后台运行");
            }
            return {kind: "foreground", result: await runSubagent(request)};
        },
    };
}
