import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {dirname} from "node:path";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile, writeFileAtomically, type HiCodeStorageLayout} from "../persistence/index.js";
import {getSubagentRecordPaths} from "../persistence/layout.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import type {AgentType, SubagentResult} from "./types.js";

const MAX_TRANSCRIPT_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

type SubagentTranscriptEntry =
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
    | {type: "event"; timestamp: string; event: AgentEvent}
    | {type: "snapshot"; timestamp: string; history: Message[]; result: SubagentResult};

type SubagentTranscriptStart = Omit<Extract<SubagentTranscriptEntry, {type: "start"}>,
    "type" | "version" | "timestamp" | "parentSessionId" | "agentId">;
type SubagentReport = Omit<SubagentResult, "transcriptPath" | "transcriptIssue">;

/** Owns transcript lifecycle; failed records never invalidate a generated task report. */
export class SubagentTranscript {
    private state: "new" | "recording" | "failed" = "new";
    private issue: string | undefined;
    private pending: Promise<void> = Promise.resolve();
    private previous: string[] = [];
    private readonly path: string;
    private readonly statePath: string;
    private readonly conversationPath: string;

    constructor(
        private readonly storage: HiCodeStorageLayout,
        cwd: string,
        private readonly parentSessionId: string,
        private readonly agentId: string
    ) {
        const paths = getSubagentRecordPaths(storage, cwd, parentSessionId, agentId);
        this.path = paths.events;
        this.statePath = paths.state;
        this.conversationPath = paths.conversation;
    }

    async start(input: SubagentTranscriptStart): Promise<void> {
        if (this.state !== "new") return;
        await this.append({type: "start", version: 1, timestamp: new Date().toISOString(),
            parentSessionId: this.parentSessionId, agentId: this.agentId, ...input});
    }

    noteIssue(message: string): void {this.issue = message;}

    async recordEvent(event: AgentEvent): Promise<void> {
        if (this.state !== "recording" || event.type === "assistant_draft" || event.type === "assistant_draft_end" ||
            event.type === "model_stream_start" || event.type === "model_stream_progress" || event.type === "model_stream_end") return;
        await this.append({type: "event", timestamp: new Date().toISOString(), event});
    }

    async finish(history: Message[], report: SubagentReport): Promise<SubagentResult> {
        if (this.state === "recording") {
            await this.append({type: "snapshot", timestamp: new Date().toISOString(), history,
                result: {...report, ...this.recordInfo()}});
        }
        return {...report, ...this.recordInfo()};
    }

    private recordInfo(): Pick<SubagentResult, "transcriptPath" | "transcriptIssue"> {
        return {
            ...(this.state === "recording" ? {transcriptPath: this.path} : {}),
            ...(this.issue ? {transcriptIssue: this.issue} : {}),
        };
    }

    private append(entry: SubagentTranscriptEntry): Promise<void> {
        const operation = this.pending.then(async () => {
            if (this.state === "failed" || (entry.type === "start" && this.state !== "new")) return;
            try {
                await this.appendOne(entry);
                this.state = "recording";
            } catch {
                this.state = "failed";
                this.noteIssue("Subagent transcript is incomplete or unavailable; task execution continues.");
            }
        });
        this.pending = operation;
        return operation;
    }

    private async appendOne(entry: SubagentTranscriptEntry): Promise<void> {
        ensurePrivateStorageDirectory(this.storage, dirname(this.path));
        let value: unknown = entry;
        let next: string[] | undefined;
        let state: string | undefined;
        if (entry.type === "snapshot") {
            if (entry.result.agentId !== this.agentId) throw new Error("Subagent result owner mismatch");
            next = entry.history.map(message => JSON.stringify(message));
            let retained = 0;
            while (retained < Math.min(next.length, this.previous.length) && next[retained] === this.previous[retained]) retained++;
            state = JSON.stringify({version: 2, timestamp: entry.timestamp, parentSessionId: this.parentSessionId, agentId: this.agentId,
                conversationPath: this.conversationPath, transcriptPath: this.path, result: entry.result}, null, 2) + "\n";
            if (Buffer.byteLength(state) > MAX_TRANSCRIPT_ENTRY_BYTES) throw new Error("Latest subagent state exceeds 32 MiB; prior record retained");
            readPrivateStorageTextFile(this.storage, this.statePath, MAX_TRANSCRIPT_ENTRY_BYTES);
            value = {type: "snapshot", timestamp: entry.timestamp, historyDelta: {retained, appended: entry.history.slice(retained)},
                result: entry.result, statePath: this.statePath};
        }
        const line = Buffer.from(JSON.stringify(value) + "\n");
        if (line.length > MAX_TRANSCRIPT_ENTRY_BYTES) throw new Error("Subagent record exceeds 32 MiB");
        const handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
            const info = await handle.stat();
            if (!info.isFile()) throw new Error("Subagent transcript must be a regular file");
            if (info.size + line.length > MAX_TRANSCRIPT_BYTES) throw new Error("Subagent event log reached 64 MiB; prior state was retained");
            await handle.chmod(0o600);
            await handle.writeFile(line);
            if (next) this.previous = next;
        } finally {await handle.close();}
        if (state !== undefined) await writeFileAtomically(this.statePath, state, 0o600);
    }
}
