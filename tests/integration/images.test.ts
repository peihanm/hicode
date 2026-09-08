import {expect, test} from "bun:test";
import {readdir, readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createImageAccess} from "../../src/images/access.js";
import {imageReferences} from "../../src/images/content.js";
import {prepareImage} from "../../src/images/prepare.js";
import {supportsToolImages} from "../../src/images/capability.js";
import {encodeImageMessages} from "../../src/images/wire.js";
import {ToolResultStore, createToolResultStore} from "../../src/toolResults/store.js";
import {applyBatchToolResultBudget, processToolOutput} from "../../src/toolResults/budget.js";
import type {Message} from "../../src/llm/types.js";
import {saveSessionSnapshot, saveSessionTurnCheckpoint, loadSession, saveSessionCompaction} from "../../src/session/storage.js";
import {forkSessionConversation} from "../../src/session/fork.js";
import {prepareSessionArchive, createSessionArchiveAccess} from "../../src/session/archive.js";
import {archiveIndexPath} from "../../src/session/archiveAccess.js";
import {createCompactState} from "../../src/context/state.js";
import {selectCompactInput} from "../../src/context/compactInput.js";
import {estimateMessageTokens} from "../../src/context/tokens.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {getProjectDebugDirectory} from "../../src/persistence/index.js";
import {createOpenAICompatibleCaller} from "../../src/llm/providers/openAICompatible.js";
import {createHookRuntimeFactory, type HookEnvelope} from "../../src/hooks/index.js";
import {resolvedHooks} from "../helpers/hooks.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {listSessionTurnCheckpoints} from "../../src/session/storage.js";

const signal = () => new AbortController().signal;
const png = () => sharp({create: {width: 80, height: 40, channels: 4, background: {r: 20, g: 80, b: 160, alpha: 0.5}}}).png().toBuffer();
const state = {todos: [], uiEvents: [], permissionMode: "default" as const, collaborationMode: "build" as const};

function fixture(cwd: string) {
    const ctx = createTestContext(cwd, {sessionId: "images", workspaceBoundary: cwd, toolResultStore: createToolResultStore(createTestStorage(cwd), cwd, "images")});
    const runtime = createToolRuntime();
    const history: Message[] = [{role: "user", content: "查看图片"}];
    ctx.imageModelSupported = true;
    ctx.imageAccess = createImageAccess({storage: ctx.storage, store: ctx.toolResultStore, history: () => history, state: () => ctx.compactState});
    let sequence = 0;
    return {ctx, history, async tool(input: {path?: string; image_id?: string}) {
        const id = `image-call-${sequence++}`;
        history.push({role: "assistant", content: null, tool_calls: [{id, type: "function", function: {name: "view_image", arguments: JSON.stringify(input)}}]});
        const result = await runtime.executeTool("view_image", JSON.stringify(input), ctx, id);
        history.push({role: "tool", tool_call_id: id, content: result.modelContent});
        return result;
    }};
}

test("view_image saves pixels, gives no edit evidence, Resume and ID reread survive source deletion", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd), path = join(cwd, "screen.png"), bytes = await png();
        await writeFile(path, bytes);
        const result = await f.tool({path});
        expect(result.outcome).toBe("ok");
        const [ref] = imageReferences(result.modelContent);
        expect(ref).toBeDefined();
        expect(f.ctx.fileState.check(path, bytes)).toEqual({ok: false, reason: "not_read"});
        expect(JSON.stringify(f.history)).not.toContain(bytes.toString("base64"));
        await saveSessionSnapshot(storage, {...state, cwd, model: "qwen3.8-flash", sessionId: "images", history: f.history});
        await unlink(path);
        const loaded = loadSession(storage, cwd, "images", "qwen3.8-flash")!;
        expect(loaded).toBeDefined();
        const store = createToolResultStore(storage, cwd, "images");
        const access = createImageAccess({storage, store, history: () => loaded.history, state: () => loaded.compactState ?? createCompactState()});
        expect(await sharp(await access.read(ref!)).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
        expect((await f.tool({image_id: ref!.imageId})).outcome).toBe("ok");
        const encoded = JSON.stringify(await encodeImageMessages({messages: loaded.history, supported: true, readImage: access.read}));
        expect(encoded).toContain('"type":"image_url"');
        expect(encoded).toContain("data:image/png;base64,");
        expect(encoded).not.toContain(ref!.imageId + '\",\"image\"');
    });
});

