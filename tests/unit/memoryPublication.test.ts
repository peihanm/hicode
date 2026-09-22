import {expect, test} from "bun:test";
import {readFile, writeFile, symlink, unlink, mkdir, access} from "node:fs/promises";
import {join} from "node:path";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {getMemoryStatePath, getMemoryWorkspacePaths} from "../../src/persistence/layout.js";
import {queueSource} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";
const signal = () => new AbortController().signal;
const draft = (key: string, sources: string[], content = "保持简洁") => ({key,name:key,description:"Preference",type:"feedback" as const,content,sources});

test("formal Markdown is the only content source; consumed facts have no duplicate body", async () => withTempProject(async (cwd,storage) => {
 const store=new MemoryPublicationStore(storage,cwd);
 expect(await store.claim(signal())).toBeUndefined();
 await queueSource(store,"brief","保持简洁");
 const job=(await store.claim(signal()))!;
 expect(await store.claim(signal())).toBeUndefined();
 await store.publish(job.lease,[draft("brief",job.lease.sourceIds)],signal());
 const path=(await store.prepareView({kind:"topic",key:"brief"}))!;
 expect(await readFile(path,"utf8")).toContain("保持简洁");
 expect(await readFile(getMemoryStatePath(store.directory),"utf8")).not.toContain("保持简洁");
 expect(store.snapshot().sources[0]!.content).toBe("");
 await writeFile(path,"人手改成更详细");
 expect(store.snapshot().topics[0]!.content).toBe("人手改成更详细");
 expect(store.snapshot().topics[0]!.sources).toEqual([]);
 await unlink(path);
 expect(await store.prepareView({kind:"topic",key:"brief"})).toBeNull();
 await store.prepareView({kind:"index"});
 expect(await readFile(join(store.directory,"MEMORY.md"),"utf8")).not.toContain("brief");
 expect(await new MemoryPublicationStore(storage,cwd).claim(signal())).toBeUndefined();
 await expect(access(path)).rejects.toThrow();
}));

for (const action of ["edit","delete"] as const) test(`external ${action} revokes an in-flight consolidation`, async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);
 const path=join(store.prepareTopicsDirectory(),"manual.md"); await writeFile(path,"manual rule");
 await queueSource(store,"new-fact","new evidence"); const job=(await store.claim(signal()))!;
 if(action==="edit") await writeFile(path,"new human rule"); else await unlink(path);
 await expect(store.publish(job.lease,[draft("manual",[],"old rule"),draft("new-fact",job.lease.sourceIds)],signal())).rejects.toThrow("lease");
 expect(store.snapshot().topics.map(t=>t.content)).toEqual(action==="edit"?["new human rule"]:[]);
}));

test("cancellation, forged references and altered leases cannot publish",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await queueSource(store,"brief","evidence");const job=(await store.claim(signal()))!;
 await expect(store.publish(job.lease,[draft("brief",["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"])],signal())).rejects.toThrow("unavailable source");
 await expect(store.publish({...job.lease,sourceIds:[]},[],signal())).rejects.toThrow("source set");
 await expect(store.publish({...job.lease,expiresAt:"2099-01-01T00:00:00.000Z"},[],signal())).rejects.toThrow("lease");
 const abort=new AbortController();abort.abort();
 await expect(store.publish(job.lease,[draft("brief",job.lease.sourceIds)],abort.signal)).rejects.toThrow();
 expect(store.snapshot().topics).toHaveLength(0); expect(store.snapshot().sources[0]?.consumed).toBe(false);
}));

test("topic and workflow symlinks fail closed without touching targets",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);const root=store.prepareTopicsDirectory();const target=join(cwd,"untouched");await writeFile(target,"sentinel");
 await symlink(target,join(root,"brief.md"));expect(()=>store.snapshot()).toThrow();await unlink(join(root,"brief.md"));
 await symlink(target,getMemoryStatePath(store.directory));expect(()=>store.snapshot()).toThrow();expect(await readFile(target,"utf8")).toBe("sentinel");
}));

test("recovery removes only stale UUID workspaces",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await queueSource(store,"brief","evidence");const job=(await store.claim(signal()))!;
 const active=getMemoryWorkspacePaths(store.directory,job.lease.id).root;
 const stale=getMemoryWorkspacePaths(store.directory,"00000000-0000-0000-0000-000000000000").root;
 await mkdir(active,{recursive:true});await mkdir(stale,{recursive:true});await writeFile(join(store.directory,"legacy.md"),"old");
 await store.recoverWorkspaces(signal());await access(active);await access(join(store.directory,"legacy.md"));await expect(access(stale)).rejects.toThrow();
}));

