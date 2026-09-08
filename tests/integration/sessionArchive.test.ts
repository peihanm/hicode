import {contentText} from "../../src/images/content.js";
import {expect, test} from "bun:test";
import {readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {dirname, basename, join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactState} from "../../src/context/state.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {archiveIndexPath} from "../../src/session/archiveAccess.js";
import {createSessionArchiveAccess, prepareSessionArchive, readArchiveMessages} from "../../src/session/archive.js";
import {saveSessionCompaction} from "../../src/session/storage.js";
import {SessionContentStore} from "../../src/session/contentStore.js";
import {loadSession, saveSessionSnapshot, listSessionTurnCheckpoints} from "../../src/session/storage.js";
import {getSessionContentDirectory, type PillarStorageLayout} from "../../src/persistence/index.js";
import {getSessionLogPath} from "../../src/session/paths.js";
import type {ToolContextHost} from "../../src/runtime/toolContext.js";
import type {Message} from "../../src/llm/types.js";
import {forkSessionConversation} from "../../src/session/fork.js";
import {buildPersistedToolResultMessage} from "../../src/toolResults/format.js";
import {referencedResultPaths} from "../../src/toolResults/references.js";

const state = () => ({todos: [], uiEvents: [], permissionMode: "default" as const, collaborationMode: "build" as const});
const host: ToolContextHost = {
    canUseTool: async () => ({behavior: "deny", message: "No interactive approvals in tests"}), getPermissionRules: () => ({allow: [], ask: [], deny: []}),
    getPermissionMode: () => "default", getCollaborationMode: () => "build", getPermissionPromptPolicy: () => "never",
    setPermissionMode() {}, setCollaborationMode() {}, setTodos() {},
};

test("只有摘要 reminder 的候选也必须实际落盘，不能被普通快照的空摘要过滤静默跳过", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            const draft = f.ctx.sessionCompaction!.prepare(f.session.history);
            const compactState = {...createCompactState(), compactCount: 1, archives: [draft.record]};
            await saveSessionCompaction(storage, {...f.session.createSnapshot(state()), compactState,
                history: [{role: "user", content: "<system-reminder>summary</system-reminder>"}]}, draft, f.controller.signal);
            expect(loadSession(storage, cwd, f.session.sessionId, "glm-test")!.compactState?.archives).toHaveLength(1);
        } finally {await f.resources.close();}
    });
});

function fixture(cwd: string, storage: PillarStorageLayout, id = "archive-session") {
    const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
    const history: Message[] = [{role: "system", content: "system"},
        {role: "user", content: "决定：删除列必须明确选择，禁止默认丢弃\n" + "历史资料\n".repeat(2500)},
        {role: "assistant", content: "已确认", reasoning_content: "hidden-reasoning-must-not-be-archived"},
        {role: "user", content: "继续实现"}];
    const session = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: id, history, compactState: createCompactState()}});
    const controller = new AbortController();
    const ctx = session.createContext({signal: controller.signal, host, onEvent() {}, getSnapshotState: state});
    const compact = (summary = "继续实现删除列") => createCompactHistoryRunner({async generateSummary() {return summary;}})({
        history: session.history, ctx, tools: [], preTokenCount: 100_000, force: true,
    });
    const tool = (name: string, input: unknown) => resources.toolRuntime.executeTool(name, JSON.stringify(input), ctx, `test-${name}`);
    return {resources, session, ctx, controller, compact, tool};
}

