import type {Message} from "../llm/types.js";
import type {AgentTaskSnapshot} from "../tasks/index.js";
import type {ToolContext} from "../tools/types.js";
import {buildForkContextSnapshot} from "./fork.js";
import type {ForkSubagentRequest, RegisteredSubagentRequest, SubagentResult, SubagentRunner,} from "./types.js";
import type {SubagentModelOverride} from "./model.js";

import {resolveSubagentDirectory} from "./workspace.js";

type SubagentLaunchInput =
    | {
    kind: "registered";
    workspaceWriteApproved?: true;
    agentType: string;
    description: string;
    prompt: string;
    parentToolCallId: string;
    model?: SubagentModelOverride;
    runInBackground: boolean;
    cwd?: string;
    readOnly?: boolean;
}
    | {
    kind: "fork";
    workspaceWriteApproved?: true;
    name: string;
    description: string;
    prompt: string;
    parentToolCallId: string;
    runInBackground: true;
    cwd?: string;
    readOnly?: boolean;
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
            const cwd = await resolveSubagentDirectory(parentContext, input.cwd);
            let request: RegisteredSubagentRequest | ForkSubagentRequest;
            if (input.kind === "fork") {
                request = {
                    kind: "fork",
                    agentType: "fork",
                    name: input.name,
                    description: input.description,
                    prompt: input.prompt,
                    parentToolCallId: input.parentToolCallId,
                    cwd, readOnly: input.readOnly,
                    ...(input.workspaceWriteApproved ? {workspaceWriteApproved: true} : {}),
                    contextSnapshot: buildForkContextSnapshot(
                        getHistory(),
                        input.parentToolCallId
                    ),
                };
            } else {
                request = {
                    kind: "registered",
                    cwd, readOnly: input.readOnly,
                    ...(input.workspaceWriteApproved ? {workspaceWriteApproved: true} : {}),
                    agentType: input.agentType,
                    description: input.description,
                    prompt: input.prompt,
                    parentToolCallId: input.parentToolCallId,
                    ...(input.model ? {model: input.model} : {}),
                };
            }

            if (input.runInBackground) {
                if (!parentContext.tasks) {
                    throw new Error("This entry point does not support background Agent Tasks");
                }
                const task = await parentContext.tasks.startAgent({
                    request,
                    parentContext,
                });
                return {kind: "background", task};
            }
            if (request.kind === "fork") {
                throw new Error("Fork Agents must run in the background");
            }
            return {kind: "foreground", result: await runSubagent(request)};
        },
    };
}
