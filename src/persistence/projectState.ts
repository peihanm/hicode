import {z} from "zod";
import {ensurePrivateStorageDirectory,readPrivateStorageTextFile} from "./privateStorage.js";
import {withFileLock} from "./fileLock.js";
import {writeFileAtomically} from "./atomicFile.js";
import {getProjectIdentityLockPath,getProjectIdentityPath,getSessionIdentityPath,type HiCodeStorageLayout} from "./layout.js";
import {basename,dirname} from "node:path";
import {realpath} from "node:fs/promises";

const identity=z.object({version:z.literal(1),cwd:z.string(),name:z.string(),createdAt:z.string().datetime()}).strict();
const sessionIdentity=z.object({version:z.literal(1),cwd:z.string(),sessionId:z.string(),createdAt:z.string().datetime()}).strict();

export async function ensureSessionIdentity(storage:HiCodeStorageLayout,cwd:string,sessionId:string):Promise<void>{
    const path=getSessionIdentityPath(storage,cwd,sessionId);
    ensurePrivateStorageDirectory(storage,dirname(path));
    const previous=readPrivateStorageTextFile(storage,path,32*1024);
    if(previous!==null){const stored=sessionIdentity.parse(JSON.parse(previous));if(stored.sessionId!==sessionId||stored.cwd!==cwd)throw new Error("Session identity changed");return;}
    await writeFileAtomically(path,JSON.stringify({version:1,cwd,sessionId,createdAt:new Date().toISOString()},null,2),0o600);
}

export async function ensureProjectIdentity(storage:HiCodeStorageLayout,cwd:string):Promise<void>{
    const canonical=await realpath(cwd);
    const path=getProjectIdentityPath(storage,cwd);
    ensurePrivateStorageDirectory(storage,dirname(path));
    await withFileLock(getProjectIdentityLockPath(storage,cwd),async()=>{
        const previous=readPrivateStorageTextFile(storage,path,32*1024);
        if(previous!==null){if(identity.parse(JSON.parse(previous)).cwd!==canonical)throw new Error("Project identity changed");}
        else await writeFileAtomically(path,JSON.stringify({version:1,cwd:canonical,name:basename(canonical),createdAt:new Date().toISOString()},null,2),0o600);
    });
}
