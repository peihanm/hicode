import {formatDiagnosticsSummary} from "../../lsp/diagnostics.js";
import type {ToolContext} from "../types.js";
import {displayToolPath} from "./paths.js";

const POST_WRITE_DIAGNOSTICS_TIMEOUT_MS = 3500;

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
): Promise<T | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function getPostWriteDiagnostics(
    absPath: string,
    content: string,
    ctx: ToolContext
): Promise<string> {
    const manager = ctx.lspManager;
    if (!manager) return "";

    try {
        const diagnostics = await withTimeout(
            manager.syncFileAndGetDiagnostics(
                absPath,
                content,
                1200,
                ctx.signal
            ),
            POST_WRITE_DIAGNOSTICS_TIMEOUT_MS
        );
        if (diagnostics === "timeout") {
            return "\n\nLSP diagnostics unavailable: timed out.";
        }
        if (diagnostics === undefined) return "";
        const displayPath = displayToolPath(ctx.cwd, absPath);
        return `\n\n${formatDiagnosticsSummary(displayPath, diagnostics)}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `\n\nLSP diagnostics unavailable: ${message}`;
    }
}
