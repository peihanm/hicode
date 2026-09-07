import {describe, expect, test} from "bun:test";
import {readFile, readdir, stat, writeFile, unlink, symlink} from "node:fs/promises";
import {join} from "node:path";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {loadSession, saveSessionSnapshot, saveSessionTurnCheckpoint, listSessionIndex, listSessionTurnCheckpoints} from "../../src/session/index.js";
import {getSessionLogPath} from "../../src/session/paths.js";
import {getSessionStorageDirectory, getSessionContentDirectory} from "../../src/persistence/index.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

const state = {todos: [], permissionMode: "default", collaborationMode: "build", uiEvents: []} as const;
async function directoryBytes(path: string): Promise<number> {
    let size = 0;
    for (const item of await readdir(path, {withFileTypes: true})) {
        const child = join(path, item.name);
        size += item.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
    }
    return size;
}

describe("Session recovery and storage boundaries", () => {
    test("first interrupted turn has a loadable pre-turn snapshot and index", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const session = createRootSessionRuntime({resources, resumed: false, seed: {
                    sessionId: "first", history: [], compactState: createCompactState(),
                }});
                await session.beginCheckpoint("first interrupted request", state);
                const head = session.fileCheckpoints.getHead();
                const loaded = loadSession(storage, cwd, "first", resources.model)!;
                expect(loaded).not.toBeNull();
                expect(listSessionIndex(storage, cwd)[0]?.summary).toBe("first interrupted request");
                const resumed = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                await resumed.initialize();
                expect(resumed.fileCheckpoints.getHead()).toEqual(head);
                expect(resumed.history.at(-1)?.content).toContain("first interrupted request");
            } finally { await resources.close(); }
        });
    });

    test("another initialized writer cannot fork from its now-stale head", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const first = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: "writers", history: [], compactState: createCompactState()}});
                await first.beginCheckpoint("A", state);
                await first.settleCheckpoint();
                await saveSessionSnapshot(storage, first.createSnapshot({...state, allowEmpty: true}));
                const loaded = loadSession(storage, cwd, "writers", resources.model)!;
                const second = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                await second.initialize();
                await first.beginCheckpoint("B", state);
                const head = first.fileCheckpoints.getHead();
                await second.fileCheckpoints.listCheckpoints();
                await expect(second.beginCheckpoint("C", state)).rejects.toThrow("head 已变化");
                expect((await first.fileCheckpoints.listCheckpoints())[0]?.checkpointId).toBe(head.checkpointId!);
            } finally { await resources.close(); }
        });
    });

    test("rewind branch saved successfully resumes, an unsaved branch does not", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const session = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: "rewind", history: [], compactState: createCompactState()}});
                await session.beginCheckpoint("A", state);
                await session.settleCheckpoint();
                await saveSessionSnapshot(storage, session.createSnapshot({...state, allowEmpty: true}));
                const stale = loadSession(storage, cwd, "rewind", resources.model)!;
                const rewindId = session.fileCheckpoints.getHead().checkpointId!;
                await session.fileCheckpoints.restoreCode(rewindId);
                const invalid = createRootSessionRuntime({resources, resumed: true, seed: {...stale, compactState: createCompactState()}});
                await expect(invalid.initialize()).rejects.toThrow();
                await saveSessionSnapshot(storage, session.createSnapshot({...state, allowEmpty: true}));
                await session.fileCheckpoints.completeRestore(rewindId);
                const loaded = loadSession(storage, cwd, "rewind", resources.model)!;
                const valid = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                await valid.initialize();
                await valid.beginCheckpoint("new branch", state);
                expect((await valid.fileCheckpoints.listCheckpoints())[0]?.prompt).toBe("new branch");
            } finally { await resources.close(); }
        });
    });

    test.each([false, true])("A saved, B committed without snapshot (settled=%s), restart C retains B lineage", async settled => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const session = createRootSessionRuntime({resources, resumed: false, seed: {
                    sessionId: "crash", history: [{role: "user", content: "A"}], compactState: createCompactState(),
                }});
                await session.initialize();
                await session.beginCheckpoint("A", state);
                await session.settleCheckpoint();
                const a = session.fileCheckpoints.getHead().checkpointId!;
                await saveSessionSnapshot(storage, session.createSnapshot(state));
                await session.beginCheckpoint("B", state);
                const b = session.fileCheckpoints.getHead().checkpointId!;
                await session.fileCheckpoints.beforeWrite({afterContent: "B committed", path: join(cwd, "b.txt"), content: null, toolCallId: "b-write"});
                await writeFile(join(cwd, "b.txt"), "B committed");
                await session.fileCheckpoints.afterWrite({path: join(cwd, "b.txt"), content: "B committed", toolCallId: "b-write"});
                if (settled) await session.settleCheckpoint();
                const loaded = loadSession(storage, cwd, "crash", resources.model)!;
                const recovered = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                await recovered.initialize();
                await recovered.beginCheckpoint("C", state);
                const records = await recovered.fileCheckpoints.listCheckpoints();
                expect(records.map(record => record.checkpointId)).toContain(b);
                expect(records.find(record => record.checkpointId === b)?.status).toBe("interrupted");
                expect(records[0]?.parentCheckpointId).toBe(b);
                expect(recovered.history.some(message => message.content?.includes("恢复"))).toBe(true);
                expect((await recovered.fileCheckpoints.previewRestore(a)).files.map(file => file.relativePath)).toContain("b.txt");
            } finally { await resources.close(); }
        });
    });

    test("unpaired file checkpoint blocks resumed writes", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const seed = {sessionId: "unpaired", history: [], compactState: createCompactState()};
                const session = createRootSessionRuntime({resources, seed, resumed: false});
                await session.initialize();
                await session.fileCheckpoints.beginTurn({prompt: "created before conversation capture"});
                const recovered = createRootSessionRuntime({resources, seed, resumed: true});
                await expect(recovered.initialize()).rejects.toThrow();
                await expect(recovered.beginCheckpoint("must not run", state)).rejects.toThrow();
            } finally { await resources.close(); }
        });
    });

    test("before-only recovery stays incomplete across repeated restarts", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const session = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: "before-only", history: [], compactState: createCompactState()}});
                await session.beginCheckpoint("interrupted commit", state);
                const checkpointId = session.fileCheckpoints.getHead().checkpointId!;
                const path = join(cwd, "uncertain.txt");
                await session.fileCheckpoints.beforeWrite({afterContent: null, path, content: null, toolCallId: "uncertain-write"});
                await writeFile(path, "possibly committed");
                for (let n = 0; n < 3; n++) {
                    const loaded = loadSession(storage, cwd, "before-only", resources.model)!;
                    const resumed = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                    await resumed.initialize();
                    const records = await resumed.fileCheckpoints.listCheckpoints();
                    expect(records[0]).toMatchObject({status: "interrupted", fileCoverage: "incomplete"});
                    expect(records[0]?.coverageWarnings).toHaveLength(1);
                    expect((await resumed.fileCheckpoints.previewRestore(checkpointId)).conflicts[0]?.reason).toBe("incomplete_checkpoint");
                }
                expect(await readFile(path, "utf8")).toBe("possibly committed");
            } finally { await resources.close(); }
        });
    });

    test("repeated large conversation is stored once across rewind points and saves", async () => {
        await withTempProject(async (cwd, storage) => {
            const input = {cwd, sessionId: "dedup", model: "glm-test", history: [{role: "user" as const, content: "x".repeat(512 * 1024)}],
                todos: [], permissionMode: "default" as const, collaborationMode: "build" as const};
            for (let n = 0; n < 20; n++) {
                await saveSessionTurnCheckpoint(storage, {...input, checkpointId: `c${n}`, branchId: "branch", prompt: `turn ${n}`});
                await saveSessionSnapshot(storage, input);
            }
            expect(await directoryBytes(getSessionStorageDirectory(storage, cwd, input.sessionId))).toBeLessThan(2 * 1024 * 1024);
            expect(loadSession(storage, cwd, input.sessionId, input.model)?.history.at(-1)?.content).toBe(input.history[0]!.content);
        });
    });

    test("Resume index listing does not open conversation logs", async () => {
        await withTempProject(async (cwd, storage) => {
            await saveSessionSnapshot(storage, {cwd, sessionId: "indexed", model: "glm-test", history: [{role: "user", content: "indexed prompt"}],
                todos: [], permissionMode: "default", collaborationMode: "build"});
            await writeFile(getSessionLogPath(storage, cwd, "indexed"), "corrupt conversation\n");
            expect(listSessionIndex(storage, cwd).map(entry => entry.sessionId)).toEqual(["indexed"]);
            expect(loadSession(storage, cwd, "indexed", "glm-test")).toBeNull();
        });
    });

    test("byte retention crosses the old limit and keeps both rewind windows aligned", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
            try {
                const session = createRootSessionRuntime({resources, resumed: false, seed: {
                    sessionId: "capacity", history: [], compactState: createCompactState(),
                }});
                await session.initialize();
                for (let n = 0; n < 18; n++) {
                    session.replaceConversation([{role: "user", content: `${n}:` + "x".repeat(8 * 1024 * 1024 - 100)}], createCompactState());
                    await session.beginCheckpoint(`large turn ${n}`, state);
                    await session.settleCheckpoint();
                    await saveSessionSnapshot(storage, session.createSnapshot(state));
                }
                const conversations = listSessionTurnCheckpoints(storage, cwd, "capacity");
                const files = await session.fileCheckpoints.listCheckpoints();
                expect(conversations.length).toBeLessThan(18);
                expect(conversations.map(record => record.checkpointId)).toEqual(files.map(record => record.checkpointId).reverse());
                expect(loadSession(storage, cwd, "capacity", resources.model)?.history.at(-1)?.content?.startsWith("17:")).toBe(true);
                expect(await directoryBytes(getSessionContentDirectory(storage, cwd, "capacity"))).toBeLessThan(128 * 1024 * 1024);
            } finally { await resources.close(); }
        });
    }, 60_000);

    test("a near-limit current conversation can replace a different near-limit pre-turn state", async () => {
        await withTempProject(async (cwd, storage) => {
            const input = {cwd, sessionId: "large-current", model: "glm-test", todos: [],
                permissionMode: "default" as const, collaborationMode: "build" as const};
            for (let turn = 0; turn < 2; turn++) {
                const history = Array.from({length: 8}, (_, n) => ({role: "user" as const,
                    content: `${turn}:${n}:` + "x".repeat(8 * 1024 * 1024 - 100)}));
                await saveSessionTurnCheckpoint(storage, {...input, history, checkpointId: `large-${turn}`,
                    branchId: "branch", prompt: "large"});
                await saveSessionSnapshot(storage, {...input, history});
                expect(loadSession(storage, cwd, input.sessionId, input.model)?.history.at(-1)?.content?.startsWith(`${turn}:7:`)).toBe(true);
            }
            expect(listSessionTurnCheckpoints(storage, cwd, input.sessionId)).toHaveLength(1);
        });
    }, 60_000);

    test.each(["tamper", "missing", "symlink", "traversal", "duplicate-budget"])("content reference %s fails closed", async corruption => {
        await withTempProject(async (cwd, storage) => {
            const input = {cwd, sessionId: "blocks", model: "glm-test", history: [{role: "user" as const, content: "x".repeat(1024 * 1024)}],
                todos: [], permissionMode: "default" as const, collaborationMode: "build" as const};
            await saveSessionSnapshot(storage, input);
            const path = getSessionLogPath(storage, cwd, "blocks");
            const reference = JSON.parse(await readFile(path, "utf8")) as {conversation: string[]};
            const block = join(getSessionContentDirectory(storage, cwd, "blocks"), `${reference.conversation[0]}.json`);
            if (corruption === "tamper") await writeFile(block, '{}');
            if (corruption === "missing") await unlink(block);
            if (corruption === "symlink") {
                const outside = join(cwd, "outside.json");
                await writeFile(outside, await readFile(block));
                await unlink(block);
                await symlink(outside, block);
            }
            if (corruption === "traversal" || corruption === "duplicate-budget") {
                reference.conversation = corruption === "traversal" ? ["../../outside"] : Array(65).fill(reference.conversation[0]);
                await writeFile(path, JSON.stringify(reference) + "\n");
            }
            expect(loadSession(storage, cwd, "blocks", input.model)).toBeNull();
            await expect(saveSessionSnapshot(storage, input)).rejects.toThrow();
        });
    });
});
