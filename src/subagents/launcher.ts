import type {Message} from "../llm/types.js";
import type {AgentTaskSnapshot} from "../tasks/index.js";
import type {ToolContext} from "../tools/types.js";
import {buildForkContextSnapshot} from "./fork.js";
import type {SubagentRequest, SubagentResult, SubagentRunner,} from "./types.js";

import {resolveSubagentDirectory} from "./workspace.js";

type SubagentLaunchInput = Omit<SubagentRequest, "contextSnapshot"> & {
    context: "fresh" | "inherit";
    runInBackground: boolean;
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
            const {context, runInBackground: _background, ...assignment} = input;
            const request: SubagentRequest = {
                ...assignment, cwd,
                ...(context === "inherit" ? {
                    contextSnapshot: buildForkContextSnapshot(getHistory(), input.parentToolCallId),
                } : {}),
            };

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
            return {kind: "foreground", result: await runSubagent(request)};
        },
    };
}
