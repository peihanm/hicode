import {z} from "zod";
import {lstatSync, readdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {join,isAbsolute} from "node:path";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile, type HiCodeStorageLayout} from "../persistence/index.js";
import {getPromptLogDirectory} from "../persistence/layout.js";
import type {LLMCallKind, LLMTrace, PromptLogPendingResponse, PromptLogRequest, PromptLogResponse} from "./types.js";
import {hashProjectValue} from "../persistence/project.js";

const MAX_PROMPT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_LOG_FILES = 200;
const MAX_PROMPT_LOG_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_TOOL_SEARCH_DESCRIPTION_CHARS = 20_000;
const REQUEST_FILE = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f-]+\.json$/i;
export interface PromptLogHandle {finish(response: PromptLogResponse): void}
const traceBase={ownerCwd:z.string().max(4096).refine(isAbsolute),runId:z.string().min(1).max(512)};
const traceSchema=z.discriminatedUnion("scope",[
    z.object({...traceBase,scope:z.literal("session"),sessionId:z.string().min(1).max(512),agentId:z.string().min(1).max(512).optional()}).strict(),
    z.object({...traceBase,scope:z.literal("maintenance")}).strict(),
]);
const runSchema=z.object({version:z.literal(1),trace:traceSchema,pid:z.number().int().positive().max(2147483647),
    startedAt:z.string().datetime(),completedAt:z.string().datetime().optional(),pending:z.array(z.string().regex(REQUEST_FILE)).max(200),omittedRequests:z.number().int().nonnegative(),writeFailure:z.object({request:z.string().regex(REQUEST_FILE),at:z.string().datetime()}).strict().optional()}).strict();
type RunRecord=z.infer<typeof runSchema>;

