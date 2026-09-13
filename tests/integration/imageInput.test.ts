import {listPromptLogs} from "../helpers/promptLogs.js";
import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {runHeadlessForTest} from "../helpers/headless.js";
import {expect, test} from "bun:test";
import {readFile, readdir, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {createSDKThread} from "../../src/sdk/thread.js";
import {collectTurnResult} from "../../src/sdk/resultCollector.js";
import {createCompactState} from "../../src/context/state.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {importUserInput, snapshotTurnInput} from "../../src/images/input.js";
import {imageReferences, contentText} from "../../src/images/content.js";
import {importSelectedImages} from "../../src/runtime/imageInput.js";
import {createToolResultStore} from "../../src/toolResults/store.js";
import {RuntimeMessageQueue, normalizeRuntimeQueuedMessages} from "../../src/runtime/messageQueue.js";
import {loadSession} from "../../src/session/storage.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";
import {getProjectStorageDirectory} from "../../src/persistence/index.js";

const png = (red = 30) => sharp({create: {width: 32, height: 16, channels: 4, background: {r: red, g: 70, b: 100, alpha: 1}}}).png().toBuffer();
const state = {todos: [], permissionMode: "ask" as const, collaborationMode: "build" as const, uiEvents: []};
function settings() {
    const value = createTestSettings();
    value.models.primary = {source: "qwen", model: "qwen3.8-flash", label: "Qwen"};
    value.sources.qwen = {...value.sources.qwen, apiKeyEnv: "PILLAR_USER_IMAGE_TEST_KEY"};
    return value;
}

test("SDK snapshots ordered user bytes before deferred streaming, sends actual user pixels, resumes and logs metadata only", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage, settings: settings()});
        const oldFetch = globalThis.fetch, oldKey = process.env.PILLAR_USER_IMAGE_TEST_KEY;
        const requests: {messages: {role: string; content: unknown}[]}[] = [];
        process.env.PILLAR_USER_IMAGE_TEST_KEY = "offline-test";
        globalThis.fetch = (async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"图片收到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {"content-type": "text/event-stream"}});
        }) as typeof fetch;
        const first = await createSDKThread({resources, seed: {sessionId: "user-image", history: createInitialHistory(cwd, resources.model), compactState: createCompactState()},
            state, resumed: false, onClose() {}});
        try {
            const red = await png(), blue = await png(180), savedRed = Buffer.from(red);
            const pending = first.runStreamed([{type: "text", text: "第一张"}, {type: "image", data: red}, {type: "text", text: "第二张"}, {type: "image", data: blue}]);
            red.fill(0); blue.fill(0);
            const stream = await pending;
            expect(requests).toHaveLength(0);
            const result = await collectTurnResult(stream.events);
            expect(result.stopReason).toBe("completed");
            const user = requests[0]!.messages.findLast(message => message.role === "user")!;
            const wire = user.content as {type: string; text?: string; image_url?: {url: string}}[];
            expect(wire.map(part => part.type)).toEqual(["text", "image_url", "text", "image_url"]);
            expect(wire.filter(part => part.type === "text").map(part => part.text)).toEqual(["第一张", "第二张"]);
            expect(await sharp(Buffer.from(wire[1]!.image_url!.url.split(",")[1]!, "base64")).raw().toBuffer()).toEqual(await sharp(savedRed).raw().toBuffer());
            await first.close();
            const loaded = loadSession(storage, cwd, first.id, resources.model)!;
            const refs = loaded.history.flatMap(message => imageReferences(message.content));
            expect(refs).toHaveLength(2);
            const store = createToolResultStore(storage, cwd, first.id);
            const metadataFile = (await readdir(store.sessionDir)).find(name => name.endsWith(".binary.json"))!;
            const metadata = JSON.parse(await readFile(join(store.sessionDir, metadataFile), "utf8"));
            expect(metadata.origin.kind).toBe("user");
            expect(metadata.origin.inputId).toMatch(/^[a-f0-9-]{36}$/);
            expect(metadata).not.toHaveProperty("toolCallId");
            const resumed = await createSDKThread({resources, seed: {sessionId: loaded.sessionId, history: loaded.history, compactState: loaded.compactState!}, state, resumed: true, onClose() {}});
            try {expect((await resumed.run("比较两张图")).stopReason).toBe("completed");} finally {await resumed.close();}
            expect(JSON.stringify(requests[1])).toContain("data:image/png;base64,");
            const logDir = getProjectStorageDirectory(storage, cwd);
            for (const name of await listPromptLogs(logDir)) {
                const log = await readFile(join(logDir, name), "utf8");
                expect(log).not.toContain("base64,"); expect(log).not.toContain("offline-test");
            }
            expect(JSON.stringify(loaded)).not.toContain("base64,");
        } finally {
            await first.close(); globalThis.fetch = oldFetch;
            if (oldKey === undefined) delete process.env.PILLAR_USER_IMAGE_TEST_KEY; else process.env.PILLAR_USER_IMAGE_TEST_KEY = oldKey;
            await resources.close();
        }
    });
});