test("image access follows active archives and rollback, Fork copies assets independently", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd), path = join(cwd, "screen.png");
        await writeFile(path, await png());
        const [ref] = imageReferences((await f.tool({path})).modelContent);
        const input = {...state, cwd, model: "qwen3.8-flash", sessionId: "images"};
        await saveSessionSnapshot(storage, {...input, history: f.history});
        const draft = prepareSessionArchive(storage, cwd, "images", f.history);
        const compactState = {...createCompactState(), compactCount: 1, archives: [draft.record]};
        const compacted: Message[] = [{role: "user", content: "<system-reminder>本会话已压缩，回查档案</system-reminder>"}];
        await saveSessionCompaction(storage, {...input, history: compacted, compactState}, draft, signal());
        f.history.splice(0, f.history.length, ...compacted);
        Object.assign(f.ctx.compactState, compactState);
        expect(await f.ctx.imageAccess!.read(ref!)).toBeInstanceOf(Buffer);
        const archives = createSessionArchiveAccess(storage, cwd, "images", () => compactState);
        const index = await archives.resolve(archiveIndexPath(storage, cwd, "images", draft.record.id));
        const parts = (await readFile(index!.path, "utf8")).split("\n").filter(line => line.endsWith("-1.txt"));
        const part = await archives.resolve(parts[0]!);
        expect(await readFile(part!.path, "utf8")).toContain(ref!.imageId);
        expect(await readFile(part!.path, "utf8")).not.toContain("[object Object]");
        await saveSessionTurnCheckpoint(storage, {...input, history: f.history, compactState, checkpointId: "branch", branchId: "b", prompt: "continue"});
        const fork = await forkSessionConversation({storage, cwd, model: input.model, sessionId: "images", checkpointId: "branch", permissionMode: "default"});
        const loaded = loadSession(storage, cwd, fork.sessionId, input.model)!;
        const target = createToolResultStore(storage, cwd, fork.sessionId);
        await unlink(f.ctx.toolResultStore.imagePath(ref!.imageId));
        const access = createImageAccess({storage, store: target, history: () => loaded.history, state: () => loaded.compactState!});
        expect(await access.read(ref!)).toBeInstanceOf(Buffer);
        // Rewinding to a state without that archive revokes ID access even though bytes exist.
        loaded.compactState = createCompactState();
        expect(() => access.find(ref!.imageId)).toThrow("可达引用");
        const foreign = createImageAccess({storage, store: target, history: () => [], state: createCompactState});
        expect(() => foreign.find(ref!.imageId)).toThrow();
    });
});

test("capability, permissions, symlinks, malformed input and cancellation fail without image references", async () => {
    await withTempProject(async cwd => {
        const f = fixture(cwd), path = join(cwd, "screen.png");
        await writeFile(path, await png());
        f.ctx.imageModelSupported = false;
        expect((await f.tool({path})).outcome).toBe("failed");
        f.ctx.imageModelSupported = true;
        f.ctx.permissionRules.deny.push({toolName: "view_image", source: "host"});
        expect((await f.tool({path})).outcome).toBe("denied");
        f.ctx.permissionRules.deny.length = 0;
        const alias = join(cwd, "alias.png"); await symlink(path, alias);
        expect((await f.tool({path: alias})).outcome).toBe("failed");
        expect((await f.tool({path: join(cwd, "../outside.png")})).outcome).toBe("denied");
        expect((await f.tool({path, image_id: `image-${"a".repeat(64)}`})).outcome).toBe("failed");
        const [ref] = imageReferences((await f.tool({path})).modelContent);
        expect((await f.tool({path: f.ctx.toolResultStore.imagePath(ref!.imageId)})).outcome).not.toBe("ok");
        const stopped = fixture(cwd); stopped.ctx.signal = AbortSignal.abort("user-cancel");
        expect((await stopped.tool({path})).outcome).toBe("interrupted");
        expect(stopped.history.flatMap(message => imageReferences(message.content))).toHaveLength(0);
    });
});

