import {z} from "zod";
import {dirname} from "node:path";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

const inputSchema = z.object({
    skill: z
        .string()
        .describe("Name from the available Skill list; do not invent names."),
    args: z
        .string()
        .optional()
        .describe("Optional arguments replacing $ARGUMENTS in the Skill content."),
});

type Input = z.infer<typeof inputSchema>;

export const skillTool: Tool<typeof inputSchema> = {
    name: "skill",
    description: "Read guidance for a Skill in the current available list. Invoke a listed Skill when explicitly requested, otherwise use it only when its description fits the task. Do not guess names or retry missing Skills. A Skill does not grant tools or expand permissions. Follow its resource paths and applicable instructions; user instructions take precedence.",
    parameters: inputSchema,

    isReadOnly: () => true,

    async checkPermissions(): Promise<PermissionResult> {
        // Loading guidance has no external side effects; allow directly.
        return {behavior: "allow"};
    },

    async execute({skill, args}: Input, ctx: ToolContext) {
        const found = ctx.skills.find((s) => s.name === skill);
        if (!found) {
            const available = ctx.skills.map((s) => s.name).join(", ");
            return {content: `Skill "${skill}\" was not found. Available skills: ${available || "(none)"}`, outcome: "failed"};
        }

        // Always substitute $ARGUMENTS.
        // Use args when provided, otherwise an empty string so placeholders are not shown to the user.
        const argsValue = args ?? "";
        const resources = found.source === "host"
            ? "This Skill has no local resource directory. Use only absolute paths or resource identifiers explicitly provided in its content; do not infer a directory from its name."
            : [JSON.stringify({resourceRoot: dirname(found.filePath)}),
                "Resolve Skill-relative scripts/references/assets against resourceRoot; project paths remain relative to the working directory. Use absolute paths and quote shell paths containing spaces."].join("\n");
        return ["<skill-source>", resources,
            "Loading a Skill does not expand file or command permissions.", "</skill-source>", "",
            found.content.replace(/\$ARGUMENTS/g, () => argsValue)].join("\n");
    },
};
