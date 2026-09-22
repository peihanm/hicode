import {expect, test} from "bun:test";
import {readFile, readdir} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {loadBundledSkills, isBundledSkillFile} from "../../src/skills/bundled.js";
import {hicodeHostSettingsSchema} from "../../src/settings/schema.js";
import {hostMcpServerContributionSchema} from "../../src/mcp/config.js";
import {parseCustomAgentDocument} from "../../src/subagents/load.js";
import {getSlashCommands} from "../../src/slash/registry.js";

test("bundled guide links, resource allowlist and documented configuration examples stay usable", async () => {
    const skills = loadBundledSkills();
    const guide = skills.find(skill => skill.name === "hicode-guide");
    if (!guide || guide.source !== "bundled") throw new Error("Missing product guide");
    const root = dirname(guide.filePath);
    const references = (await readdir(join(root, "references"))).map(name => join(root, "references", name));
    let examples = 0;
    for (const path of [guide.filePath, ...references]) {
        expect(await isBundledSkillFile(skills, path)).toBe(true);
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
            const target = resolve(dirname(path), match[1]!);
            expect(await isBundledSkillFile(skills, target)).toBe(true);
            expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
        }
        for (const match of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
            const example: unknown = JSON.parse(match[1]!);
            if (example && typeof example === "object" && "mcpServers" in example) {
                const servers = example.mcpServers;
                if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Invalid MCP example");
                const entries: [string, unknown][] = Object.entries(servers);
                for (const [name, server] of entries) {
                    if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("Invalid MCP server example");
                    hostMcpServerContributionSchema.parse({name, ...server});
                }
            } else hicodeHostSettingsSchema.parse(example);
            examples++;
        }
        if (path.endsWith("subagents.md")) {
            const raw = /```markdown\n([\s\S]*?)\n```/.exec(text)?.[1];
            if (!raw) throw new Error("Missing Agent example");
            const parsed = parseCustomAgentDocument({source: "project", path: "/project/.hicode/agents/board-reviewer.md", raw});
            expect(parsed.issues).toEqual([]);
            expect(parsed.definition?.readOnly).toBe(true);
        }
    }
    expect(examples).toBeGreaterThanOrEqual(6);
    const commands = await readFile(join(root, "references", "commands.md"), "utf8");
    for (const command of getSlashCommands()) expect(commands).toContain(`\x60/${command.name}`);
    expect(await isBundledSkillFile([], guide.filePath)).toBe(false);
    expect(await isBundledSkillFile(skills, join(root, "references"))).toBe(false);
});
