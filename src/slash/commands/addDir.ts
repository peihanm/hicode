import type {DirectoryGrantScope} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

function usage(): string {
    return [
        "Usage:",
        "  /add-dir                  List writable directories in this Session",
        "  /add-dir <path>           Grant directory access for this Session",
        "  /add-dir --project <path> Remember a directory grant for this project",
    ].join("\n");
}

function parseArgs(args: string): {path?: string; scope: DirectoryGrantScope} {
    const trimmed = args.trim();
    if (!trimmed) return {scope: "session"};
    if (trimmed === "--project") {
        throw new Error("--project requires a directory path");
    }
    if (trimmed.startsWith("--project ")) {
        return {scope: "project", path: trimmed.slice("--project ".length).trim()};
    }
    if (trimmed.startsWith("-")) throw new Error(`Unknown argument: ${trimmed}`);
    return {scope: "session", path: trimmed};
}

export const addDirCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "add-dir",
    description: "View or authorize directories outside the project",
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
                    "Writable directories in this Session:",
                    ...directories.map((directory) => `- ${directory}`),
                    "",
                    "Use /add-dir <path> for temporary access, or /add-dir --project <path> to remember it for this project.",
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
                    ? `Directory grant saved for this project: ${directory}`
                    : `Directory access granted for this Session: ${directory}`,
            });
        } catch (error) {
            await context.onEvent({
                type: "assistant_text",
                content: `Directory authorization failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    },
};
