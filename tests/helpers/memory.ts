import {DEFAULT_CONTEXT_SETTINGS} from "../../src/context/config.js";
import type {MemorySourceExtractor} from "../../src/memory/sourceExtractor.js";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createMemoryRuntimeFactory, type MemoryRuntimeLike} from "../../src/memory/runtime.js";
import type {MemoryConsolidator} from "../../src/memory/consolidator.js";
import {serializeMemoryTopic} from "../../src/memory/topic.js";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {createHash} from "node:crypto";
import {saveSessionSnapshot} from "./sessionStorage.js";
import {readSessionSourceIds} from "../../src/session/snapshotStore.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createTestStorage} from "./tempProject.js";
import {testChildEnvironment} from "./childEnvironment.js";
export const memoryOwner = () => ({sessionId: "test-session", turnId: "test-turn", signal: new AbortController().signal});
export function createTestMemoryRuntime(cwd: string, options: {enabled?: boolean; autoExtract?: boolean; consolidator?: MemoryConsolidator;extractor?:MemorySourceExtractor} = {}): MemoryRuntimeLike {
 return createMemoryRuntimeFactory({createExtractor:()=>options.extractor??{async extract(messages){return messages.flatMap(message=>{try{const value: unknown=JSON.parse(message.content ?? "");if(value && typeof value==="object" && "key" in value && typeof value.key==="string" && "content" in value && typeof value.content==="string")return [{key:value.key,type:"feedback" as const,content:value.content,basis:"user-stated" as const,sources:[message.id]}];}catch{}return [];});}},createConsolidator: () => options.consolidator ?? {async consolidate({lease, baseline}) {
  return {summary: "已整理偏好", topics: [...baseline.topics.map(({createdAt: _created, updatedAt: _updated, ...topic}) => topic), ...baseline.sources.filter(s => lease.sourceIds.includes(s.id)).map(s => ({key:s.key,name:s.key,description:"测试整理",type:s.type,content:s.content,sources:[s.id]}))]};
 }}})({storage:createTestStorage(cwd),cwd,shellRunner:createShellRunner(createDisabledSandboxRuntime(),testChildEnvironment),contextSettings: DEFAULT_CONTEXT_SETTINGS, settings:{enabled:options.enabled??true,autoExtract:options.autoExtract??false},getModelTarget:()=>({source:"glm",model:"glm-test",label:"GLM Test"}),getModelSource:()=>({id:"glm",label:"GLM",apiKeyEnv:"GLM_API_KEY",models:[{id:"glm-test",label:"GLM"}]})});
}
export async function remember(memory: MemoryRuntimeLike, key: string, content: string) {
 const path=join(memory.directory,"topics",`${key}.md`);
 await mkdir(join(memory.directory,"topics"),{recursive:true});
 await writeFile(path,serializeMemoryTopic({name:key,description:"Saved preference",type:"feedback",content}));
 return path;
}

export async function queueSource(store: MemoryPublicationStore, key: string, content: string, sessionId = "source-session", hashes = ["a".repeat(64)]) {
 const signal = new AbortController().signal;
 const id = createHash("sha256").update(JSON.stringify([sessionId,key,content,hashes])).digest("hex");
 await store.offerFrame({id, sessionId, messageHashes: hashes, omitted:0},signal);
 const job = await store.claimExtraction(signal);
 if (!job) return;
 await store.finishExtraction(job.lease,job.frames.map(frame=>({frame, unavailable:false, facts:[{key,type:"feedback" as const,content,basis:"user-stated" as const,sources:hashes}]})),signal);
}
export async function queueMemory(cwd: string, key: string, content: string) {
 const storage=createTestStorage(cwd); const sessionId=`memory-source-${key}`;
 await saveSessionSnapshot(storage,{cwd,sessionId,model:"glm-test",history:[{role:"user",origin:"user",content:JSON.stringify({key,content})}],todos:[],permissionMode:"ask",collaborationMode:"build",uiEvents:[]});
 await queueSource(new MemoryPublicationStore(storage,cwd),key,content,sessionId,readSessionSourceIds(storage,cwd,sessionId));
}
