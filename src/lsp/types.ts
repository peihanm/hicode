import type {Diagnostic} from "vscode-languageserver-protocol";
import type {LSPServerInstance} from "./serverInstance.js";

export interface LspManagerLike {
    getServerForFile(filePath: string): LSPServerInstance | undefined;

    openFile(filePath: string, signal?: AbortSignal): Promise<void>;

    waitForDiagnostics(
        filePath: string,
        timeoutMs?: number,
        afterUpdatedAt?: number,
        signal?: AbortSignal
    ): Promise<Diagnostic[] | undefined>;

    syncFileAndGetDiagnostics(
        filePath: string,
        content: string,
        timeoutMs?: number,
        signal?: AbortSignal
    ): Promise<Diagnostic[] | undefined>;

    listServers(): Array<{
        name: string;
        state: string;
        extensions: string[];
    }>;

    toAbsolute(filePath: string): string;

    shutdown(): Promise<void>;
}

export type CreateLspManager = (
    cwd: string
) => LspManagerLike | undefined;

export type LspPathResolver = Pick<LspManagerLike, "toAbsolute">;
