import {realpath} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {z} from "zod";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile, withFileLock, writeFileAtomically, type PillarStorageLayout} from "../../persistence/index.js";
import {getSessionInputHistoryPath} from "../../persistence/layout.js";

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100;
const entrySchema = z.object({version:z.literal(3),sessionId:z.string().min(1),project:z.string().min(1),input:z.string().min(1),timestamp:z.string().datetime()}).strict();
type Entry = z.infer<typeof entrySchema>;

export interface InputHistoryStore {
    load(cwd:string,sessionId:string):Promise<string[]>;
    append(cwd:string,sessionId:string,input:string):Promise<void>;
}

async function canonicalProject(cwd:string):Promise<string> {
    try {return await realpath(cwd);} catch {return resolve(cwd);}
}

function readEntries(storage:PillarStorageLayout,path:string,project:string,sessionId:string):Entry[] {
    const text=readPrivateStorageTextFile(storage,path,MAX_HISTORY_BYTES);
    if(text===null)return [];
    const entries:Entry[]=[];
    for(const line of text.split("\n")) {
        if(!line.trim())continue;
        let raw:unknown;
        try {raw=JSON.parse(line);} catch {throw new Error(`Invalid input history JSON: ${path}`);}
        const parsed=entrySchema.safeParse(raw);
        if(!parsed.success||parsed.data.project!==project||parsed.data.sessionId!==sessionId)throw new Error(`Invalid input history owner or format: ${path}`);
        entries.push(parsed.data);
        if(entries.length>MAX_ENTRIES)throw new Error(`Input history entry limit exceeded: ${path}`);
    }
    return entries;
}

/** Input history is bounded within its Session, including physical disk usage. */
export function createInputHistoryStore(storage:PillarStorageLayout):InputHistoryStore {
    return {
        async load(cwd,sessionId) {
            if(!sessionId)return [];
            const project=await canonicalProject(cwd);
            return readEntries(storage,getSessionInputHistoryPath(storage,project,sessionId),project,sessionId).map(entry=>entry.input);
        },
        async append(cwd,sessionId,input) {
            if(!sessionId||!input||Buffer.byteLength(input)>MAX_INPUT_BYTES)return;
            const project=await canonicalProject(cwd);
            const path=getSessionInputHistoryPath(storage,project,sessionId);
            ensurePrivateStorageDirectory(storage,dirname(path));
            await withFileLock(`${path}.lock`,async()=>{
                const previous=readEntries(storage,path,project,sessionId);
                const entry:Entry={version:3,sessionId,project,input,timestamp:new Date().toISOString()};
                const rows=[...previous.filter(item=>item.input!==input),entry].slice(-MAX_ENTRIES).map(item=>JSON.stringify(item)+"\n");
                let bytes=rows.reduce((sum,row)=>sum+Buffer.byteLength(row),0);
                while(bytes>MAX_HISTORY_BYTES&&rows.length)bytes-=Buffer.byteLength(rows.shift()!);
                await writeFileAtomically(path,rows.join(""),0o600);
            });
        },
    };
}