test("selected local images obey policy and queue immutable snapshots through persistence, and draft editing", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage, settings: settings()});
        const ctx = createTestContext(cwd, {model: "qwen3.8-flash", provider: "qwen", workspaceBoundary: cwd, toolResultStore: createToolResultStore(storage, cwd, "test-session")});
        const path = join(cwd, "截图 with spaces.png"); await writeFile(path, await png());
        try {
            ctx.permissionRules.deny.push({toolName: "view_image", source: "host"});
            await expect(importSelectedImages([path], resources, ctx)).rejects.toThrow("Denied by rule");
            ctx.permissionRules.deny.length = 0;
            const images = await importSelectedImages([path], resources, ctx);
            expect(images[0]!.label).toBe("截图 with spaces.png");
            await unlink(path);
            const queue = new RuntimeMessageQueue();
            const input = [{type: "text" as const, text: "按照截图修复"}, ...images];
            queue.enqueueUser(input);
            input.splice(0);
            expect(imageReferences(queue.list()[0]!.content)).toHaveLength(1);
            const args = {...state, cwd, model: resources.model, sessionId: ctx.sessionId, history: [{role: "user" as const, origin: "user" as const, content: "original"}]};
            await saveSessionSnapshot(storage, {...args, queuedInputs: queue.list()});
            const loaded = loadSession(storage, cwd, ctx.sessionId, resources.model)!;
            expect(normalizeRuntimeQueuedMessages(loaded.queuedInputs)).toEqual([...queue.list()]);
            const ui = createUITurnSessionRuntime(resources, loaded);
            expect(imageReferences(ui.resumedDraft!)).toEqual(images);
            expect(contentText(ui.resumedDraft)).toContain("按照截图修复");
            await ui.rootSession.initialize();
            const content = queue.takeEditableInputs()[0]!;
            expect(queue.list()).toHaveLength(0);
            expect(imageReferences(content)).toEqual(images);
            expect(await ctx.toolResultStore.readImage(images[0]!)).toBeInstanceOf(Buffer);
        } finally {await resources.close();}
    });
});

test("bad, unsupported, forged and cancelled input cannot become user image references", async () => {
    await withTempProject(async (cwd, storage) => {
        const store = createToolResultStore(storage, cwd, "invalid-images");
        const data = await png();
        expect(() => snapshotTurnInput([])).toThrow("Invalid");
        expect(() => snapshotTurnInput(Array.from({length: 9}, () => ({type: "image" as const, data})))).toThrow("Invalid");
        await expect(importUserInput([{type: "image", data}], store, false, new AbortController().signal)).rejects.toThrow("does not support");
        await expect(importUserInput([{type: "image", data: Buffer.from("not png")}], store, true, new AbortController().signal)).rejects.toThrow();
        await expect(importUserInput([{type: "image", data}], store, true, AbortSignal.abort())).rejects.toThrow();
        expect(normalizeRuntimeQueuedMessages([{id: "x", type: "user_input", priority: "next", createdAt: new Date().toISOString(), content: [{type: "image_url", image_url: {url: "data:image/png;base64,aaaa"}}]}])).toBeUndefined();
        expect((await readdir(store.sessionDir).catch(() => [])).filter(name => name.endsWith(".bin"))).toHaveLength(0);
    });
});

test("SDK cancels preparation on close, rejects concurrent import and can recover from unsupported input", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage, settings: settings()});
        const open = (id: string) => createSDKThread({resources, seed: {sessionId: id, history: createInitialHistory(cwd, resources.model), compactState: createCompactState()}, state, resumed: false, onClose() {}});
        const thread = await open("cancel-import");
        try {
            const bytes = await png();
            const importPromise = thread.runStreamed([{type: "image", data: bytes}]);
            const cancelled = importPromise.then(() => null, (error: unknown) => error);
            const busy = thread.runStreamed("busy").then(() => null, (error: unknown) => error);
            await thread.close();
            expect(await cancelled).toMatchObject({code: "interrupted"});
            expect(await busy).toMatchObject({code: "thread_busy"});
            await expect(thread.runStreamed("closed")).rejects.toMatchObject({code: "thread_closed"});
            const loaded = loadSession(storage, cwd, thread.id, resources.model);
            expect(loaded?.history.flatMap(message => imageReferences(message.content)) ?? []).toHaveLength(0);
            const retry = await open("retry-import");
            try {
                await expect(retry.runStreamed([{type: "image", data: Buffer.from("broken")}])).rejects.toMatchObject({code: "invalid_image"});
                await expect(retry.runStreamed([{type: "image", data: bytes}], {signal: AbortSignal.abort()})).rejects.toMatchObject({code: "interrupted"});
                // No consumption: verifying successful preparation, without starting any model request.
                const ready = await retry.runStreamed([{type: "image", data: bytes}]);
                await ready.events.return(undefined);
            } finally {await retry.close();}
        } finally {await thread.close(); await resources.close();}
    });
});


test("headless -p imports explicit files as user input before running the shared turn", async () => {
    await withTempProject(async (cwd, storage) => {
        const path = join(cwd, "headless image.png"); await writeFile(path, await png());
        let observed = false;
        const result = await runHeadlessForTest({cwd, storage, settings: settings(), prompt: "inspect", images: [path], resumeMode: {kind: "none"}, outputFormat: "json"}, {
            writeOutput() {}, writeDiagnostic() {}, runAgent: async (input, history, onEvent, ctx) => {
                const images = imageReferences(input);
                expect(images).toHaveLength(1);
                await unlink(path);
                expect(await ctx.toolResultStore.readImage(images[0]!)).toBeInstanceOf(Buffer);
                history.push({role: "user", origin: "user" as const, content: input});
                observed = true;
                await onEvent({type: "assistant_text", content: "received"});
                return {reply: "received", reason: "completed", iterations: 1};
            },
        });
        expect(result.ok).toBe(true); expect(observed).toBe(true);
        expect(loadSession(storage, cwd, result.threadId, "qwen3.8-flash")!.history.flatMap(message => imageReferences(message.content))).toHaveLength(1);
    });
});
