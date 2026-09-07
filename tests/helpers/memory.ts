import type {MemorySourceExtractor} from "../../src/memory/sourceExtractor.js";
import {join} from "node:path";
import {createMemoryRuntimeFactory, type MemoryRuntimeLike} from "../../src/memory/runtime.js";
import type {MemoryConsolidator} from "../../src/memory/consolidator.js";
import {serializeMemoryNote} from "../../src/memory/publicationStore.js";
import {createDisabledSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createTestStorage} from "./tempProject.js";
import {testChildEnvironment} from "./childEnvironment.js";
export const memoryOwner = () => ({sessionId: "test-session", turnId: "test-turn", signal: new AbortController().signal});
export function createTestMemoryRuntime(cwd: string, options: {enabled?: boolean; autoExtract?: boolean; consolidator?: MemoryConsolidator;extractor?:MemorySourceExtractor} = {}): MemoryRuntimeLike {
 return createMemoryRuntimeFactory({createExtractor:()=>options.extractor??{async extract(){return [];}},createConsolidator: () => options.consolidator ?? {async consolidate({lease, baseline}) {
  return {summary: "已整理偏好", topics: [...baseline.topics, ...baseline.sources.filter(s => lease.sourceIds.includes(s.id)).map(s => ({key:s.key,name:s.key,description:"测试整理",type:s.type,content:s.content,sources:[s.id]}))]};
 }}})({storage:createTestStorage(cwd),cwd,environment:testChildEnvironment,shellRunner:createShellRunner(createDisabledSandboxRuntime(),testChildEnvironment),settings:{enabled:options.enabled??true,autoExtract:options.autoExtract??false},getModelTarget:()=>({source:"glm",provider:"glm",model:"glm-test",label:"GLM Test"}),getModelSource:()=>({id:"glm",label:"GLM",apiKeyEnv:"GLM_API_KEY",models:[{id:"glm-test",label:"GLM"}]})});
}
export async function remember(memory: MemoryRuntimeLike, key: string, content: string) {
 const path=join(memory.directory,"inbox",`${key}.md`);
 await memory.fileAccess(memoryOwner()).write(path,serializeMemoryNote({operation:"remember",type:"feedback",content}),null,`write-${key}`);
 return path;
}
