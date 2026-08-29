import { createSlashCommandProcessor } from "../../src/slash/process.js";
import { BUILTIN_SUBAGENT_REGISTRY } from "../../src/subagents/registry.js";
import { createToolRuntime } from "../../src/tools/registry.js";

const toolRuntime = createToolRuntime();

export const slashCommandProcessor = createSlashCommandProcessor({
  compactHistory: async ({ preTokenCount }) => ({
    compacted: false,
    preTokenCount,
    threshold: Number.MAX_SAFE_INTEGER,
  }),
  getToolSchemas: toolRuntime.getToolSchemas,
  subagents: BUILTIN_SUBAGENT_REGISTRY,
});

export const processSlashCommand = slashCommandProcessor.process;
