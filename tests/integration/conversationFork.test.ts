import {expect, test} from "bun:test";
import {mkdir, readFile, writeFile, symlink} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {forkSessionConversation, listRewindPoints} from "../../src/session/fork.js";
import {getCheckpointDirectory, getCheckpointManifestPath} from "../../src/checkpoints/paths.js";
import {loadSession, saveSessionTurnCheckpoint} from "../../src/session/index.js";
import {getSessionLogPath} from "../../src/session/paths.js";
import {createToolResultStore} from "../../src/toolResults/index.js";
import {buildPersistedToolResultMessage} from "../../src/toolResults/format.js";
import {referencedResultPaths} from "../../src/toolResults/references.js";
import {createTestContext} from "../helpers/testContext.js";
import type {Message} from "../../src/llm/types.js";

for (const brokenFiles of [false, true]) test(`分支保留当前文件和原 Session，复制结果但不复制读取权限（文件记录损坏=${brokenFiles}）`, async () => {
    await withTempProject(async (cwd, storage) => {
        const source = createToolResultStore(storage, cwd, "source");
        const artifact = await source.persistText({toolCallId: "check", toolName: "bash", content: "assertion detail\n".repeat(5000)});
        const binary = await source.persistBinary({toolCallId: "image", toolName: "mcp__image", data: Buffer.from([0, 255, 1]), mimeType: "image/png"});
        const history: Message[] = [
            {role: "user", content: "previous"},
            {role: "assistant", content: null, tool_calls: [{id: "check", type: "function", function: {name: "bash", arguments: "{}"}}]},
            {role: "tool", tool_call_id: "check", content: buildPersistedToolResultMessage(artifact)},
            {role: "assistant", content: null, tool_calls: [{id: "image", type: "function", function: {name: "mcp__image", arguments: "{}"}}]},
            {role: "tool", tool_call_id: "image", content: JSON.stringify({content: [{type: "text", text: `[image saved to ${binary.path}; image/png; 3 bytes]`}]})},
        ];
        await saveSessionTurnCheckpoint(storage, {cwd, model: "test", sessionId: "source", checkpointId: "point", branchId: "source-branch",
            prompt: "下一步修改", history, todos: [], permissionMode: "bypassPermissions", collaborationMode: "build", uiEvents: []});
        const sourceLog = await readFile(getSessionLogPath(storage, cwd, "source"), "utf8");
        const path = join(cwd, "app.txt"); await writeFile(path, "current disk");
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "source", enabled: true});
        if (brokenFiles) {
            const directory = getCheckpointDirectory(storage, cwd, "source"); await mkdir(directory, {recursive: true});
            await writeFile(getCheckpointManifestPath(directory), "broken");
            expect((await listRewindPoints({storage, cwd, sessionId: "source", runtime}))[0]?.capture.kind).toBe("unavailable");
        }
        const fork = await forkSessionConversation({storage, cwd, model: "test", sessionId: "source", checkpointId: "point", permissionMode: "readOnly"});
        expect(fork.sessionId).not.toBe("source");
        expect(await readFile(path, "utf8")).toBe("current disk");
        expect(await readFile(getSessionLogPath(storage, cwd, "source"), "utf8")).toBe(sourceLog);
        const loaded = loadSession(storage, cwd, fork.sessionId, "test")!;
        expect(loaded.checkpointHead).toBeUndefined();
        expect(loaded.todos).toEqual([]);
        expect(loaded.permissionMode).toBe("readOnly");
        expect(loaded.queuedInputs[0]?.content).toBe("下一步修改");
        const target = createToolResultStore(storage, cwd, fork.sessionId);
        const [copiedPath] = [...referencedResultPaths(loaded.history)];
        expect(copiedPath).toStartWith(target.sessionDir);
        expect(await readFile(copiedPath!, "utf8")).toBe(await readFile(artifact.path, "utf8"));
        const binaryPath = [...referencedResultPaths(loaded.history)].find(path => path.endsWith(".bin"))!;
        expect(binaryPath).toStartWith(target.sessionDir);
        expect(await readFile(binaryPath)).toEqual(Buffer.from([0, 255, 1]));
        await expect(target.resolveFile(artifact.path)).rejects.toThrow("无权");
        const resources = createTestRuntimeResources(cwd, {storage});
        try {
            const session = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
            await session.initialize();
            const fixture = createTestContext(cwd);
            const context = session.createContext({getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "default", collaborationMode: "build"}),signal: fixture.signal, host: {canUseTool: fixture.canUseTool, getPermissionRules: () => fixture.permissionRules,
                getPermissionMode: () => fixture.permissionMode, getCollaborationMode: () => fixture.collaborationMode,
                getPermissionPromptPolicy: () => fixture.permissionPromptPolicy, setPermissionMode: fixture.setPermissionMode,
                setCollaborationMode: fixture.setCollaborationMode, setTodos: fixture.setTodos}, onEvent() {}});
            expect(context.fileState.check(path, "current disk", {requireFullRead: true})).toEqual({ok: false, reason: "not_read"});
        } finally {await resources.close();}
    });
});

for (const invalid of ["other-session", "symlink"]) test(`分支拒绝 ${invalid} 工具引用且不发布新 Session`, async () => {
    await withTempProject(async (cwd, storage) => {
        const source = createToolResultStore(storage, cwd, invalid === "other-session" ? "private" : "source");
        const artifact = await source.persistText({toolCallId: "read", toolName: "bash", content: "private output"});
        if (invalid === "symlink") {
            const real = artifact.path + ".real";
            await Bun.write(real, "private output");
            const {unlink} = await import("node:fs/promises");
            await unlink(artifact.path); await symlink(real, artifact.path);
        }
        await saveSessionTurnCheckpoint(storage, {cwd, model: "test", sessionId: "source", checkpointId: "point", branchId: "branch",
            prompt: "continue", history: [{role: "assistant", content: null, tool_calls: [{id: "read", type: "function", function: {name: "bash", arguments: "{}"}}]},
                {role: "tool", tool_call_id: "read", content: buildPersistedToolResultMessage(artifact)}], todos: [], permissionMode: "default", collaborationMode: "build"});
        const original = await readFile(getSessionLogPath(storage, cwd, "source"), "utf8");
        await expect(forkSessionConversation({storage, cwd, model: "test", sessionId: "source", checkpointId: "point", permissionMode: "default"})).rejects.toThrow();
        expect(await readFile(getSessionLogPath(storage, cwd, "source"), "utf8")).toBe(original);
    });
});