test("unrelated queued frames preserve the current lease",async()=>withTempProject(async(cwd,storage)=>{
 const a=new MemoryPublicationStore(storage,cwd),b=new MemoryPublicationStore(storage,cwd);await queueSource(a,"first","one");const job=(await a.claim(signal()))!;
 await b.offerFrame({id:"c".repeat(64),sessionId:"s",messageHashes:["d".repeat(64)],omitted:0},signal());
 await a.publish(job.lease,[draft("first",job.lease.sourceIds)],signal());expect((await b.claimExtraction(signal()))?.frames).toHaveLength(1);
}));

test("completed frame retention stays bounded without replaying recent inputs",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);const {createHash}=await import("node:crypto");
 const frame=(i:number)=>({id:createHash("sha256").update(String(i)).digest("hex"),sessionId:"s",messageHashes:["a".repeat(64)],omitted:0});
 for(let start=0;start<1004;start+=4){for(let j=0;j<4;j++)await store.offerFrame(frame(start+j),signal());const job=(await store.claimExtraction(signal()))!;await store.finishExtraction(job.lease,job.frames.map(frame=>({frame,facts:[],unavailable:false})),signal());}
 expect(store.snapshot().frames).toHaveLength(128);expect(store.snapshot().completedFrames).toHaveLength(876);
 await store.offerFrame(frame(0),signal());await store.offerFrame(frame(1003),signal());expect(await store.claimExtraction(signal())).toBeUndefined();
}),20000);

test("deleted topic source receipts survive workflow updates and block replay",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await queueSource(store,"brief","evidence");const job=(await store.claim(signal()))!;
 await store.publish(job.lease,[draft("brief",job.lease.sourceIds)],signal());await unlink(join(store.directory,"topics/brief.md"));
 await store.offerFrame({id:"b".repeat(64),sessionId:"s",messageHashes:["a".repeat(64)],omitted:0},signal());
 const raw=JSON.parse(await readFile(getMemoryStatePath(store.directory),"utf8"));raw.frames=[];raw.completedFrames=[];raw.retiredSources=[];await writeFile(getMemoryStatePath(store.directory),JSON.stringify(raw));
 await queueSource(store,"brief","evidence");expect(await store.claim(signal())).toBeUndefined();expect(store.snapshot().revoked).toHaveLength(1);expect(store.snapshot().topics).toEqual([]);
}));

test("interrupted file publication never replays a batch after a human deletes a partial result",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await queueSource(store,"brief","old fact");await store.claim(signal());
 const path=getMemoryStatePath(store.directory);const raw=JSON.parse(await readFile(path,"utf8"));raw.lease.publishing=true;raw.lease.expiresAt="2000-01-01T00:00:00.000Z";await writeFile(path,JSON.stringify(raw));
 const topic=join(store.prepareTopicsDirectory(),"brief.md");await writeFile(topic,"partial output");await unlink(topic);
 const restored=new MemoryPublicationStore(storage,cwd);expect(restored.snapshot().lastIssue).toContain("interrupted");
 expect(await restored.claim(signal())).toBeUndefined();expect(restored.snapshot().sources).toEqual([]);expect(restored.snapshot().revoked).toHaveLength(1);await expect(access(topic)).rejects.toThrow();
}));

test("a live publishing lease is not falsely reported as interrupted; failed owner does not replay it",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await queueSource(store,"brief","fact");const job=(await store.claim(signal()))!;
 const path=getMemoryStatePath(store.directory);const raw=JSON.parse(await readFile(path,"utf8"));raw.lease.publishing=true;await writeFile(path,JSON.stringify(raw));
 await writeFile(join(store.prepareTopicsDirectory(),"brief.md"),"partial file");
 expect(store.snapshot().lastIssue).toBeUndefined();expect(store.snapshot().lease?.publishing).toBe(true);expect(await store.claim(signal())).toBeUndefined();
 await store.fail(job.lease,"failed");expect(store.snapshot().lastIssue).toContain("will not be replayed");expect(store.snapshot().sources).toHaveLength(0);expect(store.snapshot().topics[0]?.content).toBe("partial file");
}));
