import {HiCode, loadHiCodeHostConfig} from "../../src/sdk/index.js";
import {loadSession} from "../../src/session/storage.js";
import {processToolOutput} from "../../src/toolResults/budget.js";
import {ToolResultStore, createToolResultStore} from "../../src/toolResults/store.js";
import {expect, test} from "bun:test";
import {readFile, readdir, unlink, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import sharp from "sharp";
import {createMcpManager} from "../../src/mcp/index.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {normalizeMcpResultWithArtifacts} from "../../src/mcp/result.js";
import {contentText, imageReferences} from "../../src/images/content.js";
import {encodeImageMessages} from "../../src/images/wire.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const png = () => sharp({create: {width: 30, height: 20, channels: 4, background: "#17aacc"}}).png().toBuffer();
const origin = {kind: "tool" as const, toolCallId: "mcp-image-test", toolName: "mcp__fixture__screenshot"};

test("real stdio MCP delivers ordered tool pixels, structured text and immutable artifact metadata", async () => {
    await withTempProject(async (cwd, storage) => {
        const path = join(cwd, "fixture.png"), bytes = await png();
        await writeFile(path, bytes);
        const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment, sources: [],
            hostServers: [{name: "fixture", command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/imageServer.ts"), path]}],
            requestApproval: async () => "once"});
        try {
            await manager.initialize();
            expect(manager.getSnapshots()[0]?.status).toBe("connected");
            const runtime = createToolRuntime({additionalTools: manager.getTools()});
            const ctx = createTestContext(cwd); ctx.imageModelSupported = true;
            runtime.getToolSchemas();
            expect((await runtime.executeTool("tool_search", JSON.stringify({query: `select:${origin.toolName}`}), ctx, "discover")).outcome).toBe("ok");
            runtime.getToolSchemas();
            const result = await runtime.executeTool(origin.toolName, "{}", ctx, origin.toolCallId);
            expect(result).toMatchObject({outcome: "ok"});
            expect(Array.isArray(result.modelContent) && result.modelContent.map(part => part.type)).toEqual(["text", "image", "text"]);
            expect(contentText(result.modelContent)).toContain("user-provided-fixture");
            expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
            const refs = imageReferences(result.modelContent); expect(refs).toHaveLength(1);
            await unlink(path);
            const wire = await encodeImageMessages({messages: [{role: "tool", tool_call_id: origin.toolCallId, content: result.modelContent}],
                supported: true, readImage: ref => ctx.toolResultStore.readImage(ref)});
            expect(JSON.stringify(wire)).toContain("data:image/png;base64,");
            expect(await sharp(await ctx.toolResultStore.readImage(refs[0]!)).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
            const meta = JSON.parse(await readFile(ctx.toolResultStore.imagePath(refs[0]!.imageId).replace(/\.bin$/, ".binary.json"), "utf8"));
            expect(meta.origin).toEqual(origin); expect(meta.complete).toBe(true);
            ctx.imageModelSupported = false;
            const unsupported = await runtime.executeTool(origin.toolName, "{}", ctx, "unsupported");
            expect(unsupported.outcome).toBe("failed"); expect(contentText(unsupported.modelContent)).toContain("does not support MCP images");
        } finally {await manager.closeAll();}
    });
});

test("MCP rejects malformed, forged, excessive and cancelled images without publishing references", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd), bytes = await png();
        const image = {type: "image", mimeType: "image/png", data: bytes.toString("base64")};
        const input = {store: ctx.toolResultStore, origin, imageModelSupported: true, signal: ctx.signal};
        for (const content of [
            [{...image, data: "!!!!"}], [{...image, data: ""}], [{...image, data: image.data + "="}],
            [{...image, data: Buffer.from("not an image").toString("base64")}],
            [{...image, mimeType: "image/jpeg"}], [{type: "image", url: "https://example.test/a.png"}],
            Array.from({length: 9}, () => image), [{...image, data: "A".repeat(28 * 1024 * 1024)}],
        ]) await expect(normalizeMcpResultWithArtifacts({content}, input)).rejects.toThrow("MCP image");
        await expect(normalizeMcpResultWithArtifacts({content: [image]}, {...input, signal: AbortSignal.abort()})).rejects.toThrow();
        await expect(normalizeMcpResultWithArtifacts({isError: true, content: [{type: "text", text: "capture failed"}, image]}, input)).rejects.toThrow("capture failed");
        expect((await readdir(ctx.toolResultStore.sessionDir).catch(() => [])).filter(name => name.endsWith(".bin"))).toHaveLength(0);
    });
});

test("MCP validates decoding, preserves multiple images and verifies repaired binary assets", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd), bytes = await png();
        const input = {store: ctx.toolResultStore, origin, imageModelSupported: true, signal: ctx.signal};
        const broken = Buffer.concat([bytes.subarray(0, 8), Buffer.from("broken")]);
        await expect(normalizeMcpResultWithArtifacts({content: [{type: "image", mimeType: "image/png", data: broken.toString("base64")}]}, input)).rejects.toThrow("decoding failed");
        const image = {type: "image", mimeType: "image/png", data: bytes.toString("base64")};
        const output = await normalizeMcpResultWithArtifacts({content: [{type: "text", text: "before"}, image, {type: "text", text: "after"}, image], structuredContent: {ok: true}}, input);
        expect(typeof output !== "string" && imageReferences(output.content)).toHaveLength(2);
        expect(typeof output !== "string" && contentText(output.content)).toContain("after");
        // A fresh valid payload repairs a corrupt old pair before publishing its reference.
        const ref = typeof output !== "string" ? imageReferences(output.content)[0]! : undefined;
        expect(ref).toBeDefined();
        await writeFile(ctx.toolResultStore.imagePath(ref!.imageId), "corrupt");
        await normalizeMcpResultWithArtifacts({content: [image]}, input);
        expect(await ctx.toolResultStore.readImage(ref!)).toBeInstanceOf(Buffer);
    });
});


