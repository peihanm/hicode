import {stat} from "node:fs/promises";
import {isAbsolute, relative} from "node:path";
import {z} from "zod";
import {createFileDiscovery, createPathMatcher} from "../shared/fileDiscovery.js";
import {createSearchPathFilter} from "../../permissions/filePattern.js";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";

const MAX_RESULTS = 200;

const inputSchema = z.object({
    include_hidden: z.boolean().default(false).describe("Include hidden files/directories; .git is always excluded."),
    include_ignored: z.boolean().default(false).describe("Include files excluded by .gitignore and the default node_modules filter."),
    pattern: z
        .string()
        .trim()
        .min(1)
        .describe("File-path glob, e.g. **/*.ts, src/**/test*.ts or *.md."),
    path: z
        .string()
        .default(".")
        .describe("Search root; defaults to the working directory."),
});

export const globTool: Tool<typeof inputSchema> = {
    name: "glob",
    description: "Find file paths by glob, such as **/*.ts or src/**/*.test.ts. This searches paths, not contents; use grep for content and list_files for one directory. Results are sorted by path and capped at 200; narrow path/pattern when incomplete.",
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({pattern, path, include_hidden, include_ignored}, ctx) {
        if (isAbsolute(pattern)) {
            return {
                content: "pattern must be relative to the search root; put the absolute directory in path.",
                outcome: "failed",
            };
        }

        const searchRoot = resolveToolPath(ctx.cwd, path);
        let rootStat;
        try {
            rootStat = await stat(searchRoot);
        } catch (error) {
            return {
                content: `Search directory does not exist or is inaccessible: ${path}(${error instanceof Error ? error.message : String(error)})`,
                outcome: "failed",
            };
        }
        if (!rootStat.isDirectory()) {
            return {content: `Search path is not a directory: ${path}`, outcome: "failed"};
        }

        const matches: string[] = [];
        let truncated = false;
        const matcher = createPathMatcher(pattern.replaceAll("\\", "/").replace(/^\.\//, ""));
        const discovery = createFileDiscovery({cwd: ctx.cwd, root: searchRoot, signal: ctx.signal,
            canVisit: createSearchPathFilter(ctx.cwd, searchRoot, "glob", ctx.permissionRules),
            includeHidden: include_hidden, includeIgnored: include_ignored, maxEntries: 20_000});
        for await (const absolute of discovery.files) {
            if (!matcher(relative(searchRoot, absolute))) continue;
            if (matches.length >= MAX_RESULTS) { truncated = true; break; }
            matches.push(displayToolPath(ctx.cwd, absolute));
        }
        const stats = discovery.getStats();

        matches.sort((left, right) => left.localeCompare(right));
        if (matches.length === 0 && !stats.truncated) {
            return `No matching files: ${pattern}(search directory: ${displayToolPath(ctx.cwd, searchRoot)})`;
        }

        const lines = [...matches];
        if (truncated) {
            lines.push(
                `(results truncated to ${MAX_RESULTS} ; narrow path or pattern.)`
            );
        }
        if (stats.truncated) lines.push(`(search incomplete: ${stats.issues.join(";")}; found ${stats.candidateFiles} candidate files. Narrow path.)`);
        return lines.join("\n");
    },
};
