import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {basename,dirname,join} from "node:path";
import {ensurePrivateStorageDirectory,readPrivateStorageTextFile,writeFileAtomically,type HiCodeStorageLayout} from "../persistence/index.js";
import {getSubagentStorageDirectory} from "../persistence/layout.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import type {AgentType,SubagentResult} from "./types.js";
import {z} from "zod";
import {decodeSessionContentBlock} from "../session/codec.js";
import {hashProjectValue} from "../persistence/project.js";
const MAX_TRANSCRIPT_ENTRY_BYTES=32*1024*1024;
const MAX_TRANSCRIPT_BYTES=64*1024*1024;
const timestampSchema = z.string().datetime();
const resultSchema = z.object({
    agentId: z.string().min(1).max(512), agentType: z.string().min(1),
    description: z.string(), reply: z.string(), reason: z.string().min(1),
    iterations: z.number().int().nonnegative(), toolUseCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
}).passthrough();
const historySchema = z.array(z.unknown()).max(20_000).superRefine((messages, context) => {
    for (const value of messages) {
        try { decodeSessionContentBlock({kind: "message", value}); }
        catch { context.addIssue({code: "custom", message: "Invalid transcript message"}); break; }
    }
});
const stateSchema = z.object({
    version: z.literal(1), timestamp: timestampSchema, history: historySchema, result: resultSchema,
}).strict();
const eventSchema = z.discriminatedUnion("type", [
    z.object({type: z.literal("start"), version: z.literal(1), timestamp: timestampSchema,
        parentSessionId: z.string(), agentId: z.string()}).passthrough(),
    z.object({type: z.literal("event"), timestamp: timestampSchema,
        event: z.object({type: z.string().min(1)}).passthrough()}).strict(),
    z.object({type: z.literal("snapshot"), timestamp: timestampSchema,
        historyDelta: z.object({retained: z.number().int().nonnegative(), appended: historySchema}).strict(),
        result: resultSchema, statePath: z.string()}).strict(),
]);

/** Validate reference-bearing records before maintenance considers any result unreachable. */
export function readSubagentTranscriptReferences(storage: HiCodeStorageLayout, directory: string, parentSessionId: string): unknown[] {
    const events = readPrivateStorageTextFile(storage, join(directory, "events.jsonl"), MAX_TRANSCRIPT_BYTES);
    if (!events?.endsWith("\n")) throw new Error("Missing or incomplete subagent events");
    const lines = events.trimEnd().split("\n");
    if (lines.length > 200_000) throw new Error("Too many subagent events");
    const records = lines.map(line => eventSchema.parse(JSON.parse(line)));
    const owner = records[0];
    if (owner?.type !== "start" || owner.parentSessionId !== parentSessionId ||
        hashProjectValue(owner.agentId, 32) !== basename(directory)) {
        throw new Error("Subagent transcript owner mismatch");
    }
    let retained = 0;
    for (const record of records) {
        if (record.type !== "snapshot") continue;
        if (record.historyDelta.retained > retained || record.result.agentId !== owner.agentId ||
            record.statePath !== join(directory, "state.json")) throw new Error("Invalid subagent history delta");
        retained = record.historyDelta.retained + record.historyDelta.appended.length;
    }
    const state = readPrivateStorageTextFile(storage, join(directory, "state.json"), MAX_TRANSCRIPT_ENTRY_BYTES);
    if (state === null) {
        if (records.some(record => record.type === "snapshot")) throw new Error("Missing latest subagent state");
        return records;
    }
    const latest = stateSchema.parse(JSON.parse(state));
    if (latest.result.agentId !== owner.agentId) throw new Error("Subagent state owner mismatch");
    return [...records, latest];
}
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
    | { type: "event"; timestamp: string; event: AgentEvent }
    | {
    type: "snapshot";
    timestamp: string;
    history: Message[];
    result: SubagentResult;
};


export class SubagentTranscriptWriter {
    readonly path:string;
    private pending:Promise<void>=Promise.resolve();
    private previous:string[]=[];
    private readonly statePath:string;
    constructor(private readonly storage:HiCodeStorageLayout,cwd:string,parentSessionId:string,agentId:string){
        const directory=getSubagentStorageDirectory(storage,cwd,parentSessionId,agentId);
        this.path=join(directory,"events.jsonl");this.statePath=join(directory,"state.json");
    }
    append(entry:SubagentTranscriptEntry):Promise<void>{
        const operation=this.pending.then(()=>this.appendOne(entry));this.pending=operation.catch(()=>{});return operation;
    }
    private async appendOne(entry:SubagentTranscriptEntry):Promise<void>{
        ensurePrivateStorageDirectory(this.storage,dirname(this.path));
        let value:unknown=entry;
        let next:string[]|undefined;
        if(entry.type==="snapshot"){
            next=entry.history.map(message=>JSON.stringify(message));
            let retained=0;
            while(retained<Math.min(next.length,this.previous.length)&&next[retained]===this.previous[retained])retained++;
            const state=JSON.stringify({version:1,timestamp:entry.timestamp,history:entry.history,result:entry.result})+"\n";
            if(Buffer.byteLength(state)>MAX_TRANSCRIPT_ENTRY_BYTES)throw new Error("Latest subagent state exceeds 32 MiB; prior record retained");
            readPrivateStorageTextFile(this.storage,this.statePath,MAX_TRANSCRIPT_ENTRY_BYTES);
            await writeFileAtomically(this.statePath,state,0o600);
            value={type:"snapshot",timestamp:entry.timestamp,historyDelta:{retained,appended:entry.history.slice(retained)},result:entry.result,statePath:this.statePath};
        }
        const line=Buffer.from(JSON.stringify(value)+"\n");
        if(line.length>MAX_TRANSCRIPT_ENTRY_BYTES)throw new Error("Subagent record exceeds 32 MiB");
        const handle=await open(this.path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
        try{
            const info=await handle.stat();
            if(!info.isFile())throw new Error("Subagent transcript must be a regular file");
            if(info.size+line.length>MAX_TRANSCRIPT_BYTES)throw new Error("Subagent event log reached 64 MiB; latest state was retained");
            await handle.chmod(0o600);await handle.writeFile(line);
            if(next)this.previous=next;
        }finally{await handle.close();}
    }
}
