import {expect, test} from "bun:test";
import {readFile, writeFile, symlink, unlink} from "node:fs/promises";
import {join} from "node:path";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {serializeMemoryNote} from "../../src/memory/note.js";
import {getMemoryPublicationPath} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";

const signal = () => new AbortController().signal;
const note = {operation: "remember", type: "feedback", content: "偏好简洁的文件结构"} as const;
const origin = (toolCallId: string) => ({kind: "explicit", sessionId: "session", turnId: "turn", toolCallId} as const);

test("Memory note 接收和正式发布使用同一版本，空队列不领取模型任务", async () => {
    await withTempProject(async (cwd, storage) => {
        const store = new MemoryPublicationStore(storage, cwd);
        expect(await store.claim(signal())).toBeUndefined();
        await store.acceptNote("structure", note, origin("note-1"), null, signal());
        expect(store.snapshot().sources[0]!.consumed).toBe(false);
        const request = await store.prepareView({kind: "note", key: "structure"});
        expect(await readFile(request!, "utf8")).toBe(serializeMemoryNote(note));
        const job = (await store.claim(signal()))!;
        expect(await store.claim(signal())).toBeUndefined();
        await store.publish(job.lease, [{key: "structure", name: "文件结构", description: "用户明确偏好", type: "feedback",
            content: note.content, sources: job.lease.sourceIds}], "保持结构简洁。", signal());
        const state = store.snapshot();
        expect(state.topics).toHaveLength(1);
        expect(state.sources[0]!.consumed).toBe(true);
        expect(state.lease).toBeUndefined();
        expect(await store.claim(signal())).toBeUndefined();
        const view = await store.prepareView({kind: "topic", key: "structure"});
        expect(await readFile(view!, "utf8")).toContain(note.content);
    });
});

test("纠正立即撤销旧内容，跨进程旧租约不能覆盖新 note；忘记只保留来源 hash", async () => {
    await withTempProject(async (cwd, storage) => {
        const a = new MemoryPublicationStore(storage, cwd);
        const b = new MemoryPublicationStore(storage, cwd);
        await a.acceptNote("structure", note, origin("first"), null, signal());
        const job = (await a.claim(signal()))!;
        await b.acceptNote("structure", {...note, operation: "correct", content: "修正后的偏好"}, origin("second"), serializeMemoryNote(note), signal());
        await expect(a.publish(job.lease, [], "旧总结", signal())).rejects.toThrow("lease expired");
        expect(a.snapshot().sources.map(source => source.content)).toEqual(["修正后的偏好"]);
        expect(await b.forget("structure", signal())).toBe(true);
        const raw = await readFile(getMemoryPublicationPath(a.directory), "utf8");
        expect(raw).not.toContain(note.content);
        expect(raw).not.toContain("修正后的偏好");
        expect(a.snapshot().revoked).toHaveLength(2);
        expect(await a.prepareView({kind: "note", key: "structure"})).toBeNull();
    });
});

test("过期观察、取消、伪造引用与 publication symlink 均保留原版本", async () => {
    await withTempProject(async (cwd, storage) => {
        const store = new MemoryPublicationStore(storage, cwd);
        await store.acceptNote("structure", note, origin("first"), null, signal());
        await expect(store.acceptNote("structure", note, origin("stale"), null, signal())).rejects.toThrow("changed");
        const controller = new AbortController(); controller.abort();
        await expect(store.acceptNote("other", note, origin("cancelled"), null, controller.signal)).rejects.toThrow();
        const job = (await store.claim(signal()))!;
        await expect(store.publish(job.lease, [{key: "structure", name: "伪造", description: "伪造", type: "feedback", content: "伪造",
            sources: ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"]}], "", signal())).rejects.toThrow("unavailable source");
        const before = store.snapshot();
        const path = getMemoryPublicationPath(store.directory);
        const outside = join(cwd, "untouched"); await writeFile(outside, "sentinel");
        await unlink(path); await symlink(outside, path);
        await expect(store.forget("structure", signal())).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe("sentinel");
        expect(before.topics).toHaveLength(0);
        expect(before.sources).toHaveLength(1);
    });
});

test("恢复只清理私有失效 UUID 工作区，不删除当前租约或旧 Markdown",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);const signal=new AbortController().signal;
 await store.acceptNote("brief",{operation:"remember",type:"feedback",content:"简洁"},{kind:"explicit",sessionId:"s",turnId:"t",toolCallId:"w"},null,signal);
 const current=(await store.claim(signal))!;
 const {getMemoryWorkspacePaths}=await import("../../src/persistence/layout.js");
 const {mkdir,writeFile,access}=await import("node:fs/promises");
 const active=getMemoryWorkspacePaths(store.directory,current.lease.id).root;const stale=getMemoryWorkspacePaths(store.directory,"00000000-0000-0000-0000-000000000000").root;
 await mkdir(active,{recursive:true});await mkdir(stale,{recursive:true});await writeFile(join(store.directory,"legacy.md"),"old");await store.recoverWorkspaces(signal);await access(active);await access(join(store.directory,"legacy.md"));await expect(access(stale)).rejects.toThrow();
}));

test("持有 lease ID 也不能更改领取的来源集合或时限",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await store.acceptNote("brief",note,origin("claim"),null,signal());const job=(await store.claim(signal()))!;
 await expect(store.publish({...job.lease,sourceIds:[]},[],"伪造消费",signal())).rejects.toThrow("source set");
 await expect(store.publish({...job.lease,expiresAt:"2099-01-01T00:00:00.000Z"},[],"延长期限",signal())).rejects.toThrow("lease");
 expect(store.snapshot().sources[0]?.consumed).toBe(false);expect(store.snapshot().lease?.id).toBe(job.lease.id);
}));