test("连续五次压缩保留原文、工具配对及大结果，Resume 可用 read/grep 回查且不授予源码编辑凭证", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            const result = await f.session.toolResultStore.persistText({toolCallId: "test-1", toolName: "bash", content: "ERR_ASSERTION exact detail"});
            f.session.history.push({role: "assistant", content: null, tool_calls: [{id: "test-1", type: "function", function: {name: "bash", arguments: '{"command":"bun test"}'}}]},
                {role: "tool", tool_call_id: "test-1", content: buildPersistedToolResultMessage(result)});
            const original = structuredClone(f.session.history);
            const stale = f.session.createSnapshot(state());
            for (let n = 0; n < 5; n++) {
                if (n) f.session.history.push({role: "user", content: `后续 ${n}\n` + "新增资料\n".repeat(2500)});
                expect((await f.compact()).compacted).toBe(true);
            }
            await saveSessionSnapshot(storage, stale);
            const loaded = loadSession(storage, cwd, f.session.sessionId, "glm-test")!;
            expect(loaded.compactState?.archives).toHaveLength(5);
            const records = loaded.compactState!.archives!;
            const messages = readArchiveMessages(records[0]!, new SessionContentStore(storage, cwd, loaded.sessionId));
            const first = original[1];
            if (first?.role !== "user") throw new Error("Invalid fixture");
            expect(messages[0]).toEqual(first);
            expect(JSON.stringify(messages)).not.toContain("hidden-reasoning");
            expect([...referencedResultPaths(messages)]).toEqual([result.path]);
            expect(await readFile(result.path, "utf8")).toContain("ERR_ASSERTION");
            const resumed = createRootSessionRuntime({resources: f.resources, resumed: true, seed: {...loaded, compactState: loaded.compactState!}});
            const ctx = resumed.createContext({signal: f.controller.signal, host, onEvent() {}, getSnapshotState: state});
            const indexPath = archiveIndexPath(storage, cwd, loaded.sessionId, records[0]!.id);
            const index = await f.resources.toolRuntime.executeTool("read_file", JSON.stringify({path: indexPath}), ctx, "archive-index");
            expect(index.outcome).toBe("ok");
            expect(index.modelContent).toContain("其他当前分支档案索引");
            const part = indexPath.replace("-index.txt", "-1.txt");
            const found = await f.resources.toolRuntime.executeTool("grep", JSON.stringify({path: part, pattern: "禁止默认丢弃", context: 1}), ctx, "archive-grep");
            expect(found.outcome).toBe("ok");
            expect(found.modelContent).toContain("禁止默认丢弃");
            const read = await f.resources.toolRuntime.executeTool("read_file", JSON.stringify({path: part, limit: 10}), ctx, "archive-read");
            expect(read.outcome).toBe("ok");
            expect(ctx.fileState.check(part, await readFile(part, "utf8"), {requireFullRead: true})).toEqual({ok: false, reason: "not_read"});
            expect((await f.resources.toolRuntime.executeTool("write_file", JSON.stringify({path: part, content: "overwrite"}), ctx, "archive-write")).outcome).toBe("denied");
        } finally {await f.resources.close();}
    });
});

test("压缩提交失败或取消不替换原 History，不留下生效档案", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            await saveSessionSnapshot(storage, f.session.createSnapshot(state()));
            const log = getSessionLogPath(storage, cwd, f.session.sessionId);
            const originalLog = await readFile(log, "utf8");
            const before = structuredClone(f.session.history);
            const outside = join(cwd, "untouched.txt");
            await writeFile(outside, "sentinel");
            await unlink(log); await symlink(outside, log);
            expect((await f.compact()).compacted).toBe(false);
            expect(f.session.history).toEqual(before);
            expect(f.session.compactState.archives).toBeUndefined();
            expect(await readFile(outside, "utf8")).toBe("sentinel");
            await unlink(log); await writeFile(log, originalLog);
            const cancelled = createCompactHistoryRunner({async generateSummary() {f.controller.abort(); return "summary";}});
            await expect(cancelled({history: f.session.history, ctx: f.ctx, tools: [], preTokenCount: 100_000, force: true})).rejects.toThrow();
            expect(f.session.history).toEqual(before);
            expect(loadSession(storage, cwd, f.session.sessionId, "glm-test")!.compactState?.archives).toBeUndefined();
        } finally {await f.resources.close();}
    });
});

