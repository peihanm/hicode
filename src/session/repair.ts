import {activeProjectProcesses} from "../persistence/projectState.js";
import {withFileLock} from "../persistence/fileLock.js";
import {getSessionIndexLockPath,ensureSessionsDirectory} from "./paths.js";
import {createHash} from "node:crypto";
import {readdir} from "node:fs/promises";
import {join} from "node:path";
import {ensurePrivateStorageDirectory,getProjectSessionsDirectory,getSessionStorageDirectory,readPrivateStorageTextFile,writeFileAtomically,type PillarStorageLayout} from "../persistence/index.js";
import {getSessionIndexRecoveryDirectory,getProjectMaintenanceLockPath} from "../persistence/layout.js";
import {getSessionIndexPath} from "./paths.js";
import {readLatestSessionSnapshot} from "./snapshotStore.js";
import {countSessionConversationMessages,summarizeSessionHistory} from "./codec.js";
import {SESSION_INDEX_VERSION,type SessionIndexEntry} from "./types.js";

export interface SessionRepairResult {sessions:SessionIndexEntry[];issues:string[];backup?:string}

/** Explicit repair, never a silent fallback in the normal save path. */
export async function repairSessionIndex(storage:PillarStorageLayout,cwd:string):Promise<SessionRepairResult> {
 ensureSessionsDirectory(storage,cwd);
 return withFileLock(getProjectMaintenanceLockPath(storage,cwd),async()=>{
  if((await activeProjectProcesses(storage,cwd)).length)throw new Error("Close active Pillar processes before repairing the Session index");
  return withFileLock(getSessionIndexLockPath(storage,cwd),async()=>{
  const root=getProjectSessionsDirectory(storage,cwd);
  const directories=await readdir(root,{withFileTypes:true});
  if(directories.length>20_000)throw new Error("Too many Session directories to repair safely");
  const sessions:SessionIndexEntry[]=[],issues:string[]=[];
  for(const directory of directories){
   if(!/^session-[a-f0-9]{24}$/.test(directory.name))continue;
   try {
    if(!directory.isDirectory())throw new Error("Unsafe session directory");
    const path=join(root,directory.name,"snapshot.json");
    const content=readPrivateStorageTextFile(storage,path,16*1024*1024);
    if(content===null){issues.push(`${directory.name}: no current-format snapshot`);continue;}
    const raw:unknown=JSON.parse(content);
    if(!raw||typeof raw!=="object"||!("sessionId" in raw)||typeof raw.sessionId!=="string"||
     getSessionStorageDirectory(storage,cwd,raw.sessionId)!==join(root,directory.name))throw new Error("Session identity mismatch");
    const snapshot=readLatestSessionSnapshot(storage,cwd,raw.sessionId);
    if(!snapshot)throw new Error("Missing snapshot");
    sessions.push({sessionId:snapshot.sessionId,cwd:snapshot.cwd,model:snapshot.model,
     createdAt:snapshot.timestamp,updatedAt:snapshot.timestamp,messageCount:countSessionConversationMessages(snapshot.conversation),
     summary:summarizeSessionHistory(snapshot.conversation).summary});
   }catch{issues.push(`${directory.name}: invalid snapshot or content; left unchanged`);}
  }
  if(sessions.length>10_000)throw new Error("Session index entry limit exceeded");
  const index=getSessionIndexPath(storage,cwd);
  const previous=readPrivateStorageTextFile(storage,index,8*1024*1024);
  let backup:string|undefined;
  if(previous!==null){
   const directory=getSessionIndexRecoveryDirectory(storage,cwd);ensurePrivateStorageDirectory(storage,directory);
   const files=await readdir(directory);if(files.length>=32)throw new Error("Index recovery backups reached 32; review them before repairing again");
   backup=join(directory,`${createHash("sha256").update(previous).digest("hex")}.json`);
   await writeFileAtomically(backup,previous,0o600);
  }
  const content=JSON.stringify({version:SESSION_INDEX_VERSION,sessions:sessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))},null,2)+"\n";
  if(Buffer.byteLength(content)>8*1024*1024)throw new Error("Rebuilt Session index exceeds 8 MiB");
  await writeFileAtomically(index,content,0o600);
  return {sessions,issues,...(backup?{backup}:{})};
  });
 });
}
