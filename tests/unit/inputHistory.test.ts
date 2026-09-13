import {expect,test} from "bun:test";
import {mkdir,readFile,stat,symlink,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {createInputHistoryStore} from "../../src/session/inputHistory/index.js";
import {getSessionInputHistoryPath} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";

test("history belongs to a session and retains recent unique inputs",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const store=createInputHistoryStore(storage);
  await store.append(cwd,"a","one");await store.append(cwd,"a","two");await store.append(cwd,"a","one");
  for(let i=0;i<3;i++)await store.append(cwd,"b",`${i}:`+"x".repeat(800_000));
  expect(await store.load(cwd,"a")).toEqual(["two","one"]);
  expect((await stat(getSessionInputHistoryPath(storage,cwd,"b"))).size).toBeLessThanOrEqual(2*1024*1024);
  expect((await stat(getSessionInputHistoryPath(storage,cwd,"a"))).mode&0o777).toBe(0o600);
 });
});
test("concurrent stores preserve additions, with a physical 100 entry limit",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const a=createInputHistoryStore(storage),b=createInputHistoryStore(storage);
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).append(cwd,"a",`line-${i}`)));
  expect(await a.load(cwd,"a")).toHaveLength(12);
  for(let i=0;i<110;i++)await a.append(cwd,"a",`new-${i}`);
  const values=await a.load(cwd,"a");expect(values).toHaveLength(100);expect(values[0]).toBe("new-10");
  await a.append(cwd,"a","x".repeat(1024*1024+1));expect(await a.load(cwd,"a")).toEqual(values);
 });
});
test("symlink files and malformed data fail closed without modifying their targets",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const store=createInputHistoryStore(storage),path=getSessionInputHistoryPath(storage,cwd,"a");
  await mkdir(dirname(path),{recursive:true});
  const target=join(cwd,"private");await writeFile(target,"keep");await symlink(target,path);
  await expect(store.append(cwd,"a","bad")).rejects.toThrow();await expect(store.load(cwd,"a")).rejects.toThrow();
  expect(await readFile(target,"utf8")).toBe("keep");
  const bad=getSessionInputHistoryPath(storage,cwd,"b");await mkdir(dirname(bad));await writeFile(bad,"broken");
  await expect(store.append(cwd,"b","bad")).rejects.toThrow("Invalid");expect(await readFile(bad,"utf8")).toBe("broken");
 });
});
test("non-regular files are rejected without blocking",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const path=getSessionInputHistoryPath(storage,cwd,"a");await mkdir(dirname(path),{recursive:true});
  if(process.platform!=="win32"){
   const command=Bun.spawnSync(["mkfifo",path]);expect(command.exitCode).toBe(0);
   await expect(createInputHistoryStore(storage).load(cwd,"a")).rejects.toThrow("regular");
  }
 });
});
