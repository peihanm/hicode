import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {contentText} from "../../src/images/content.js";
import {describe, expect, test} from "bun:test";
import {readFile, readdir, stat, writeFile, unlink, symlink} from "node:fs/promises";
import {join} from "node:path";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {loadSession, listSessionIndex} from "../../src/session/index.js";
import {getSessionLogPath} from "../../src/session/paths.js";
import {getSessionStorageDirectory, getSessionContentDirectory} from "../../src/persistence/index.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

const state = {todos: [], permissionMode: "ask", collaborationMode: "build", uiEvents: []} as const;
async function directoryBytes(path: string): Promise<number> {
    let size = 0;
    for (const item of await readdir(path, {withFileTypes: true})) {
        const child = join(path, item.name);
        size += item.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
    }
    return size;
}

describe("Session recovery and storage boundaries", () => {

    test("首次请求在模型开始前保存，正常恢复不依赖任何文件快照", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd, {storage});
            try {
                const session = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: "first", history: [], compactState: createCompactState()}});
                await session.beginTurn("first interrupted request", state);
                await writeFile(join(cwd, "changed.txt"), "current file");
                const loaded = loadSession(storage, cwd, "first", resources.model)!;
                expect(loaded.history.at(-1)?.content).toBe("first interrupted request");
                const resumed = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                await resumed.initialize();
                await resumed.beginTurn("continue", state);
                resumed.endTurn();
                expect(await readFile(join(cwd, "changed.txt"), "utf8")).toBe("current file");
                expect(await readdir(getSessionStorageDirectory(storage, cwd, "first"))).not.toContain("checkpoints");
            } finally {await resources.close();}
        });
    });

    test("repeated large conversation is stored once across repeated saves", async () => {
        await withTempProject(async (cwd, storage) => {
            const input = {cwd, sessionId: "dedup", model: "glm-test", history: [{role: "user" as const, origin: "user" as const, content: "x".repeat(512 * 1024)}],
                todos: [], permissionMode: "ask" as const, collaborationMode: "build" as const};
            for (let n = 0; n < 20; n++) {
                await saveSessionSnapshot(storage, input);
            }
            expect(await directoryBytes(getSessionStorageDirectory(storage, cwd, input.sessionId))).toBeLessThan(2 * 1024 * 1024);
            expect(loadSession(storage, cwd, input.sessionId, input.model)?.history.at(-1)?.content).toBe(input.history[0]!.content);
        });
    });

    test("Resume index listing does not open conversation logs", async () => {
        await withTempProject(async (cwd, storage) => {
            await saveSessionSnapshot(storage, {cwd, sessionId: "indexed", model: "glm-test", history: [{role: "user", origin: "user" as const, content: "indexed prompt"}],
                todos: [], permissionMode: "ask", collaborationMode: "build"});
            await writeFile(getSessionLogPath(storage, cwd, "indexed"), "corrupt conversation\n");
            expect(listSessionIndex(storage, cwd).map(entry => entry.sessionId)).toEqual(["indexed"]);
            expect(loadSession(storage, cwd, "indexed", "glm-test")).toBeNull();
        });
    });

    test("a near-limit current conversation can replace a different near-limit pre-turn state", async () => {
        await withTempProject(async (cwd, storage) => {
            const input = {cwd, sessionId: "large-current", model: "glm-test", todos: [],
                permissionMode: "ask" as const, collaborationMode: "build" as const};
            for (let turn = 0; turn < 2; turn++) {
                const history = Array.from({length: 8}, (_, n) => ({role: "user" as const, origin: "user" as const,
                    content: `${turn}:${n}:` + "x".repeat(8 * 1024 * 1024 - 100)}));
                await saveSessionSnapshot(storage, {...input, history});
                expect(contentText(loadSession(storage, cwd, input.sessionId, input.model)?.history.at(-1)?.content).startsWith(`${turn}:7:`)).toBe(true);
            }
        });
    }, 60_000);

    test.each(["tamper", "missing", "symlink", "traversal", "duplicate-budget"])("content reference %s fails closed", async corruption => {
        await withTempProject(async (cwd, storage) => {
            const input = {cwd, sessionId: "blocks", model: "glm-test", history: [{role: "user" as const, origin: "user" as const, content: "x".repeat(1024 * 1024)}],
                todos: [], permissionMode: "ask" as const, collaborationMode: "build" as const};
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