test("public SDK consumes MCP images through production Provider, preserves History and completes one continuation", async () => {
    await withTempProject(async (cwd, storage) => {
        const path = join(cwd, "sdk.png"), bytes = await png(); await writeFile(path, bytes);
        const {configuration} = loadHiCodeHostConfig({cwd, hicodeHome: storage.hicodeHome,
            fileSources: {settings: [], instructions: [], skills: [], agents: [], mcp: []},
            settingsOverrides: {models: {primary: {source: "qwen", model: "qwen3.8-flash"}},
                sources: {qwen: {apiKeyEnv: "HICODE_MCP_IMAGE_TEST_KEY"}},
                memory: {enabled: false, autoExtract: false}, sandbox: {}},
            rootContributions: {mcpServers: [{name: "fixture", command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/imageServer.ts"), path]}]},
        });
        const oldFetch = globalThis.fetch, oldKey = process.env.HICODE_MCP_IMAGE_TEST_KEY;
        process.env.HICODE_MCP_IMAGE_TEST_KEY = "offline";
        let calls = 0;
        globalThis.fetch = (async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            calls++;
            const name = calls === 1 ? "tool_search" : origin.toolName;
            if (calls === 3) {
                const result = body.messages.findLast((message: {role: string}) => message.role === "tool");
                expect(result.content.map((part: {type: string}) => part.type)).toEqual(["text", "image_url", "text"]);
                expect(result.content[1].image_url.url).toStartWith("data:image/png;base64,");
                await unlink(path);
            }
            if (calls > 3) throw new Error("Unexpected repeated model request");
            const delta = calls === 3 ? {content: "已看到蓝色矩形图片"} : {tool_calls: [{index: 0, id: `call-${calls}`, type: "function", function: {
                name, arguments: calls === 1 ? JSON.stringify({query: `select:${origin.toolName}`}) : "{}",
            }}]};
            return new Response(`data: ${JSON.stringify({choices: [{index: 0, delta, finish_reason: calls === 3 ? "stop" : "tool_calls"}]})}\n\ndata: [DONE]\n\n`, {headers: {"content-type": "text/event-stream"}});
        }) as typeof fetch;
        let hicode: HiCode | undefined;
        try {
            hicode = await HiCode.create({configuration, host: {async onInteraction() {return {behavior: "allow", persistence: "once"};}}});
            const thread = await hicode.startThread();
            const result = await thread.run("读取 MCP 截图并描述颜色", {maxIterations: 4});
            expect(result.stopReason).toBe("completed"); expect(calls).toBe(3);
            expect(result.items.filter(item => item.type === "tool_call").map(item => item.status)).toEqual(["completed", "completed"]);
            await thread.close();
            const saved = loadSession(storage, cwd, thread.id, "qwen3.8-flash")!;
            const refs = saved.history.flatMap(message => imageReferences(message.content));
            expect(refs).toHaveLength(1); expect(JSON.stringify(saved)).not.toContain("base64");
            expect(await createToolResultStore(storage, cwd, thread.id).readImage(refs[0]!)).toBeInstanceOf(Buffer);
        } finally {
            await hicode?.close(); globalThis.fetch = oldFetch;
            if (oldKey === undefined) delete process.env.HICODE_MCP_IMAGE_TEST_KEY; else process.env.HICODE_MCP_IMAGE_TEST_KEY = oldKey;
        }
    });
});


test("MCP image quota fails closed while text truncation retains the image reference", async () => {
    await withTempProject(async (cwd, storage) => {
        const bytes = await png(), image = {type: "image", mimeType: "image/png", data: bytes.toString("base64")};
        const full = createToolResultStore(storage, cwd, "full");
        const tiny = new ToolResultStore(storage, cwd, "tiny", {maxArtifactBytes: 1, maxSessionBytes: 1, previewChars: 20});
        const input = {origin, imageModelSupported: true, signal: new AbortController().signal};
        await expect(normalizeMcpResultWithArtifacts({content: [image]}, {...input, store: tiny})).rejects.toThrow();
        const output = await normalizeMcpResultWithArtifacts({content: [{type: "text", text: "x".repeat(60_000)}, image]}, {...input, store: full});
        const budgeted = await processToolOutput({output, store: full, toolName: origin.toolName, toolCallId: origin.toolCallId});
        expect(budgeted.persisted).toBeDefined(); expect(imageReferences(budgeted.modelContent)).toHaveLength(1);
        expect(contentText(budgeted.modelContent)).toContain("persisted-output");
        expect(JSON.stringify(budgeted)).not.toContain(bytes.toString("base64"));
    });
});
