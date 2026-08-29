import {createHash} from "node:crypto";
import {appendFile, mkdir} from "node:fs/promises";
import {dirname, join} from "node:path";
import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import type {AgentType, SubagentResult} from "./types.js";

export type SubagentTranscriptEntry =
    | {
    type: "start";
    version: 1;
    timestamp: string;
    parentSessionId: string;
    parentToolCallId: string;
    agentId: string;
    agentType: AgentType;
    agentName?: string;
    description: string;
    model: string;
    cwd: string;
    allowedTools: readonly string[];
}
    | { type: "event"; timestamp: string; event: AgentEvent }
    | {
    type: "snapshot";
    timestamp: string;
    history: Message[];
    result: SubagentResult;
};

function safeKey(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function getSubagentTranscriptPath(
    cwd: string,
    parentSessionId: string,
    agentId: string
): string {
    return join(
        cwd,
        ".pillar",
        "sessions",
        "subagents",
        safeKey(parentSessionId),
        `${safeKey(agentId)}.jsonl`
    );
}

export class SubagentTranscriptWriter {
    readonly path: string;

    constructor(cwd: string, parentSessionId: string, agentId: string) {
        this.path = getSubagentTranscriptPath(cwd, parentSessionId, agentId);
    }

    async append(entry: SubagentTranscriptEntry): Promise<void> {
        await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
        await appendFile(this.path, `${JSON.stringify(entry)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    }
}