test("quota cannot truncate images; changed bytes and forged metadata are rejected", async () => {
    await withTempProject(async (cwd, storage) => {
        const prepared = await prepareImage(await png(), signal());
        const tiny = new ToolResultStore(storage, cwd, "tiny", {maxArtifactBytes: 100, maxSessionBytes: 100, previewChars: 100});
        await expect(tiny.persistBinary({origin: {kind: "tool", toolCallId: "t", toolName: "view_image"}, data: prepared.data, mimeType: prepared.image.mimeType, image: prepared.image})).rejects.toThrow("额度不足");
        expect((await readdir(tiny.sessionDir)).filter(path => path.endsWith(".bin") || path.endsWith(".json"))).toHaveLength(0);
        const f = fixture(cwd); await writeFile(join(cwd, "s.png"), await png());
        const [ref] = imageReferences((await f.tool({path: "s.png"})).modelContent);
        await expect(f.ctx.imageAccess!.read({...ref!, image: {...ref!.image, width: 1}})).rejects.toThrow("元数据");
        const path = f.ctx.toolResultStore.imagePath(ref!.imageId), data = await readFile(path);
        data[40] = data[40]! ^ 1; await writeFile(path, data);
        await expect(f.ctx.imageAccess!.read(ref!)).rejects.toThrow("完整性");
    });
});

test("text budget keeps image references; summaries disclose missing pixels; request image budget is hard", async () => {
    await withTempProject(async cwd => {
        const f = fixture(cwd); await writeFile(join(cwd, "s.png"), await png());
        const [ref] = imageReferences((await f.tool({path: "s.png"})).modelContent);
        const content = [{type: "text" as const, text: "huge ".repeat(10_000)}, ref!];
        const processed = await processToolOutput({output: {content}, toolName: "view_image", toolCallId: "huge", store: f.ctx.toolResultStore, maxResultSizeChars: 500});
        expect(imageReferences(processed.modelContent)).toEqual([ref!]);
        const history: Message[] = [{role: "tool", tool_call_id: "huge-batch", content}];
        await applyBatchToolResultBudget({history, entries: [{messageIndex: 0, toolCallId: "huge-batch", toolName: "view_image"}], store: f.ctx.toolResultStore, maxChars: 2000});
        expect(imageReferences(history[0]!.content)).toEqual([ref!]);
        expect(estimateMessageTokens({role: "tool", tool_call_id: "x", content: [ref!]})).toBeGreaterThanOrEqual(8192);
        const summary = selectCompactInput({system: {role: "system", content: "summarize"}, conversation: f.history, prompt: "总结", budget: 100_000});
        expect(summary.messages.flatMap(message => imageReferences(message.content))).toHaveLength(0);
        expect(JSON.stringify(summary.messages)).toContain("不含像素");
        await expect(encodeImageMessages({messages: f.history, supported: false, readImage: f.ctx.imageAccess!.read})).rejects.toThrow("未提供图片能力");
        await expect(encodeImageMessages({messages: Array.from({length: 9}, () => ({role: "tool" as const, tool_call_id: "i", content: [ref!]})), supported: true, readImage: f.ctx.imageAccess!.read})).rejects.toThrow("预算");
    });
});

