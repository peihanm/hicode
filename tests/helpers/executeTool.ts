import { createToolRuntime } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";

const toolRuntime = createToolRuntime();

export const getToolSchemas = () => toolRuntime.getToolSchemas();
export const executeToolResult: typeof toolRuntime.executeTool = (...args) =>
  toolRuntime.executeTool(...args);

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
  return (
    await executeToolResult(name, argsJson, ctx, nextToolCallId())
  ).modelContent;
}