test("无关 note/frame 追加保留当前整理租约，新来源留待下一批", async () => withTempProject(async (cwd, storage) => {
    const a = new MemoryPublicationStore(storage, cwd);
    const b = new MemoryPublicationStore(storage, cwd);
    await a.acceptNote("first", note, origin("first"), null, signal());
    const job = (await a.claim(signal()))!;
    await b.acceptNote("second", note, origin("second"), null, signal());
    await b.offerFrame({id: "a".repeat(64), sessionId: "session", messageHashes: ["b".repeat(64)], omitted: 0}, signal());
    await a.publish(job.lease, [{key: "first", name: "first", description: "first", type: "feedback", content: note.content,
        sources: job.lease.sourceIds}], "first", signal());
    expect(a.snapshot().sources.filter(source => !source.consumed).map(source => source.key)).toEqual(["second"]);
    const extraction = (await a.claimExtraction(signal()))!;
    await b.offerFrame({id: "c".repeat(64), sessionId: "session", messageHashes: ["d".repeat(64)], omitted: 0}, signal());
    await a.finishExtraction(extraction.lease, extraction.frames.map(frame => ({frame, facts: [], unavailable: false})), signal());
    expect(a.snapshot().frames.filter(frame => frame.status === "pending").map(frame => frame.id)).toEqual(["c".repeat(64)]);
}));

test("超过 1000 个无输出 frame 可继续入队，近期已消费输入不重新提取", async () => withTempProject(async (cwd, storage) => {
    const store = new MemoryPublicationStore(storage, cwd);
    const {createHash} = await import("node:crypto");
    const frame = (index: number) => ({id: createHash("sha256").update(String(index)).digest("hex"), sessionId: "session", messageHashes: ["a".repeat(64)], omitted: 0});
    for (let start = 0; start < 1004; start += 4) {
        for (let offset = 0; offset < 4; offset++) await store.offerFrame(frame(start + offset), signal());
        const job = (await store.claimExtraction(signal()))!;
        await store.finishExtraction(job.lease, job.frames.map(frame => ({frame, facts: [], unavailable: false})), signal());
    }
    expect(store.snapshot().frames).toHaveLength(128);
    expect(store.snapshot().completedFrames).toHaveLength(876);
    await store.offerFrame(frame(0), signal());
    await store.offerFrame(frame(1003), signal());
    expect(await store.claimExtraction(signal())).toBeUndefined();
    await store.offerFrame(frame(1004), signal());
    expect((await store.claimExtraction(signal()))?.frames).toHaveLength(1);
}), 20000);

test("GC 保留正式主题证据，遗忘凭据不随消费窗口淘汰", async () => withTempProject(async (cwd, storage) => {
    const store = new MemoryPublicationStore(storage, cwd);
    const frame = {id: "a".repeat(64), sessionId: "session", messageHashes: ["b".repeat(64)], omitted: 0};
    const fact = {key: "past", type: "feedback" as const, content: "旧偏好", basis: "user-stated" as const, sources: frame.messageHashes};
    await store.offerFrame(frame, signal());
    const extraction = (await store.claimExtraction(signal()))!;
    await store.finishExtraction(extraction.lease, [{frame: extraction.frames[0]!, facts: [fact, {...fact, key: "discarded", content: "临时事实"}], unavailable: false}], signal());
    const job = (await store.claim(signal()))!;
    const source = job.baseline.sources.find(source => source.key === "past")!;
    await store.publish(job.lease, [{key: "past", name: "past", description: "past", type: "feedback", content: fact.content, sources: [source.id]}], "summary", signal());
    expect(store.snapshot().sources.map(source => source.id)).toEqual([source.id]);
    expect(store.snapshot().retiredSources).toHaveLength(1);
    expect(store.snapshot().summary).toBe("");
    await store.forget("past", signal());
    const state = store.snapshot();
    // Simulate this old input falling outside ordinary receipt retention; revocation remains.
    state.frames = []; state.completedFrames = []; state.retiredSources = [];
    await writeFile(getMemoryPublicationPath(store.directory), JSON.stringify(state));
    await store.offerFrame(frame, signal());
    const replay = (await store.claimExtraction(signal()))!;
    await store.finishExtraction(replay.lease, [{frame: replay.frames[0]!, facts: [fact], unavailable: false}], signal());
    expect(store.snapshot().sources).toHaveLength(0);
    expect(store.snapshot().revoked).toHaveLength(1);
    expect(await store.claim(signal())).toBeUndefined();
}));
