import {z} from "zod";
import {readdir} from "node:fs/promises";
import type {Tool} from "../types.js";
import {resolveToolPath} from "../shared/paths.js";
import {createSearchPathFilter} from "../../permissions/filePattern.js";
import {join} from "node:path";

export const listFilesTool: Tool<
    z.ZodObject<{ dir: z.ZodDefault<z.ZodString> }>
> = {
    name: "list_files",
    description: "List files and subdirectories directly inside a directory. Use glob for recursive path matching and grep for file contents.",
    parameters: z.object({
        dir: z.string().describe("Directory path; defaults to the working directory.").default("."),
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async ({dir}, ctx) => {
        const absDir = resolveToolPath(ctx.cwd, dir);
        const found = await readdir(absDir, {withFileTypes: true});
        const canVisit = createSearchPathFilter(ctx.cwd, absDir, "list_files", ctx.permissionRules);
        const entries = [];
        for (const entry of found) if (await canVisit(join(absDir, entry.name))) entries.push(entry);
        const omitted = found.length - entries.length;
        const suffix = omitted ? "\n(Some entries are hidden by deny/ask rules; invoke paths requiring approval separately.)" : "";
        if (entries.length === 0) return omitted ? suffix.trim() : `Directory ${dir} is empty`;
        return entries
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) {
                    return a.isDirectory() ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            })
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join("\n") + suffix;
    },
};
