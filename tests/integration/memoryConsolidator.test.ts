import {DEFAULT_CONTEXT_SETTINGS} from "../../src/context/config.js";
import {contentText} from "../../src/images/content.js";
import {expect, test} from "bun:test";
import {access, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createMemoryConsolidatorFactory} from "../../src/memory/consolidator.js";
import {MemoryPublicationStore, serializeDraftTopic} from "../../src/memory/publicationStore.js";
import {getMemoryWorkspacePaths} from "../../src/persistence/layout.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {withTempProject} from "../helpers/tempProject.js";

test("Memory 整理复用真实标准工具和私有草稿目录，发布前不修改正式内容，结束清理草稿", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, "user-source.txt"), "untouched");
        const store = new MemoryPublicationStore(storage, cwd);
        const signal = new AbortController().signal;
        await store.acceptNote("structure", {operation: "remember", type: "feedback", content: "文件结构保持简洁"},
            {kind: "explicit", sessionId: "test-session", turnId: "turn", toolCallId: "note"}, null, signal);
        const job = (await store.claim(signal))!;
        const fake = createFakeLLM([
            assistantToolCall("read_file", {path: "INPUTS.json"}, "input"),
            async options => {
                await expect(access(join(getMemoryWorkspacePaths(store.directory, job.lease.id).root, "repository"))).rejects.toThrow();
                await expect(access(join(getMemoryWorkspacePaths(store.directory, job.lease.id).draft, ".git"))).rejects.toThrow();
                expect(options.tools.some(tool => ["bash", "agent", "task", "web_fetch"].includes(tool.function.name))).toBe(false);
                expect(options.messages.some(message => message.role === "tool" && contentText(message.content).includes(job.lease.sourceIds[0]!))).toBe(true);
                return assistantToolCall("write_file", {path: "topics/structure.md", content: serializeDraftTopic({key: "structure", name: "结构偏好",
                    description: "用户的文件组织偏好", type: "feedback", content: "文件结构保持简洁", sources: job.lease.sourceIds})}, "topic");
            },
            assistantToolCall("read_file", {path: "MEMORY.md"}, "summary-read"),
            assistantToolCall("write_file", {path: "MEMORY.md", content: "用户偏好简洁的文件结构。"}, "summary-write"),
            assistantText("整理完成"),
        ]);
        const worker = createMemoryConsolidatorFactory(fake.callLLM)({storage, cwd, contextSettings: DEFAULT_CONTEXT_SETTINGS,
            shellRunner: createShellRunner(createDisabledSandboxRuntime(), testChildEnvironment),
            target: {source: "glm", model: "glm-test", label: "test"},
            source: {id: "glm", label: "test", apiKeyEnv: "NO_REAL_KEY"}});
        const draft = await worker.consolidate({...job, sessionId: "test-session", signal});
        expect(store.snapshot().topics).toHaveLength(0);
        expect(draft.topics).toHaveLength(1);
        expect(draft.summary).toBe("用户偏好简洁的文件结构。");
        expect(fake.calls).toHaveLength(5);
        expect(fake.calls.every(call => call.kind === "memory")).toBe(true);
        expect(fake.calls.every(call => call.storage.hicodeHome === storage.hicodeHome)).toBe(true);
        await expect(access(getMemoryWorkspacePaths(store.directory, job.lease.id).root)).rejects.toThrow();
        await store.publish(job.lease, draft.topics, draft.summary, signal);
        expect(store.snapshot().topics[0]!.content).toBe("文件结构保持简洁");
    });
}, 15_000);

for (const mode of ["corrupt-input", "cancel"] as const) test(`private Memory draft ${mode} preserves publication and cleans owned files`, async () => {
    await withTempProject(async (cwd, storage) => {
        const store = new MemoryPublicationStore(storage, cwd);
        const controller = new AbortController();
        await store.acceptNote("rule", {operation: "remember", type: "feedback", content: "keep explicit rule"},
            {kind: "explicit", sessionId: "s", turnId: "t", toolCallId: "note"}, null, controller.signal);
        const job = (await store.claim(controller.signal))!;
        const before = JSON.stringify(store.snapshot());
        const fake = mode === "cancel" ? createFakeLLM([() => {
            controller.abort("user-cancel");
            return assistantText("cancelled");
        }]) : createFakeLLM([
            assistantToolCall("read_file", {path: "INPUTS.json"}, "read-input"),
            assistantToolCall("write_file", {path: "INPUTS.json", content: "{}"}, "corrupt"),
            assistantText("done"),
        ]);
        const worker = createMemoryConsolidatorFactory(fake.callLLM)({storage, cwd, contextSettings: DEFAULT_CONTEXT_SETTINGS,
            shellRunner: createShellRunner(createDisabledSandboxRuntime(), testChildEnvironment),
            target: {source: "glm", model: "glm-test", label: "fixture"},
            source: {id: "glm", label: "fixture", apiKeyEnv: "NO_REAL_KEY"}});
        await expect(worker.consolidate({...job, sessionId: "s", signal: controller.signal})).rejects.toThrow();
        expect(JSON.stringify(store.snapshot())).toBe(before);
        await expect(access(getMemoryWorkspacePaths(store.directory, job.lease.id).root)).rejects.toThrow();
    });
});
