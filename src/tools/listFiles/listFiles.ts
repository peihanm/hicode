import {z} from "zod";
import {readdir} from "node:fs/promises";
import type {Tool} from "../types.js";
import {resolveToolPath} from "../shared/paths.js";

export const listFilesTool: Tool<
    z.ZodObject<{ dir: z.ZodDefault<z.ZodString> }>
> = {
    name: "list_files",
    description: "列出指定目录下的文件和子目录",
    parameters: z.object({
        dir: z.string().describe("目录路径，默认为当前目录").default("."),
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async ({dir}, ctx) => {
        const absDir = resolveToolPath(ctx.cwd, dir);
        const entries = await readdir(absDir, {withFileTypes: true});
        if (entries.length === 0) return `目录 ${dir} 为空`;
        return entries
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) {
                    return a.isDirectory() ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            })
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join("\n");
    },
};
