import type {Message} from "../../src/llm/types.js";
import {createSubagentLauncher} from "../../src/subagents/launcher.js";
import type {SubagentRunner} from "../../src/subagents/types.js";
import type {ToolContext} from "../../src/tools/types.js";

export function attachSubagentLauncher(
    context: ToolContext,
    runSubagent: SubagentRunner,
    getHistory: () => readonly Message[] = () => []
): void {
    context.subagentLauncher = createSubagentLauncher({
        parentContext: context,
        getHistory,
        runSubagent,
    });
}