test("production Agent → Qwen Provider sends native tool pixels; logs and events contain references only", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = createTestSettings();
        settings.models.primary = {source: "qwen", provider: "qwen", model: "qwen3.8-flash", label: "Qwen"};
        settings.sources.qwen = {...settings.sources.qwen, apiKeyEnv: "PILLAR_IMAGE_TEST_KEY"};
        expect(supportsToolImages(settings.sources.qwen, "qwen3.8-flash")).toBe(true);
        expect(supportsToolImages({...settings.sources.qwen, baseUrl: "https://example.com"}, "qwen3.8-flash")).toBe(false);
        expect(supportsToolImages(settings.sources.qwen, "qwen3.8-max")).toBe(false);
        const resources = createTestRuntimeResources(cwd, {settings, storage});
        const ctx = createTestContext(cwd, {model: "qwen3.8-flash", provider: "qwen", workspaceBoundary: cwd, toolResultStore: createToolResultStore(storage, cwd, "test-session")});
        const oldFetch = globalThis.fetch, oldKey = process.env.PILLAR_IMAGE_TEST_KEY;
        const requests: string[] = [], events: string[] = [];
        const history: Message[] = [{role: "system", content: "test"}];
        await writeFile(join(cwd, "screen.png"), await png());
        process.env.PILLAR_IMAGE_TEST_KEY = "test-only-key";
        globalThis.fetch = (async (_url, init) => {
            requests.push(String(init?.body));
            const delta = requests.length === 1 ? {tool_calls: [{index: 0, id: "see", type: "function", function: {name: "view_image", arguments: '{"path":"screen.png"}'}}]} : {content: "已读取图片"};
            return new Response(`data: ${JSON.stringify({choices: [{index: 0, delta, finish_reason: null}]})}\n\ndata: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop"}]})}\n\ndata: [DONE]\n\n`, {headers: {"content-type": "text/event-stream"}});
        }) as typeof fetch;
        try {
            await resources.agentRuntime.runAgent("看 screen.png", history, event => {events.push(JSON.stringify(event));}, ctx, EMPTY_AGENT_INPUT_CHANNEL,
                {getToolSchemas: resources.toolRuntime.getToolSchemas, executeTool: resources.toolRuntime.executeTool, isToolConcurrencySafe: resources.toolRuntime.isConcurrencySafe});
            expect(requests).toHaveLength(2);
            expect(requests[1]).toContain('"role":"tool","content":[{"type":"text"');
            expect(requests[1]).toContain("data:image/png;base64,");
            expect(JSON.stringify(history)).not.toContain("base64,");
            expect(events.join("\n")).not.toContain("base64,");
            const logs = join(getProjectDebugDirectory(storage, cwd), "prompt-logs");
            const logged = (await Promise.all((await readdir(logs)).map(name => readFile(join(logs, name), "utf8")))).join("\n");
            expect(logged).toContain('"imagesSubmitted": true');
            expect(logged).toContain('"imageId"');
            expect(logged).not.toContain("base64,");
            expect(logged).not.toContain("test-only-key");
        } finally {
            globalThis.fetch = oldFetch;
            if (oldKey === undefined) delete process.env.PILLAR_IMAGE_TEST_KEY; else process.env.PILLAR_IMAGE_TEST_KEY = oldKey;
            await resources.close();
        }
    });
});

