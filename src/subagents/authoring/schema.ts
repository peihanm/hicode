import {z} from "zod";
import type {OpenAITool} from "../../llm/types.js";

export const generatedAgentDefinitionSchema = z.object({
    name: z.string().trim().min(1).max(64).regex(
        /^[A-Za-z][A-Za-z0-9_-]*$/,
        "Must start with a letter and contain only letters, digits, - and _"
    ),
    description: z.string().trim().min(1).max(500),
    system_prompt: z.string().trim().min(1).max(40_000),
    suggested_tools: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
    model: z.enum(["inherit", "fast"]).default("inherit"),
    max_iterations: z.number().int().min(2).max(30).default(12),
}).strict();

export const submitAgentDefinitionTool: OpenAITool = {
    type: "function",
    function: {
        name: "submit_agent_definition",
        description: "Submit a custom Agent candidate designed with minimal tool permissions.",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: [
                "name",
                "description",
                "system_prompt",
                "suggested_tools",
                "model",
                "max_iterations",
            ],
            properties: {
                name: {type: "string"},
                description: {type: "string"},
                system_prompt: {type: "string"},
                suggested_tools: {
                    type: "array",
                    minItems: 1,
                    maxItems: 32,
                    items: {type: "string"},
                },
                model: {type: "string", enum: ["inherit", "fast"]},
                max_iterations: {type: "integer", minimum: 2, maximum: 30},
            },
        },
    },
};
