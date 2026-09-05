import type {ToolContext} from "../tools/types.js";

/** Session-owned grants; never added to the process-global proxy allowlist. */
export class NetworkAccessSession {
    private readonly grants = new Set<string>();

    allows(host: string, port: number): boolean {
        return this.grants.has(`${host}:${port}`);
    }

    grant(host: string, port: number): void {
        this.grants.add(`${host}:${port}`);
    }
}

export interface NetworkAccessExecution {
    session: NetworkAccessSession;
    canUseTool: ToolContext["canUseTool"];
    canPrompt(): boolean;
}