test("Hook receives text projection and appends context after the original image block", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd); await writeFile(join(cwd, "s.png"), await png());
        const observed: string[] = [];
        const hooks = await createHookRuntimeFactory({getTrust: async () => "allow", executeCommand: async ({stdin}) => {
            observed.push(stdin);
            expect((JSON.parse(stdin) as HookEnvelope).event.hook_event_name).toBe("PostToolUse");
            return {stdout: JSON.stringify({additionalContext: "image-hook-note"}), stderr: "", termination: {kind: "exit", code: 0}};
        }})({storage, cwd, hooks: resolvedHooks("PostToolUse", [{type: "command", purpose: "observe", command: "fixture"}]), childEnvironment: testChildEnvironment});
        const runtime = createToolRuntime({hooks});
        const result = await runtime.executeTool("view_image", '{"path":"s.png"}', f.ctx, "hook-image");
        expect(result.outcome).toBe("ok");
        expect(Array.isArray(result.modelContent)).toBe(true);
        if (!Array.isArray(result.modelContent)) throw new Error("image blocks missing");
        expect(result.modelContent.map(part => part.type)).toEqual(["text", "image", "text"]);
        expect(JSON.stringify(result.modelContent.at(-1))).toContain("image-hook-note");
        expect(observed).toHaveLength(1);
        expect(observed[0]).toContain("不含像素");
        expect(observed[0]).not.toContain("base64,");
    });
});

test("image retry reuses prepared bytes and HTTP errors cannot echo them into diagnostics", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd); await writeFile(join(cwd, "s.png"), await png());
        const [ref] = imageReferences((await f.tool({path: "s.png"})).modelContent);
        const originalFetch = globalThis.fetch;
        let reads = 0;
        const requests: string[] = [];
        const call = createOpenAICompatibleCaller({retryBaseDelayMs: 0});
        const options = {storage, cwd, messages: f.history, tools: [], model: "qwen3.8-flash", kind: "main" as const,
            readImage: async (reference: NonNullable<typeof ref>) => {reads++; return f.ctx.imageAccess!.read(reference);}};
        const endpoint = {baseUrl: "https://offline-image.invalid/v1", displayName: "fixture", apiKey: "fixture-key", toolImages: true};
        globalThis.fetch = (async (_url, init) => {
            requests.push(String(init?.body));
            if (requests.length === 1) return new Response(requests[0], {status: 503});
            return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }) as typeof fetch;
        try {
            await call(options, endpoint);
            expect(requests).toHaveLength(2);
            expect(requests[1]).toBe(requests[0]);
            expect(reads).toBe(1);
            globalThis.fetch = (async (_url, init) => new Response(String(init?.body), {status: 400})) as typeof fetch;
            await expect(call(options, endpoint)).rejects.toThrow("图片请求错误正文已隐藏");
            const logs = join(getProjectDebugDirectory(storage, cwd), "prompt-logs");
            const logged = (await Promise.all((await readdir(logs)).map(name => readFile(join(logs, name), "utf8")))).join("\n");
            expect(logged).not.toContain("base64,");
            expect(logged).not.toContain((await f.ctx.imageAccess!.read(ref!)).toString("base64"));
        } finally {globalThis.fetch = originalFetch;}
    });
});

test("real Session checkpoint restore revokes future image access while keeping the asset on disk", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd); await writeFile(join(cwd, "s.png"), await png());
        const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
        const session = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: "images", history: f.history, compactState: createCompactState()}});
        try {
            await session.initialize();
            await session.beginCheckpoint("before image", state);
            const point = listSessionTurnCheckpoints(storage, cwd, "images").at(-1)!;
            const [ref] = imageReferences((await f.tool({path: "s.png"})).modelContent);
            await session.settleCheckpoint();
            await saveSessionSnapshot(storage, session.createSnapshot(state));
            const access = createImageAccess({storage, store: session.toolResultStore, history: () => session.history, state: () => session.compactState});
            expect(await access.read(ref!)).toBeInstanceOf(Buffer);
            session.messageQueue.enqueueUser([ref!]);
            expect((await session.restoreCheckpoint(point.checkpointId)).status).toBe("complete");
            expect(session.messageQueue.list()).toHaveLength(0);
            expect(() => access.find(ref!.imageId)).toThrow("可达引用");
            expect((await readFile(session.toolResultStore.imagePath(ref!.imageId))).length).toBe(ref!.image.byteLength);
        } finally {await resources.close();}
    });
});
