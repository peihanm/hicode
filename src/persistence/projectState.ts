import {randomUUID} from "node:crypto";
import {basename,join} from "node:path";
import {readdir,unlink,realpath,lstat} from "node:fs/promises";
import {z} from "zod";
import {ensurePrivateStorageDirectory,readPrivateStorageTextFile} from "./privateStorage.js";
import {withFileLock} from "./fileLock.js";
import {writeFileAtomically} from "./atomicFile.js";
import {getProjectActivityDirectory,getProjectMaintenanceLockPath,getProjectIdentityPath,getSessionIdentityPath,type HiCodeStorageLayout} from "./layout.js";
import {dirname} from "node:path";

const identity=z.object({version:z.literal(1),cwd:z.string(),name:z.string(),createdAt:z.string().datetime()}).strict();
const sessionIdentity=z.object({version:z.literal(1),cwd:z.string(),sessionId:z.string(),createdAt:z.string().datetime()}).strict();

export async function ensureSessionIdentity(storage:HiCodeStorageLayout,cwd:string,sessionId:string):Promise<void>{
    const path=getSessionIdentityPath(storage,cwd,sessionId);
    ensurePrivateStorageDirectory(storage,dirname(path));
    const previous=readPrivateStorageTextFile(storage,path,32*1024);
    if(previous!==null){const stored=sessionIdentity.parse(JSON.parse(previous));if(stored.sessionId!==sessionId||stored.cwd!==cwd)throw new Error("Session identity changed");return;}
    await writeFileAtomically(path,JSON.stringify({version:1,cwd,sessionId,createdAt:new Date().toISOString()},null,2),0o600);
}

export function readSessionIdentity(storage:HiCodeStorageLayout,path:string){
    const raw=readPrivateStorageTextFile(storage,path,32*1024);
    return raw===null?undefined:sessionIdentity.parse(JSON.parse(raw));
}

export async function activeProjectProcesses(storage:HiCodeStorageLayout,cwd:string):Promise<number[]>{
    const directory=getProjectActivityDirectory(storage,cwd);
    let files;
    try{const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error("Unsafe activity directory");files=await readdir(directory,{withFileTypes:true});}catch(error){if(error&&typeof error==="object"&&"code"in error&&error.code==="ENOENT")return [];throw error;}
    if(files.length>1024)throw new Error("Too many project activity records");
    const pids=new Set<number>();
    for(const file of files){
        const match=/^([1-9][0-9]*)-[a-f0-9-]{36}\.json$/.exec(file.name);
        if(!file.isFile()||!match)throw new Error("Invalid project activity record");
        const pid=Number(match[1]);if(!Number.isSafeInteger(pid))throw new Error("Invalid activity process ID");
        try{process.kill(pid,0);pids.add(pid);}catch(error){if(!(error&&typeof error==="object"&&"code"in error&&error.code==="ESRCH"))pids.add(pid);}
    }
    return [...pids];
}

/** Root holds an activity record until all background resources have stopped. */
export async function acquireProjectActivity(storage:HiCodeStorageLayout,cwd:string):Promise<()=>Promise<void>>{
    const canonical=await realpath(cwd);
    const marker=join(getProjectActivityDirectory(storage,cwd),`${process.pid}-${randomUUID()}.json`);
    ensurePrivateStorageDirectory(storage,dirname(getProjectIdentityPath(storage,cwd)));
    await withFileLock(getProjectMaintenanceLockPath(storage,cwd),async()=>{
        const path=getProjectIdentityPath(storage,cwd);
        ensurePrivateStorageDirectory(storage,dirname(path));
        const previous=readPrivateStorageTextFile(storage,path,32*1024);
        if(previous!==null){if(identity.parse(JSON.parse(previous)).cwd!==canonical)throw new Error("Project identity changed");}
        else await writeFileAtomically(path,JSON.stringify({version:1,cwd:canonical,name:basename(canonical),createdAt:new Date().toISOString()},null,2),0o600);
        ensurePrivateStorageDirectory(storage,dirname(marker));
        await writeFileAtomically(marker,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),0o600);
    });
    let released=false;
    return async()=>{if(released)return;await unlink(marker).catch(error=>{if(error.code!=="ENOENT")throw error;});released=true;};
}

export function readProjectIdentity(storage:HiCodeStorageLayout,path:string){
    const raw=readPrivateStorageTextFile(storage,path,32*1024);
    return raw===null?undefined:identity.parse(JSON.parse(raw));
}
