import {contentText} from "../../src/images/content.js";
import { createToolRuntime } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";

const toolRuntime = createToolRuntime();

export const getToolSchemas = () => toolRuntime.getToolSchemas();
// Direct-tool tests consume the returned model content immediately. Agent tests
// use their own real ToolRuntime and commit only at the LLM delivery boundary.
export async function executeDeliveredTool(runtime: Pick<typeof toolRuntime, "executeTool">, ...args: Parameters<typeof toolRuntime.executeTool>) {
  const result = await runtime.executeTool(...args);
  args[2].fileState.commitVisible([{role: "tool", tool_call_id: args[3], content: result.modelContent}]);
  return result;
}
export const executeToolResult: typeof toolRuntime.executeTool = (...args) => executeDeliveredTool(toolRuntime, ...args);

let toolCallCounter = 0;

function nextToolCallId(): string {
  toolCallCounter += 1;
  return `test-tool-call-${toolCallCounter}`;
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext
): Promise<string> {
  return contentText((
    await executeToolResult(name, argsJson, ctx, nextToolCallId())
  ).modelContent);
}
