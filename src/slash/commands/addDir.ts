import type {DirectoryGrantScope} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

function usage(): string {
    return [
        "用法：",
        "  /add-dir                 查看当前 Session 可写目录",
        "  /add-dir <path>          允许当前 Session 访问目录",
        "  /add-dir --project <path> 为当前项目记住目录",
    ].join("\n");
}

function parseArgs(args: string): {path?: string; scope: DirectoryGrantScope} {
    const trimmed = args.trim();
    if (!trimmed) return {scope: "session"};
    if (trimmed === "--project") {
        throw new Error("--project 后需要目录路径");
    }
    if (trimmed.startsWith("--project ")) {
        return {scope: "project", path: trimmed.slice("--project ".length).trim()};
    }
    if (trimmed.startsWith("-")) throw new Error(`未知参数: ${trimmed}`);
    return {scope: "session", path: trimmed};
}

export const addDirCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "add-dir",
    description: "查看或授权项目外目录",
    argumentHint: "[--project] <path>",
    async execute(args, context) {
        let parsed;
        try {
            parsed = parseArgs(args);
        } catch (error) {
            await context.onEvent({
                type: "assistant_text",
                content: `${error instanceof Error ? error.message : String(error)}\n${usage()}`,
            });
            return;
        }

        if (!parsed.path) {
            const directories = context.ctx.directoryAccess.listDirectories();
            await context.onEvent({
                type: "assistant_text",
                content: [
                    "当前 Session 可写目录：",
                    ...directories.map((directory) => `- ${directory}`),
                    "",
                    "使用 /add-dir <path> 临时增加，或 /add-dir --project <path> 为当前项目记住。",
                ].join("\n"),
            });
            return;
        }

        try {
            const directory = await context.ctx.directoryAccess.grantDirectory(
                parsed.path,
                parsed.scope
            );
            await context.onEvent({
                type: "assistant_text",
                content: parsed.scope === "project"
                    ? `已为当前项目记住目录：${directory}`
                    : `已允许当前 Session 访问目录：${directory}`,
            });
        } catch (error) {
            await context.onEvent({
                type: "assistant_text",
                content: `目录授权失败：${error instanceof Error ? error.message : String(error)}`,
            });
        }
    },
};
