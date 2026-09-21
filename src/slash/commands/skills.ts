import {join} from "node:path";
import type {SlashCommand} from "../types.js";

export const skillsCommand: SlashCommand = {
    busyBehavior: "immediate",
    name: "skills",
    description: "List loaded Skills with descriptions, sources and paths",
    async execute(args, {ctx, onEvent, openSkills}) {
        if (args) {
            await onEvent({type: "assistant_text", content: "Usage: /skills"});
            return;
        }
        if (openSkills) {
            openSkills();
            return;
        }

        const sources = {project: "Project", user: "User", bundled: "Built-in", host: "Host"};
        const entries = ctx.skills.map(skill => [
            `${skill.name} · ${sources[skill.source]}`,
            skill.description.trim() || "No description provided.",
            ...(skill.whenToUse ? [`When to use: ${skill.whenToUse}`] : []),
            skill.source === "host" ? `Host ID: ${skill.id} (inline; no local file)` : `Path: ${skill.filePath}`,
        ].join("\n"));

        await onEvent({
            type: "assistant_text",
            content: [
                entries.length ? `Skills · ${entries.length} loaded` : "No Skills loaded.",
                ...(entries.length ? entries : [
                    "Install a Skill as <name>/SKILL.md in:",
                    `Project: ${join(ctx.cwd, ".hicode", "skills")}`,
                    `User: ${join(ctx.storage.hicodeHome, "skills")}`,
                ]),
                "Skills are loaded at startup. Restart HiCode after changing Skill files.",
            ].join("\n\n"),
        });
    },
};
