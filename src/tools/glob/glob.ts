import {stat} from "node:fs/promises";
import {isAbsolute, relative} from "node:path";
import {z} from "zod";
import {createFileDiscovery, createPathMatcher} from "../shared/fileDiscovery.js";
import {createSearchPathFilter} from "../../permissions/filePattern.js";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";

const MAX_RESULTS = 200;

const inputSchema = z.object({
    include_hidden: z.boolean().default(false).describe("包含隐藏文件与目录；.git 始终排除"),
    include_ignored: z.boolean().default(false).describe("包含 .gitignore 与默认 node_modules 排除的文件"),
    pattern: z
        .string()
        .trim()
        .min(1)
        .describe("文件路径 glob，例如 **/*.ts、src/**/test*.ts 或 *.md"),
    path: z
        .string()
        .default(".")
        .describe("搜索根目录，默认当前工作目录"),
});

export const globTool: Tool<typeof inputSchema> = {
    name: "glob",
    description: [
        "按文件名或路径 glob 快速查找文件，例如 **/*.ts、src/**/*.test.ts、*.md。",
        "只查路径，不搜索文件内容；内容搜索使用 grep，单层目录浏览使用 list_files。",
        `结果按路径排序，最多返回 ${MAX_RESULTS} 个；结果过多时缩小 path 或 pattern。`,
    ].join("\n"),
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({pattern, path, include_hidden, include_ignored}, ctx) {
        if (isAbsolute(pattern)) {
            return {
                content: "pattern 必须是相对于搜索根目录的 glob；绝对目录请放在 path 参数中。",
                outcome: "failed",
            };
        }

        const searchRoot = resolveToolPath(ctx.cwd, path);
        let rootStat;
        try {
            rootStat = await stat(searchRoot);
        } catch (error) {
            return {
                content: `搜索目录不存在或无法访问: ${path}（${error instanceof Error ? error.message : String(error)}）`,
                outcome: "failed",
            };
        }
        if (!rootStat.isDirectory()) {
            return {content: `搜索路径不是目录: ${path}`, outcome: "failed"};
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
            return `未找到匹配文件: ${pattern}（搜索目录: ${displayToolPath(ctx.cwd, searchRoot)}）`;
        }

        const lines = [...matches];
        if (truncated) {
            lines.push(
                `（结果已截断为 ${MAX_RESULTS} 个，请缩小 path 或 pattern。）`
            );
        }
        if (stats.truncated) lines.push(`（搜索未完成：${stats.issues.join("；")}；已发现 ${stats.candidateFiles} 个候选文件。请缩小 path。）`);
        return lines.join("\n");
    },
};
