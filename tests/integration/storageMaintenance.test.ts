import {expect,test} from "bun:test";
import {mkdir,readFile,stat,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import sharp from "sharp";
import {createSessionPersistence} from "../../src/session/storage.js";
import {createToolResultStore} from "../../src/toolResults/store.js";
import {importUserInput} from "../../src/images/input.js";
import {getProjectStorageDirectory} from "../../src/persistence/layout.js";
import {acquireProjectActivity, ensureSessionIdentity} from "../../src/persistence/projectState.js";
import {inspectStorage,cleanStorage} from "../../src/runtime/storageMaintenance.js";
import {withTempProject} from "../helpers/tempProject.js";
import {SubagentTranscriptWriter, readSubagentTranscriptReferences} from "../../src/subagents/transcript.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTestContext} from "../helpers/testContext.js";
import {assistantText, createFakeLLM} from "../helpers/fakeLLM.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/index.js";

test("real completed and continued child transcripts validate and retain referenced artifacts", async () => {
 await withTempProject(async (cwd, storage) => {
  const parent = "parent";
  await ensureSessionIdentity(storage, cwd, parent);
  const store = createToolResultStore(storage, cwd, parent);
  const artifact = await store.persistText({toolCallId: "evidence", toolName: "bash", content: "child evidence"});
  const fake = createFakeLLM([assistantText(`done: ${artifact.path}`), assistantText("followup done")]);
  const thread = await createSubagentThreadForTest({agentId: "maintenance-child", parentContext: createTestContext(cwd, {sessionId: parent}),
   onEvent() {}, agentOptions: {callLLM: fake.callLLM}, toolResultStoreOptions: {hicodeHome: storage.hicodeHome}},
   {agentType: "Explore", description: "test", prompt: "inspect", parentToolCallId: "agent"});
  for (const input of ["inspect", "continue"]) {
   const result = await thread.run({prompt: input, signal: new AbortController().signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
   expect(result.reason).toBe("completed");
   expect(result.transcriptPath).toBeDefined();
   expect(readSubagentTranscriptReferences(storage, dirname(result.transcriptPath!), parent).length).toBeGreaterThan(0);
   const preview = await inspectStorage(storage, cwd, true);
   expect(preview.issues).toEqual([]);
   expect(preview.candidates.some(candidate => candidate.path === artifact.path)).toBe(false);
  }
  await cleanStorage(storage, cwd);
  expect(await readFile(artifact.path, "utf8")).toBe("child evidence");
 });
});

test("cleanup preserves referenced text and image source/view dependencies, removing unused outputs",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const store=createToolResultStore(storage,cwd,"session"),writer=createSessionPersistence(storage,cwd,"session");
  const used=await store.persistText({toolCallId:"used",toolName:"bash",content:"used"});
  const unused=await store.persistText({toolCallId:"unused",toolName:"bash",content:"unused"});
  const png=await sharp({create:{width:4,height:4,channels:3,background:"red"}}).png().toBuffer();
  const blue=await sharp({create:{width:4,height:4,channels:3,background:"blue"}}).png().toBuffer();
  const removedImages=await importUserInput([{type:"image",data:blue}],store,true,new AbortController().signal);
  const images=await importUserInput([{type:"image",data:png}],store,true,new AbortController().signal);
  await writer.save({cwd,sessionId:"session",model:"test",history:[{role:"user",origin:"user",content:`Retain ${used.path}`},{role:"user",origin:"user",content:images}],todos:[],permissionMode:"ask",});
  const orphan=join(dirname(unused.path),`${"a".repeat(32)}.txt`);await writeFile(orphan,"orphan");
  const cache=join(getProjectStorageDirectory(storage,cwd),"cache","npm");await mkdir(cache,{recursive:true});await writeFile(join(cache,"cache"),"cached");
  const preview=await inspectStorage(storage,cwd,true);
  expect(preview.issues).toEqual([]);expect(preview.candidates.some(file=>file.path===unused.path)).toBe(true);
  expect(preview.candidates.filter(file=>file.path.endsWith(".bin"))).toHaveLength(2);
  const result=await cleanStorage(storage,cwd);expect(result.removedBytes).toBeGreaterThan(0);
  expect(await readFile(used.path,"utf8")).toBe("used");await expect(stat(unused.path)).rejects.toThrow();await expect(stat(orphan)).rejects.toThrow();
  if(typeof removedImages!=="string")for(const image of removedImages){if(image.type==="image")await expect(store.readImage(image)).rejects.toThrow();}
  if(typeof images!=="string")for(const image of images){if(image.type==="image"){expect((await store.readImage(image)).length).toBeGreaterThan(0);expect((await store.readImageSource(image)).length).toBeGreaterThan(0);}}
 });
});

test("active Root protects draft attachments and all project cleanup",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const release=await acquireProjectActivity(storage,cwd);
  try{
   expect((await inspectStorage(storage,cwd,true)).activeProcesses).toContain(process.pid);
   await expect(cleanStorage(storage,cwd)).rejects.toThrow("Project is active");
  }finally{await release();}
  expect((await inspectStorage(storage,cwd)).activeProcesses).toEqual([]);
 });
});

test("damaged references block deletion and remain inspectable",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const writer=createSessionPersistence(storage,cwd,"session");
  await writer.save({cwd,sessionId:"session",model:"test",history:[{role:"user",origin:"user",content:"hello"}],todos:[],permissionMode:"ask",});
  const {getSessionSnapshotPath}=await import("../../src/session/paths.js");
  const path=getSessionSnapshotPath(storage,cwd,"session");await writeFile(path,"broken");
  const preview=await inspectStorage(storage,cwd,true);expect(preview.issues.length).toBeGreaterThan(0);
  await expect(cleanStorage(storage,cwd)).rejects.toThrow("reference errors");expect(await readFile(path,"utf8")).toBe("broken");
});
});

test("subagent state protects its artifacts and structurally corrupt JSON blocks cleanup", async () => {
 await withTempProject(async (cwd, storage) => {
  const persistence = createSessionPersistence(storage, cwd, "session");
  await persistence.save({cwd, sessionId:"session", model:"test", history:[{role:"user", origin:"user", content:"inspect"}], todos:[], permissionMode:"ask", });
  const store = createToolResultStore(storage, cwd, "session");
  const artifact = await store.persistText({toolCallId:"child", toolName:"bash", content:"child output"});
  const transcript = new SubagentTranscriptWriter(storage, cwd, "session", "agent");
  const timestamp = new Date().toISOString();
  await transcript.append({type:"start", version:1, timestamp, parentSessionId:"session", parentToolCallId:"call",
   agentId:"agent", agentType:"Explore", description:"inspect", model:"test", cwd, allowedTools:[]});
  await transcript.append({type:"snapshot", timestamp, history:[{role:"user", origin:"user", content:artifact.path}],
   result:{agentId:"agent", agentType:"Explore", description:"inspect", reply:"ok", reason:"completed", iterations:1, toolUseCount:1, durationMs:1}});
  const preview = await inspectStorage(storage, cwd, true);
  expect(preview.issues).toEqual([]);
  expect(preview.candidates.some(candidate => candidate.path === artifact.path)).toBe(false);
  await writeFile(join(dirname(transcript.path), "state.json"), "{}");
  await expect(cleanStorage(storage, cwd)).rejects.toThrow("reference errors");
  expect(await readFile(artifact.path, "utf8")).toBe("child output");
 });
});
