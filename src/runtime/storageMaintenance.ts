import {storedImageSchema} from "../images/content.js";
import {imageAssetId} from "../images/identity.js";
import {lstat,readdir,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {getProjectStorageDirectory,getProjectSessionsDirectory,getSessionStorageDirectory,getProjectMaintenanceLockPath,getProjectActivityDirectory,type HiCodeStorageLayout} from "../persistence/layout.js";
import {activeProjectProcesses,readSessionIdentity,readProjectIdentity} from "../persistence/projectState.js";
import {readPrivateStorageTextFile,withFileLock,ensurePrivateStorageDirectory} from "../persistence/index.js";
import {readLatestSessionSnapshot,readSessionSourceIds} from "../session/snapshotStore.js";
import {SessionContentStore} from "../session/contentStore.js";
import {createTaskJournal} from "../tasks/journal.js";
import {getArtifactKey} from "../toolResults/paths.js";
import {parseBinaryArtifactMetadata,parseTextArtifactMetadata} from "../toolResults/artifactMetadata.js";
import {readSubagentTranscriptReferences} from "../subagents/transcript.js";

interface Candidate {path:string;bytes:number;reason:"package-cache"|"orphan"|"unreferenced"|"temporary"}
export interface StorageReport {sessions:Array<{path:string;sessionId?:string;format:"current"|"legacy"|"draft"|"invalid";bytes:number;files:number}>;project:string;path:string;bytes:number;files:number;activeProcesses:number[];categories:Record<string,{bytes:number;files:number}>;candidates:Candidate[];issues:string[];removedBytes?:number}

async function entries(path:string){
 try{return await readdir(path,{withFileTypes:true});}catch(error){if(error&&typeof error==="object"&&"code"in error&&error.code==="ENOENT")return [];throw error;}
}
async function measure(path:string):Promise<{bytes:number;files:number}>{
 let bytes=0,files=0;const pending=[path];
 while(pending.length){
  const dir=pending.pop()!;
  for(const entry of await entries(dir)){
   if(++files>200_000)throw new Error("Storage inspection exceeded 200,000 entries");
   const child=join(dir,entry.name);
   const info=await lstat(child);
   if(info.isDirectory()&&!info.isSymbolicLink())pending.push(child);else bytes+=info.size;
  }
 }
 return {bytes,files};
}
function collectReferences(value:unknown,refs:Set<string>):void{
 const queue:unknown[]=[value];let visited=0;
 while(queue.length){
  if(++visited>2_000_000)throw new Error("Reference inspection exceeded its object budget");
  const current=queue.pop();
  if(typeof current==="string"){
   if(current.length<=2048)refs.add(current);
   for(const match of current.matchAll(/(?:[a-f0-9]{32,64}|(?:tr_|task_|image-)[^\s"'<>]{1,512})/g))refs.add(match[0]);
  }else if(current&&typeof current==="object"){
   if("kind"in current&&(current.kind==="source"||current.kind==="view")){
    const image=storedImageSchema.safeParse(current);if(image.success)refs.add(imageAssetId(image.data));
   }
   queue.push(...Object.values(current));
  }
 }
}

/** Project-wide idle gate protects drafts, queued inputs and child stores without guessing their liveness. */
export async function inspectStorage(storage:HiCodeStorageLayout,cwd:string,preview=false):Promise<StorageReport>{
 const root=getProjectStorageDirectory(storage,cwd);
 readPrivateStorageTextFile(storage,join(root,"project.json"),32*1024);
 const report:StorageReport={sessions:[],project:cwd,path:root,bytes:0,files:0,activeProcesses:await activeProjectProcesses(storage,cwd),categories:{},candidates:[],issues:[]};
 for(const entry of await entries(root)){
  if(entry.name.startsWith("."))continue;
  const path=join(root,entry.name),size=entry.isDirectory()?await measure(path):{bytes:(await lstat(path)).size,files:1};
  report.categories[entry.name]=size;report.bytes+=size.bytes;report.files+=size.files;
 }
 for(const entry of await entries(getProjectSessionsDirectory(storage,cwd))){
  if(!entry.isDirectory()||!/^session-[a-f0-9]{24}$/.test(entry.name))continue;
  const path=join(getProjectSessionsDirectory(storage,cwd),entry.name),size=await measure(path);
  try{
   const identity=readSessionIdentity(storage,join(path,"identity.json"));
   const names=(await entries(path)).map(file=>file.name);
   report.sessions.push({path,...(identity?{sessionId:identity.sessionId}:{}),format:names.includes("snapshot.json")?"current":names.includes("events.jsonl")?"legacy":"draft",...size});
  }catch{report.sessions.push({path,format:"invalid",...size});}
 }
 if(!preview||report.activeProcesses.length)return report;
 const refs=new Set<string>();
 const owners:Array<{directory:string;sessionId:string}>=[];
 for(const entry of await entries(getProjectSessionsDirectory(storage,cwd))){
  if(!/^session-[a-f0-9]{24}$/.test(entry.name))continue;
  const directory=join(getProjectSessionsDirectory(storage,cwd),entry.name);
  try{
   if(!entry.isDirectory())throw new Error("Unsafe session directory");
   const identity=readSessionIdentity(storage,join(directory,"identity.json"));
   if(!identity||getSessionStorageDirectory(storage,cwd,identity.sessionId)!==directory){report.issues.push(`${directory}: missing or invalid identity; left unchanged`);continue;}
   const snapshot=readLatestSessionSnapshot(storage,cwd,identity.sessionId);
   if(snapshot){
    collectReferences(snapshot,refs);
    const blocks=new SessionContentStore(storage,cwd,identity.sessionId);
    for(const id of readSessionSourceIds(storage,cwd,identity.sessionId))collectReferences(blocks.read(id),refs);
   }else if((await entries(directory)).some(file=>file.name==="events.jsonl"))throw new Error("Legacy snapshot needs manual review");
   const tasks=await createTaskJournal(storage,cwd).load(identity.sessionId);
   collectReferences(tasks,refs);
   for(const agent of await entries(join(directory,"subagents"))){
    if(!agent.isDirectory()||!/^[a-f0-9]{32}$/.test(agent.name))throw new Error("Legacy or unsafe subagent record");
    collectReferences(readSubagentTranscriptReferences(storage,join(directory,"subagents",agent.name),identity.sessionId),refs);
   }
   owners.push({directory,sessionId:identity.sessionId});
  }catch{report.issues.push(`${directory}: invalid snapshot, task or child references; cleanup blocked`);}
 }
 // A damaged source could reference any shared/fork result: do not guess what is unreachable.
 if(report.issues.length)return report;
 for(const owner of owners){
  const directory=join(owner.directory,"tool-results"),files=await entries(directory);
  if(files.length>40_000)throw new Error("Tool result inspection exceeded its file budget");
  const names=new Set(files.map(file=>file.name));
  const ownerKeys=new Set([...refs].filter(ref=>/^(tr_|task_|image-)/.test(ref)).map(ref=>getArtifactKey(owner.sessionId,ref)));
  for(const file of files){
   if(file.name===".store.lock")continue;
   const path=join(directory,file.name);
   if(!file.isFile()){report.issues.push(`${path}: unsafe artifact; cleanup blocked`);continue;}
   const info=await lstat(path);
   if(file.name.startsWith(".tmp-")){report.candidates.push({path,bytes:info.size,reason:"temporary"});continue;}
   const match=/^([a-f0-9]{32})\.(txt|bin|meta\.json|binary\.json)$/.exec(file.name);
   if(!match)continue;
   const key=match[1]!,binary=match[2]==="bin"||match[2]==="binary.json";
   const content=`${key}.${binary?"bin":"txt"}`,metadata=`${key}.${binary?"binary.json":"meta.json"}`;
   const present=names.has(content)&&names.has(metadata);
   if(!present){
    if(refs.has(key)||ownerKeys.has(key)){report.issues.push(`${path}: referenced artifact pair is incomplete`);continue;}
    report.candidates.push({path,bytes:info.size,reason:"orphan"});continue;
   }
   if(file.name!==metadata)continue;
   try{
    const text=readPrivateStorageTextFile(storage,path,64*1024)!;
    const raw:unknown=JSON.parse(text);
    if(!raw||typeof raw!=="object")throw new Error("Invalid artifact");
    const id=binary&&"artifactId"in raw?raw.artifactId:!binary&&"resultId"in raw?raw.resultId:undefined;
    if(typeof id!=="string"||getArtifactKey(owner.sessionId,id)!==key)throw new Error("Artifact owner mismatch");
    const parsed=binary?parseBinaryArtifactMetadata(text,id):parseTextArtifactMetadata(text,id);
    if(!parsed)throw new Error("Invalid artifact metadata");
    if(binary&&"image"in parsed&&parsed.image&&refs.has(parsed.image.sha256))refs.add(id);
    if(refs.has(key)||ownerKeys.has(key)||refs.has(id)||refs.has(join(directory,content)))continue;
    if(!/^(tr_|task_|image-)/.test(id))continue;
    report.candidates.push({path,bytes:info.size,reason:"unreferenced"},{path:join(directory,content),bytes:(await lstat(join(directory,content))).size,reason:"unreferenced"});
   }catch{report.issues.push(`${path}: invalid artifact metadata; cleanup blocked`);}
  }
 }
 for(const owner of owners){
  for(const directory of [owner.directory,join(owner.directory,"content"),join(owner.directory,"archives")]){
   for(const file of await entries(directory)){
    if(file.isFile()&&/^\.(?:snapshot|identity|[a-f0-9]{64})\.json\.[0-9]+\.[a-f0-9-]{36}\.tmp$/.test(file.name)){
     const path=join(directory,file.name);report.candidates.push({path,bytes:(await lstat(path)).size,reason:"temporary"});
    }
   }
  }
 }
 for(const file of await entries(getProjectActivityDirectory(storage,cwd))){
  if(file.isFile()){const path=join(getProjectActivityDirectory(storage,cwd),file.name);report.candidates.push({path,bytes:(await lstat(path)).size,reason:"temporary"});}
 }
 const cache=join(root,"cache");
 for(const name of ["bun","npm"]){
  const path=join(cache,name);
  if((await entries(cache)).some(entry=>entry.name===name&&entry.isDirectory()))report.candidates.push({path,bytes:(await measure(path)).bytes,reason:"package-cache"});
 }
 return report;
}

export async function cleanStorage(storage:HiCodeStorageLayout,cwd:string):Promise<StorageReport>{
 ensurePrivateStorageDirectory(storage,getProjectStorageDirectory(storage,cwd));
 return withFileLock(getProjectMaintenanceLockPath(storage,cwd),async()=>{
  const report=await inspectStorage(storage,cwd,true);
  if(report.activeProcesses.length)throw new Error("Project is active; close its HiCode processes before cleaning storage");
  if(report.issues.length)throw new Error("Storage has unresolved reference errors; inspect and repair them before cleanup");
  for(const candidate of report.candidates){
   if(!resolve(candidate.path).startsWith(`${resolve(report.path)}/`))throw new Error("Invalid cleanup path");
   const info=await lstat(candidate.path);if(info.isSymbolicLink())throw new Error("Cleanup path became a symlink");
   await rm(candidate.path,{recursive:info.isDirectory(),force:false});
  }
  return {...report,removedBytes:report.candidates.reduce((sum,candidate)=>sum+candidate.bytes,0)};
 });
}

export async function listStoredProjects(storage:HiCodeStorageLayout){
 const projects:Array<{path:string;cwd?:string;name?:string;status:"identified"|"unidentified"|"invalid"}>=[];
 for(const entry of await entries(storage.projectsRoot)){
  if(!entry.isDirectory())continue;
  const path=join(storage.projectsRoot,entry.name);
  try{
   const identity=readProjectIdentity(storage,join(path,"project.json"));
   if(identity&&getProjectStorageDirectory(storage,identity.cwd)!==path)throw new Error("Project identity mismatch");
   projects.push({path,...(identity?{cwd:identity.cwd,name:identity.name}:{}),status:identity?"identified":"unidentified"});
  }catch{projects.push({path,status:"invalid"});}
 }
 return projects;
}
