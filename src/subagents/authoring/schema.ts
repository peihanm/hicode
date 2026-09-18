import {z} from "zod";
import type {OpenAITool} from "../../llm/types.js";

export const generatedAgentDefinitionSchema = z.object({
    name: z.string().trim().min(1).max(64).regex(
        /^[A-Za-z][A-Za-z0-9_-]*$/,
        "Must start with a letter and contain only letters, digits, - and _"
    ),
    description: z.string().trim().min(1).max(500),
    system_prompt: z.string().trim().min(1).max(40_000),
    read_only: z.boolean(),
}).strict();

export const submitAgentDefinitionTool: OpenAITool = {
    type: "function",
    function: {
        name: "submit_agent_definition",
        description: "Submit a custom Agent responsibility and whether it must be read-only. Tools inherit from the parent and the model follows the main agent.",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: [
                "name",
                "description",
                "system_prompt",
                "read_only",
            ],
            properties: {
                name: {type: "string"},
                description: {type: "string"},
                system_prompt: {type: "string"},
                read_only: {type: "boolean"},
            },
        },
    },
};