test("真实回滚选择对应档案，分支只复制该恢复点已有来源与结果", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            expect((await f.compact()).compacted).toBe(true);
            const first = f.session.compactState.archives![0]!;
            await f.session.beginCheckpoint("后续请求", state());
            const point = listSessionTurnCheckpoints(storage, cwd, f.session.sessionId).at(-1)!;
            f.session.history.push({role: "user", content: "未来分支私有内容\n" + "future\n".repeat(2500)});
            expect((await f.compact()).compacted).toBe(true);
            const future = f.session.compactState.archives![1]!;
            await f.session.settleCheckpoint();
            await saveSessionSnapshot(storage, f.session.createSnapshot(state()));
            const fork = await forkSessionConversation({storage, cwd, model: "glm-test", sessionId: f.session.sessionId, checkpointId: point.checkpointId, permissionMode: "default"});
            const loaded = loadSession(storage, cwd, fork.sessionId, "glm-test")!;
            expect(loaded.compactState!.archives).toHaveLength(1);
            const access = createSessionArchiveAccess(storage, cwd, fork.sessionId, () => loaded.compactState!);
            const forkIndex = archiveIndexPath(storage, cwd, fork.sessionId, loaded.compactState!.archives![0]!.id);
            expect(await access.resolve(forkIndex)).not.toBeNull();
            expect(JSON.stringify(loaded.history)).toContain(forkIndex);
            await expect(access.resolve(archiveIndexPath(storage, cwd, f.session.sessionId, first.id))).rejects.toThrow("其他 Session");
            expect((await f.session.restoreCheckpoint(point.checkpointId)).status).toBe("complete");
            expect(f.session.compactState.archives).toHaveLength(1);
            const after = createSessionArchiveAccess(storage, cwd, f.session.sessionId, () => f.session.compactState);
            await expect(after.resolve(archiveIndexPath(storage, cwd, f.session.sessionId, future.id))).rejects.toThrow("当前恢复分支");
            expect(await after.resolve(archiveIndexPath(storage, cwd, f.session.sessionId, first.id))).not.toBeNull();
        } finally {await f.resources.close();}
    });
});

test("档案正文损坏、未授权 Agent 与符号链接均 fail closed", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            expect((await f.compact()).compacted).toBe(true);
            const record = f.session.compactState.archives![0]!;
            const path = archiveIndexPath(storage, cwd, f.session.sessionId, record.id);
            const unprivileged = {...f.ctx, sessionArchives: undefined};
            expect((await f.resources.toolRuntime.executeTool("read_file", JSON.stringify({path}), unprivileged, "no-cap")).outcome).toBe("denied");
            expect((await f.tool("read_file", {path})).outcome).toBe("ok");
            const alias = join(cwd, "archive-alias");
            await symlink(dirname(path), alias);
            expect((await f.tool("read_file", {path: join(alias, basename(path))})).outcome).toBe("denied");
            await unlink(path); await symlink(join(cwd, "outside"), path);
            expect((await f.tool("read_file", {path})).outcome).toBe("denied");
            await unlink(path);
            const block = join(getSessionContentDirectory(storage, cwd, f.session.sessionId), record.messages[0]! + ".json");
            await writeFile(block, '{"kind":"message","value":{"role":"user","content":"tampered"}}');
            expect((await f.tool("read_file", {path})).outcome).toBe("denied");
            expect(loadSession(storage, cwd, f.session.sessionId, "glm-test")).toBeNull();
        } finally {await f.resources.close();}
    });
});

