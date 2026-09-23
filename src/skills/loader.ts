import {lstatSync, opendirSync} from "node:fs";
import {dirname, join} from "node:path";
import {readBoundedTextFile} from "../persistence/readTextFile.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import type {LoadedSkill, SkillFileSource, SkillLoadIssue} from "./types.js";
import {parseFrontmatter} from "./frontmatter.js";
import {loadBundledSkills} from "./bundled.js";
import type {HostSkillContribution} from "../runtime/rootContributions.js";

export function loadSkills({storage, cwd, sources, hostSkills = []}: {
    storage: HiCodeStorageLayout;
    cwd: string;
    sources: readonly SkillFileSource[];
    hostSkills?: readonly HostSkillContribution[];
}): {skills: LoadedSkill[]; issues: SkillLoadIssue[]} {
    const issues: SkillLoadIssue[] = [];
    const merged = new Map<string, LoadedSkill>();
    for (const skill of loadBundledSkills()) merged.set(skill.name, skill);
    for (const source of ["user", "project"] as const) {
        if (!sources.includes(source)) continue;
        const base = source === "user" ? join(storage.hicodeHome, "skills") : join(cwd, ".hicode", "skills");
        for (const skill of loadDirectory(base, source, issues)) merged.set(skill.name, skill);
    }
    for (const skill of hostSkills) merged.set(skill.name, {...skill, source: "host", id: skill.name});
    const skills: LoadedSkill[] = [];
    let listingCharacters = 0;
    for (const skill of merged.values()) {
        const length = skill.name.length + skill.description.length + (skill.whenToUse?.length ?? 0) + 10;
        if (skills.length >= 100 || listingCharacters + length > 16_000) {
            issues.push({path: skill.source === "host" ? `host:${skill.id}` : skill.filePath, message: "Skill catalog exceeds 100 entries or 16000 characters; Skill was not loaded"});
            continue;
        }
        listingCharacters += length;
        skills.push(skill);
    }
    return {skills, issues};
}

function loadDirectory(base: string, source: SkillFileSource, issues: SkillLoadIssue[]): LoadedSkill[] {
    const names: string[] = [];
    try {
        const parent = lstatSync(dirname(base));
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Skill configuration root must be a regular directory");
        const stat = lstatSync(base);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill root must be a regular directory");
        const directory = opendirSync(base);
        try {
            let count = 0;
            for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
                if (++count > 256) throw new Error("Skill directory exceeds 256 entries");
                if (entry.isSymbolicLink()) issues.push({path: join(base, entry.name), message: "Symbolic Skill directories are not loaded"});
                else if (entry.isDirectory()) names.push(entry.name);
            }
        } finally {directory.closeSync();}
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            issues.push({path: base, message: error instanceof Error ? error.message : "Cannot enumerate Skills"});
        }
        return [];
    }
    const skills: LoadedSkill[] = [];
    for (const name of names.sort()) {
        const path = join(base, name, "SKILL.md");
        try {
            if (name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Skill name exceeds 64 characters or contains controls");
            const directory = lstatSync(join(base, name));
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Skill directory changed or is a symlink");
            const parsed = parseFrontmatter(readBoundedTextFile(path, 64 * 1024));
            if (parsed.description.length > 500 || (parsed.whenToUse?.length ?? 0) > 500) throw new Error("Skill description/when_to_use exceeds 500 characters");
            skills.push({name, description: parsed.description, whenToUse: parsed.whenToUse, content: parsed.body, source, filePath: path});
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            issues.push({path, message: error instanceof Error ? error.message : "Cannot load Skill"});
        }
    }
    return skills;
}
