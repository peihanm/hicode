import {expect,test} from "bun:test";
import {readFile,writeFile} from "node:fs/promises";
import {createSessionPersistence,listSessionIndex,loadSession} from "../../src/session/storage.js";
import {getSessionIndexPath,getSessionSnapshotPath} from "../../src/session/paths.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {SaveSessionSnapshotInput} from "../../src/session/types.js";

test("index failure preserves committed content and leaves damaged records unchanged",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const input:SaveSessionSnapshotInput={cwd,sessionId:"good",model:"test",history:[{role:"user",origin:"user",content:"hello"}],todos:[],permissionMode:"ask",};
  const writer=createSessionPersistence(storage,cwd,"good");await writer.save(input);
  const bad={...input,sessionId:"bad"};await createSessionPersistence(storage,cwd,"bad").save(bad);
  await writeFile(getSessionSnapshotPath(storage,cwd,"bad"),"broken snapshot");
  await writeFile(getSessionIndexPath(storage,cwd),"broken index");
  await writer.save({...input,history:[...input.history,{role:"assistant",content:"saved after damage"}]});
  expect(writer.takeIssues()[0]).toContain("content was saved");
  expect(loadSession(storage,cwd,"good")?.history.at(-1)?.content).toBe("saved after damage");
  expect(()=>listSessionIndex(storage,cwd)).toThrow("corrupt session index");
  expect(await readFile(getSessionIndexPath(storage,cwd),"utf8")).toBe("broken index");
  expect(await readFile(getSessionSnapshotPath(storage,cwd,"bad"),"utf8")).toBe("broken snapshot");
 });
});

test("a long write in one Session does not hold another Session's content lock",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const {withSessionPersistenceLock}=await import("../../src/session/snapshotStore.js");
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const held=withSessionPersistenceLock(storage,cwd,"busy",async()=>{entered();await gate;});
  await ready;
  try{
   await createSessionPersistence(storage,cwd,"other").save({cwd,sessionId:"other",model:"test",history:[{role:"user",origin:"user",content:"independent"}],todos:[],permissionMode:"ask",});
   expect(loadSession(storage,cwd,"other")?.history.at(-1)?.content).toBe("independent");
  }finally{release();await held;}
 });
});