test("档案数量超限及竞争提交均拒绝发布；长 Unicode 原文分段可完整读取", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            const original = "细节😀".repeat(35_000);
            f.session.history[1] = {role: "user", content: original};
            expect((await f.compact()).compacted).toBe(true);
            const record = f.session.compactState.archives![0]!;
            const index = archiveIndexPath(storage, cwd, f.session.sessionId, record.id);
            const view = await f.ctx.sessionArchives!.resolve(index);
            const paths = (await readFile(view!.path, "utf8")).split("\n").filter(line => /-[0-9]+\.txt$/.test(line));
            expect(paths.length).toBeGreaterThan(1);
            let combined = "";
            for (const path of paths) {
                const part = await f.ctx.sessionArchives!.resolve(path);
                expect(part!.byteLength).toBeLessThanOrEqual(256 * 1024);
                combined += await readFile(path, "utf8");
            }
            expect(combined).toContain(original);
            const disposable = join(dirname(index), `${"f".repeat(64)}-1.txt`);
            await writeFile(disposable, Buffer.alloc(17 * 1024 * 1024));
            await f.ctx.sessionArchives!.resolve(index);
            await expect(readFile(disposable)).rejects.toMatchObject({code: "ENOENT"});
            let rebuilt = "";
            for (const path of paths) {
                const part = await f.ctx.sessionArchives!.resolve(path);
                rebuilt += await readFile(part!.path, "utf8");
            }
            expect(rebuilt).toBe(combined);
            const before = await readFile(getSessionLogPath(storage, cwd, f.session.sessionId), "utf8");
            const draft = prepareSessionArchive(storage, cwd, f.session.sessionId, [{role: "user", content: "other owner"}]);
            const competing = {...f.session.createSnapshot(state()), compactState: {...createCompactState(), compactCount: 2, archives: [draft.record]}};
            await expect(saveSessionCompaction(storage, competing, draft, f.controller.signal)).rejects.toThrow("base changed");
            const oversized = {...f.session.createSnapshot(state()), compactState: {...f.session.compactState,
                archives: Array.from({length: 129}, (_, index) => prepareSessionArchive(storage, cwd, f.session.sessionId, [{role: "user", content: `quota-${index}`}]).record)}};
            await expect(saveSessionSnapshot(storage, oversized)).rejects.toThrow("invalid");
            expect(await readFile(getSessionLogPath(storage, cwd, f.session.sessionId), "utf8")).toBe(before);
        } finally {await f.resources.close();}
    });
});

import {createCompactSummaryGenerator} from "../../src/context/compactSummary.js";
import {assistantText, createFakeLLM} from "../helpers/fakeLLM.js";

test("生产交接链校验引用、保留纠正原话，Resume 与 Fork 保持可回查来源", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage, "handoff-session");
        try {
            const correction = "允许显式丢弃，但默认不能丢弃";
            f.session.history.push({role: "user", content: correction}, {role: "assistant", content: "资料\n".repeat(10_000)},
                {role: "user", content: "继续实现"});
            let originalRef = "";
            const fake = createFakeLLM([options => {
                const match = contentText(options.messages[1]!.content).match(/\[source ([a-f0-9]{64}\/1); role=user\]/);
                expect(match).not.toBeNull();
                originalRef = match![1]!;
                expect(JSON.stringify(options.messages)).not.toContain("hidden-reasoning");
                return assistantText(JSON.stringify({version: 1,
                    objective: [{text: "完成删除列", sources: [originalRef], basis: "reported"}],
                    constraints: [{text: correction, sources: [originalRef.replace(/\/1$/, "/4")], basis: "reported"}],
                    decisions: [], files: [], verification: [], next: [{text: "读取删除弹窗后实现", sources: [], basis: "inferred"}]}));
            }]);
            const compact = createCompactHistoryRunner({generateSummary: createCompactSummaryGenerator({callLLM: fake.callLLM})});
            expect((await compact({history: f.session.history, ctx: f.ctx, tools: [], preTokenCount: 100_000, force: true})).compacted).toBe(true);
            expect(f.session.history.filter(message => message.role === "user" && message.content === correction)).toHaveLength(1);
            expect(f.session.history[1]!.content).toContain(`[[${originalRef}]]`);
            const loaded = loadSession(storage, cwd, f.session.sessionId, "glm-test")!;
            expect(loaded.history.slice(1)).toEqual(f.session.history.slice(1));
            await f.session.beginCheckpoint("fork", state());
            const point = listSessionTurnCheckpoints(storage, cwd, f.session.sessionId).at(-1)!;
            await f.session.settleCheckpoint();
            const fork = await forkSessionConversation({storage, cwd, model: "glm-test", sessionId: f.session.sessionId,
                checkpointId: point.checkpointId, permissionMode: "default"});
            const forked = loadSession(storage, cwd, fork.sessionId, "glm-test")!;
            expect(JSON.stringify(forked.history)).not.toContain(`[[${originalRef}]]`);
            expect(JSON.stringify(forked.history)).toContain(`[[${forked.compactState!.archives![0]!.id}/1]]`);
            const before = structuredClone(f.session.history);
            f.session.history.push({role: "assistant", content: "资料\n".repeat(10_000)});
            const beforeFailure = structuredClone(f.session.history);
            const bad = createCompactHistoryRunner({generateSummary: createCompactSummaryGenerator({callLLM: createFakeLLM([
                assistantText(JSON.stringify({version: 1, objective: [{text: "伪造", sources: [`${"f".repeat(64)}/1`], basis: "reported"}],
                    constraints: [], decisions: [], files: [], verification: [], next: []})),
            ]).callLLM})});
            const result = await bad({history: f.session.history, ctx: f.ctx, tools: [], preTokenCount: 100_000, force: true});
            expect(result.compacted).toBe(false);
            expect(result.message).toContain("不属于当前来源");
            expect(f.session.history).toEqual(beforeFailure);
            expect(f.session.compactState.archives).toHaveLength(1);
            expect(loadSession(storage, cwd, f.session.sessionId, "glm-test")!.history.slice(1)).toEqual(before.slice(1));
        } finally {await f.resources.close();}
    });
});

