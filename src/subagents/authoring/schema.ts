import {zodToJsonSchema} from "zod-to-json-schema";
import {agentNameSchema, agentDescriptionSchema, agentPromptSchema} from "../definitionSchema.js";
import {z} from "zod";
import type {OpenAITool} from "../../llm/types.js";

export const generatedAgentDefinitionSchema = z.object({
    name: agentNameSchema,
    description: agentDescriptionSchema,
    system_prompt: agentPromptSchema,
    read_only: z.boolean(),
}).strict();

export const submitAgentDefinitionTool: OpenAITool = {
    type: "function",
    function: {
        name: "submit_agent_definition",
        description: "Submit a custom Agent responsibility and whether it must be read-only. Tools inherit from the parent and the model follows the main agent.",
        parameters: zodToJsonSchema(generatedAgentDefinitionSchema, {target: "jsonSchema7", $refStrategy: "none"}),
    },
};