function toolName(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const fn = (value as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") return undefined;
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
}

function toolDescription(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const fn = (value as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") return undefined;
    const description = (fn as Record<string, unknown>).description;
    return typeof description === "string" ? description : undefined;
}

function compactRequest(request: PromptLogRequest): Record<string, unknown> {
    const {messages, tools, ...metadata} = request;
    const toolNames = (tools ?? [])
        .map(toolName)
        .filter((name): name is string => name !== undefined);
    const toolSearchDescription = (tools ?? []).find(
        (tool) => toolName(tool) === "tool_search"
    );
    const deferredToolManifest = toolDescription(toolSearchDescription)
        ?.slice(0, MAX_TOOL_SEARCH_DESCRIPTION_CHARS);
    return {
        ...metadata,
        messages,
        ...(toolNames.length > 0 ? {toolNames} : {}),
        ...(deferredToolManifest
            ? {toolSearchDescription: deferredToolManifest}
            : {}),
    };
}

function redactSerializedLog(serialized: string, secrets: readonly string[]): string {
    const values = [...new Set(secrets.filter((value) => value.length > 0))]
        .sort((left, right) => right.length - left.length);
    let redacted = serialized;
    for (const value of values) {
        const encoded = JSON.stringify(value).slice(1, -1);
        redacted = redacted.replaceAll(value, "[REDACTED]");
        if (encoded !== value) {
            redacted = redacted.replaceAll(encoded, "[REDACTED]");
        }
    }
    return redacted;
}


function alive(pid:number):boolean {
    if(!Number.isSafeInteger(pid)||pid<=0)return false;
    try{process.kill(pid,0);return true;}catch(error){return !(error&&typeof error==="object"&&"code" in error&&error.code==="ESRCH");}
}
function runDirectory(storage:HiCodeStorageLayout,trace:LLMTrace):string {
    return join(getPromptLogDirectory(storage,trace.ownerCwd,trace.scope==="session"?trace.sessionId:undefined),`run-${hashProjectValue(trace.runId,32)}`);
}
function atomic(path:string,text:string):void {
    const temporary=`${path}.${process.pid}.${randomUUID()}.tmp`;
    try {writeFileSync(temporary,text,{flag:"wx",mode:0o600});renameSync(temporary,path);}
    finally {try{rmSync(temporary);}catch{}}
}
function readRun(storage:HiCodeStorageLayout,directory:string):RunRecord|undefined {
    const text=readPrivateStorageTextFile(storage,join(directory,"run.json"),32*1024);
    if(text===null)return;
    return runSchema.parse(JSON.parse(text));
}
function writeRun(directory:string,run:RunRecord):void {atomic(join(directory,"run.json"),JSON.stringify(run,null,2));}

/** Retire completed runs first; active runs keep pending requests and expose any coverage gap. */
function prune(storage:HiCodeStorageLayout,root:string,currentFile:string):boolean {
    const runs: Array<{directory:string;record:RunRecord;files:Array<{name:string;bytes:number}>;active:boolean}>=[];
    const entries=readdirSync(root,{withFileTypes:true});
    if(entries.length>2000)return false;
    for(const entry of entries){
        if(!entry.isDirectory()||!/^run-[a-f0-9]{32}$/.test(entry.name))continue;
        const directory=join(root,entry.name),record=readRun(storage,directory);
        if(!record)continue;
        const files=readdirSync(directory,{withFileTypes:true}).filter(file=>file.isFile()&&REQUEST_FILE.test(file.name))
            .map(file=>({name:file.name,bytes:lstatSync(join(directory,file.name)).size}));
        runs.push({directory,record,files,active:(!record.completedAt||record.pending.length>0)&&alive(record.pid)});
    }
    let count=runs.reduce((n,run)=>n+run.files.length,0),bytes=runs.reduce((n,run)=>n+run.files.reduce((m,file)=>m+file.bytes,0),0);
    const over=()=>count>MAX_PROMPT_LOG_FILES||bytes>MAX_PROMPT_LOG_TOTAL_BYTES;
    for(const run of runs.sort((a,b)=>a.record.startedAt.localeCompare(b.record.startedAt))){
        if(!over())break;
        if(run.active||run.files.some(file=>join(run.directory,file.name)===currentFile))continue;
        rmSync(run.directory,{recursive:true});count-=run.files.length;bytes-=run.files.reduce((n,file)=>n+file.bytes,0);
    }
    if(over())for(const run of runs){
        if(!run.active)continue;
        for(const file of run.files.sort((a,b)=>a.name.localeCompare(b.name))){
            if(!over())break;
            if(run.record.pending.includes(file.name)||join(run.directory,file.name)===currentFile)continue;
            rmSync(join(run.directory,file.name));count--;bytes-=file.bytes;run.record.omittedRequests++;
            writeRun(run.directory,run.record);
        }
    }
    return !over();
}

export function finishPromptLogRun(storage:HiCodeStorageLayout,trace:LLMTrace):void {
    try {
        const directory=runDirectory(storage,trace),run=readRun(storage,directory);
        if(run&&run.pid===process.pid){run.completedAt=new Date().toISOString();writeRun(directory,run);}
    }catch{ /* Diagnostics never control task completion. */ }
}

export function beginPromptLog(storage:HiCodeStorageLayout,cwd:string,kind:LLMCallKind,model:string,
    request:PromptLogRequest,secrets:readonly string[],providedTrace?:LLMTrace,attempt=1):PromptLogHandle {
    const timestamp=new Date().toISOString();
    const parsedTrace=traceSchema.safeParse(providedTrace??{scope:"maintenance",ownerCwd:cwd,runId:randomUUID()});
    if(!parsedTrace.success)return {finish:()=>{}};
    const trace=parsedTrace.data;
    const root=getPromptLogDirectory(storage,trace.ownerCwd,trace.scope==="session"?trace.sessionId:undefined);
    const directory=runDirectory(storage,trace);
    const filename=`${timestamp.replace(/[:.]/g,"-")}_${randomUUID()}.json`,path=join(directory,filename);
    const persistedRequest=compactRequest(request);
    let initialized=false;
    const write=(response:PromptLogResponse|PromptLogPendingResponse)=>{
        try {
            ensurePrivateStorageDirectory(storage,root);
            const existingRuns=readdirSync(root).filter(name=>/^run-[a-f0-9]{32}$/.test(name));
            if(!existingRuns.includes(directory.split("/").at(-1)!)&&existingRuns.length>=256)return;
            ensurePrivateStorageDirectory(storage,directory);
            const run=readRun(storage,directory)??{version:1,trace,pid:process.pid,startedAt:timestamp,pending:[],omittedRequests:0};
            if(run.pid!==process.pid&&alive(run.pid))return;
            if(!initialized){
                if(run.pending.length>=200){run.omittedRequests++;writeRun(directory,run);return;}
                run.pending.push(filename);initialized=true;
            }
            const pending="status" in response&&response.status==="pending";
            if(!pending)run.pending=run.pending.filter(name=>name!==filename);
            const payload={timestamp,updatedAt:new Date().toISOString(),kind,model,trace,attempt,executionCwd:cwd,request:persistedRequest,response};
            const serialized=redactSerializedLog(JSON.stringify(payload,null,2),secrets);
            const omitted=()=>JSON.stringify({timestamp,updatedAt:new Date().toISOString(),kind,model,trace,attempt,executionCwd:cwd,
                request:{omitted:true},response:{status:pending?"pending":"omitted",error:"Prompt log body omitted by storage limits"}},null,2);
            if(Buffer.byteLength(serialized)>MAX_PROMPT_LOG_BYTES){atomic(path,omitted());run.omittedRequests++;}
            else atomic(path,serialized);
            if(!pending&&!providedTrace)run.completedAt=new Date().toISOString();
            writeRun(directory,run);
            if(!prune(storage,root,path)){
                atomic(path,omitted());
                const current=readRun(storage,directory);if(current){current.omittedRequests++;writeRun(directory,current);}
            }
        }catch{
            try {
                const run=readRun(storage,directory);
                if(run&&run.pid===process.pid){run.pending=run.pending.filter(name=>name!==filename);run.writeFailure={request:filename,at:new Date().toISOString()};writeRun(directory,run);}
            }catch{ /* A failed diagnostic sink cannot control task execution. */ }
        }
    };
    write({status:"pending"});
    return {finish:write};
}