import {getCompactTarget} from "../../src/context/window.js";

test("五次完整生成链保留早期引用与逐轮纠正，缺失大结果不会触发历史命令回放", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage, "handoff-five");
        try {
            const artifact = await f.session.toolResultStore.persistText({toolCallId: "historical-test", toolName: "bash", content: "past assertion details"});
            f.session.history.push({role: "assistant", content: null, tool_calls: [{id: "historical-test", type: "function",
                function: {name: "bash", arguments: '{"command":"bun test"}'}}]},
                {role: "tool", tool_call_id: "historical-test", content: buildPersistedToolResultMessage(artifact)});
            const initial = structuredClone(f.session.history.filter(message => message.role !== "system")).map(message => {
                if (message.role !== "assistant") return message;
                const {reasoning_content: _reasoning, ...visible} = message;
                return visible;
            });
            let firstSource = "";
            const fake = createFakeLLM(Array.from({length: 5}, (_, round) => options => {
                if (!round) firstSource = contentText(options.messages[1]!.content)!.match(/\[source ([a-f0-9]{64}\/1);/)![1]!;
                const correction = options.messages.find(message => message.role === "user" && contentText(message.content).includes(`纠正_${round}`))!;
                const ref = contentText(correction.content)!.match(/\[source ([a-f0-9]{64}\/[0-9]+);/)![1]!;
                return assistantText(JSON.stringify({version: 1,
                    objective: [{text: "继续完成删除列", sources: [firstSource], basis: "reported"}],
                    constraints: [{text: `采用纠正_${round}`, sources: [ref], basis: "reported"}],
                    decisions: [], files: [], verification: [], next: []}));
            }));
            const compact = createCompactHistoryRunner({generateSummary: createCompactSummaryGenerator({callLLM: fake.callLLM})});
            for (let round = 0; round < 5; round++) {
                f.session.history.push({role: "assistant", content: "中间证据\n".repeat(4000)}, {role: "user", content: `纠正_${round}：允许显式丢弃，默认仍不丢弃`});
                const result = await compact({history: f.session.history, ctx: f.ctx, tools: [], preTokenCount: 100_000, force: true});
                expect(result.compacted).toBe(true);
                expect(result.postTokenCount!).toBeLessThan(getCompactTarget(f.ctx.model));
                expect(f.session.history[1]!.content).toContain(`[[${firstSource}]]`);
                expect(f.session.history[1]!.content).toContain(`采用纠正_${round}`);
            }
            const loaded = loadSession(storage, cwd, f.session.sessionId, "glm-test")!;
            expect(loaded.compactState!.archives).toHaveLength(5);
            const earliest = readArchiveMessages(loaded.compactState!.archives![0]!, new SessionContentStore(storage, cwd, f.session.sessionId));
            expect(earliest.slice(0, initial.length)).toEqual(initial);
            await unlink(artifact.path);
            const unavailable = await f.tool("read_file", {path: artifact.path});
            expect(unavailable.outcome).not.toBe("ok");
            expect(fake.calls).toHaveLength(5);
            expect(fake.calls.every(call => call.kind === "compact" && call.tools.length === 0)).toBe(true);
        } finally {await f.resources.close();}
    });
});
