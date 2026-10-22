import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {dirname,join} from "node:path";
import {ensurePrivateStorageDirectory,readPrivateStorageTextFile,writeFileAtomically,type HiCodeStorageLayout} from "../persistence/index.js";
import {getSubagentStorageDirectory} from "../persistence/layout.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import type {AgentType,SubagentResult} from "./types.js";
const MAX_TRANSCRIPT_ENTRY_BYTES=32*1024*1024;
const MAX_TRANSCRIPT_BYTES=64*1024*1024;
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
