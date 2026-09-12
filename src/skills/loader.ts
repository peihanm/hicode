import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {LoadedSkill, SkillFileSource} from "./types.js";
import {parseFrontmatter} from "./frontmatter.js";
import {loadBundledSkills} from "./bundled.js";
import type {HostSkillContribution} from "../runtime/rootContributions.js";

export function loadSkills({
    storage,
    cwd,
    sources,
    hostSkills = [],
}: {
    storage: PillarStorageLayout;
    cwd: string;
    sources: readonly SkillFileSource[];
    hostSkills?: readonly HostSkillContribution[];
}): LoadedSkill[] {
    const userDir = join(storage.pillarHome, "skills");
    const projectDir = join(cwd, ".pillar", "skills");

    // A missing directory yields an empty list; absent user Skills are not errors.
    const userSkills = sources.includes("user")
        ? loadSkillsFromDir(userDir, "user")
        : [];
    const projectSkills = sources.includes("project")
        ? loadSkillsFromDir(projectDir, "project")
        : [];

    const bundledSkills = loadBundledSkills();

    const contributedSkills: LoadedSkill[] = hostSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? {whenToUse: skill.whenToUse} : {}),
        content: skill.content,
        source: "host",
        id: skill.name,
    }));

    // Merge bundled, user, project, then Host; later sources override names.
    const merged = new Map<string, LoadedSkill>();
    for (const s of [
        ...bundledSkills,
        ...userSkills,
        ...projectSkills,
        ...contributedSkills,
    ]) {
        merged.set(s.name, s);
    }
    return [...merged.values()];
}

function loadSkillsFromDir(
    basePath: string,
    source: "user" | "project"
): LoadedSkill[] {
    if (!existsSync(basePath)) return [];

    let entries;
    try {
        entries = readdirSync(basePath, {withFileTypes: true});
    } catch {
        return [];
    }

    const skills: LoadedSkill[] = [];
    for (const entry of entries) {
        // Only directory-form Skills are supported: <basePath>/<skill-name>/SKILL.md.
        // Standalone .md Skills are unsupported, matching Claude Code.
        if (!entry.isDirectory()) continue;

        const skillDir = join(basePath, entry.name);
        const skillFile = join(skillDir, "SKILL.md");

        let stat;
        try {
            stat = statSync(skillFile);
        } catch {
            continue; // Skip directories without SKILL.md.
        }
        if (!stat.isFile()) continue;

        const raw = readFileSync(skillFile, "utf-8");
        const parsed = parseFrontmatter(raw);
        skills.push({
            name: entry.name,
            description: parsed.description,
            whenToUse: parsed.whenToUse,
            content: parsed.body,
            source,
            filePath: skillFile,
        });
    }
    return skills;
}
