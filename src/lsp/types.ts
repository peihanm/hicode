import type {Diagnostic} from "vscode-languageserver-protocol";
import type {LSPServerInstance} from "./serverInstance.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";
import type {LspConfigSource} from "./config.js";

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
    storage: PillarStorageLayout,
    cwd: string,
    childEnvironment: ChildProcessEnvironment,
    sources?: readonly LspConfigSource[]
) => LspManagerLike | undefined | Promise<LspManagerLike | undefined>;

export type LspPathResolver = Pick<LspManagerLike, "toAbsolute">;
