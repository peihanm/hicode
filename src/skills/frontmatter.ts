// Minimal parser for single-line name and description fields, not general YAML.
interface ParsedFrontmatter {
    name?: string;
    description: string;
    body: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
    const opening = /^---\r?\n/.exec(raw);
    if (!opening) throw new Error("Skill requires frontmatter with a description");
    const closing = /\r?\n---(?:\r?\n|$)/g;
    closing.lastIndex = opening[0].length;
    const end = closing.exec(raw);
    if (!end) throw new Error("Skill frontmatter must have a closing --- line");
    let name: string | undefined;
    let description = "";
    const seen = new Set<string>();
    for (const line of raw.slice(opening[0].length, end.index).split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        if (key !== "name" && key !== "description") continue;
        if (seen.has(key)) throw new Error(`Duplicate Skill field: ${key}`);
        seen.add(key);
        const value = line.slice(colon + 1).trim();
        if (key === "name") name = value;
        else description = value;
    }
    if (name !== undefined && (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)))
        throw new Error("Skill name must contain 1–64 characters without controls");
    if (!description || description.length > 500)
        throw new Error("Skill description must contain 1–500 characters");
    return {name, description, body: raw.slice(end.index + end[0].length)};
}
