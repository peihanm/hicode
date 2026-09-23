import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {loadSkills} from "../../src/skills/loader.js";
import {getSlashCommandSuggestions} from "../../src/slash/registry.js";
import type {SlashCommandHostContext} from "../../src/slash/types.js";
import {processSlashCommand, slashCommandProcessor} from "../helpers/slash.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/skills", () => {
    test("lists the effective startup snapshot without reading changed files or exposing bodies", async () => {
        await withTempProject(async (cwd, storage) => {
            for (const [directory, description] of [
                [join(storage.hicodeHome, "skills", "review"), "Overridden user description"],
                [join(cwd, ".hicode", "skills", "review"), "Review project code"],
            ] as const) {
                await mkdir(directory, {recursive: true});
                await writeFile(join(directory, "SKILL.md"), `---\ndescription: ${description}\nwhen_to_use: Before a release\n---\nPRIVATE_SKILL_BODY`);
            }
            const skills = loadSkills({cwd, storage, sources: ["user", "project"]}).skills;
            const path = join(cwd, ".hicode", "skills", "review", "SKILL.md");
            await writeFile(path, "Changed on disk after startup");
            const messages: string[] = [];
            const context: SlashCommandHostContext = {
                ctx: {...createTestContext(cwd), skills},
                history: [{role: "user", origin: "user", content: "Existing task"}],
                onEvent: event => {
                    if (event.type === "assistant_text") messages.push(event.content);
                },
            };
            expect(await processSlashCommand("/skills", context)).toBe(true);
            expect(messages).toHaveLength(1);
            expect(messages[0]).toContain("Skills · 2 loaded");
            expect(messages[0]).toContain("hicode-guide · Built-in");
            expect(messages[0]).toContain("review · Project");
            expect(messages[0]).toContain("Review project code");
            expect(messages[0]).toContain("When to use: Before a release");
            expect(messages[0]).toContain(`Path: ${path}`);
            expect(messages[0]).not.toContain("Overridden user description");
            expect(messages[0]).not.toContain("Changed on disk");
            expect(messages[0]).not.toContain("PRIVATE_SKILL_BODY");
            expect(context.history).toEqual([{role: "user", origin: "user", content: "Existing task"}]);
        });
    });

    test("represents every source, including inline Host Skills without a file path", async () => {
        await withTempProject(async cwd => {
            const ctx = createTestContext(cwd);
            ctx.skills = [
                {name: "personal", description: "Personal workflow", content: "body", source: "user", filePath: join(cwd, "user-skill.md")},
                {name: "bundled", description: "", content: "body", source: "bundled", filePath: join(cwd, "bundled.md")},
                {name: "host-inline", description: "Host workflow", content: "body", source: "host", id: "host-inline"},
            ];
            let text = "";
            await processSlashCommand("/skills", {ctx, history: [], onEvent: event => {
                if (event.type === "assistant_text") text = event.content;
            }});
            expect(text).toContain("Skills · 3 loaded");
            expect(text).toContain("personal · User");
            expect(text).toContain("bundled · Built-in");
            expect(text).toContain("No description provided.");
            expect(text).toContain("host-inline · Host");
            expect(text).toContain("Host ID: host-inline (inline; no local file)");
            expect(text).not.toContain("undefined");
        });
    });

    test("empty state uses the current project and injected storage; arguments return usage", async () => {
        await withTempProject(async cwd => {
            const ctx = createTestContext(cwd);
            const messages: string[] = [];
            const context: SlashCommandHostContext = {ctx, history: [], onEvent: event => {
                if (event.type === "assistant_text") messages.push(event.content);
            }};
            await processSlashCommand("/skills", context);
            expect(messages[0]).toContain("No Skills loaded.");
            expect(messages[0]).toContain(join(cwd, ".hicode", "skills"));
            expect(messages[0]).toContain(join(ctx.storage.hicodeHome, "skills"));
            await processSlashCommand("/skills reload", context);
            expect(messages[1]).toBe("Usage: /skills");
            await processSlashCommand("/help", context);
            expect(messages[2]).toContain("/skills - List loaded Skills");
        });
    });

    test("is discoverable and runs immediately during an active task", () => {
        expect(getSlashCommandSuggestions("/ski").map(command => command.name)).toEqual(["skills"]);
        expect(slashCommandProcessor.getBusyBehavior("/skills")).toBe("immediate");
    });
});
