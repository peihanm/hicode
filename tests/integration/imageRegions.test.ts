import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createFakeLLM, assistantText} from "../helpers/fakeLLM.js";
import {buildForkContextSnapshot} from "../../src/subagents/fork.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {expect, test} from "bun:test";
import {writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createImageAccess} from "../../src/images/access.js";
import {imageReferences} from "../../src/images/content.js";
import {imageAssetId} from "../../src/images/identity.js";
import {prepareImage} from "../../src/images/prepare.js";
import type {Message} from "../../src/llm/types.js";
import {createToolResultStore} from "../../src/toolResults/store.js";
import {loadSession} from "../../src/session/storage.js";

function fixture(cwd: string) {
    const ctx = createTestContext(cwd, {toolResultStore: createToolResultStore(createTestStorage(cwd), cwd, "test-session")});
    const history: Message[] = [{role: "user", origin: "user" as const, content: "查看图片细节"}];
    const runtime = createToolRuntime();
    ctx.imageModelSupported = true;
    ctx.imageAccess = createImageAccess({storage: ctx.storage, store: ctx.toolResultStore, history: () => history, state: () => ctx.compactState});
    let count = 0;
    return {ctx, history, async view(input: Record<string, unknown>) {
        const id = `region-${++count}`;
        history.push({role: "assistant", content: null, tool_calls: [{id, type: "function", function: {name: "view_image", arguments: JSON.stringify(input)}}]});
        const result = await runtime.executeTool("view_image", JSON.stringify(input), ctx, id);
        history.push({role: "tool", tool_call_id: id, content: result.modelContent});
        return result;
    }};
}

test("long image detail comes from immutable original pixels, including cropping a crop in original coordinates", async () => {
    await withTempProject(async cwd => {
        const f = fixture(cwd), path = join(cwd, "long.png");
        const pixels = Buffer.alloc(4096 * 64 * 4);
        for (let i = 0; i < pixels.length; i += 4) {const x = (i / 4) % 4096; pixels[i] = x % 2 ? 255 : 0; pixels[i + 1] = x % 251; pixels[i + 2] = 130; pixels[i + 3] = 128;}
        const source = await sharp(pixels, {raw: {width: 4096, height: 64, channels: 4}}).png().toBuffer();
        await writeFile(path, source);
        const initial = await f.view({path}); expect(initial.outcome).toBe("ok");
        const parent = imageReferences(initial.modelContent)[0]!;
        expect(parent.image.width).toBe(2048);
        await unlink(path);
        const region = {x: 3000, y: 10, width: 40, height: 20};
        const cropped = await f.view({image_id: parent.imageId, region}); expect(cropped.outcome).toBe("ok");
        const child = imageReferences(cropped.modelContent)[0]!;
        expect(child.image.region).toEqual(region); expect(child.image.source).toEqual(parent.image.source);
        const actual = await sharp(await f.ctx.toolResultStore.readImage(child)).raw().toBuffer();
        const expected = await sharp(source).extract({left: 3000, top: 10, width: 40, height: 20}).raw().toBuffer();
        expect(actual).toEqual(expected);
        const recrop = await f.view({image_id: child.imageId, region: {x: 20, y: 0, width: 10, height: 10}});
        expect(recrop.outcome).toBe("ok");
        expect(imageReferences(recrop.modelContent)[0]!.image.region.x).toBe(20);
        for (const region of [{x: -1, y: 0, width: 2, height: 2}, {x: 4090, y: 0, width: 40, height: 20}, {x: 0, y: 0, width: 0, height: 2}])
            expect((await f.view({image_id: child.imageId, region})).outcome).toBe("failed");
        f.history.splice(0, f.history.length, {role: "user", origin: "user" as const, content: "rewound"});
        await expect(f.ctx.imageAccess!.readSource(child)).rejects.toThrow("可达");
        expect((await f.view({image_id: child.imageId, region})).outcome).toBe("failed");
    });
});

test("orientation corrected source coordinates and alpha remain accurate", async () => {
    const raw = await sharp({create: {width: 80, height: 40, channels: 3, background: "red"}})
        .composite([{input: {create: {width: 40, height: 40, channels: 3, background: "blue"}}, left: 40, top: 0}]).jpeg().withMetadata({orientation: 6}).toBuffer();
    const result = await prepareImage(raw, new AbortController().signal, {x: 0, y: 50, width: 30, height: 20});
    expect([result.image.sourceWidth, result.image.sourceHeight]).toEqual([40, 80]);
    expect(result.image.source.orientation).toBe(6);
    const first = await sharp(result.data).raw().toBuffer();
    expect(first[2]!).toBeGreaterThan(200); expect(first[0]!).toBeLessThan(30);
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
});

test("Resume retains the original dependency and corruption prevents new crop publication", async () => {
    await withTempProject(async cwd => {
        const f = fixture(cwd), path = join(cwd, "fork.png");
        await writeFile(path, await sharp({create: {width: 100, height: 60, channels: 3, background: "blue"}}).png().toBuffer());
        const original = imageReferences((await f.view({path})).modelContent)[0]!;
        const reference = imageReferences((await f.view({image_id: original.imageId, region: {x: 10, y: 10, width: 30, height: 20}})).modelContent)[0]!;
        await saveSessionSnapshot(f.ctx.storage, {cwd, sessionId: f.ctx.sessionId, model: "qwen3.8-flash",
            history: [{role: "user", origin: "user" as const, content: [reference]}], todos: [], uiEvents: [], permissionMode: "default", collaborationMode: "build"});
        const saved = loadSession(f.ctx.storage, cwd, f.ctx.sessionId, "qwen3.8-flash")!;
        const target = createToolResultStore(f.ctx.storage, cwd, f.ctx.sessionId);
        const inherited = saved.history.flatMap(message => imageReferences(message.content))[0]!;
        expect(inherited.image.region).toEqual(reference.image.region);
        const sourcePath = f.ctx.toolResultStore.imagePath(imageAssetId(reference.image.source));
        const bytes = await f.ctx.toolResultStore.readImageSource(reference);
        expect(await target.readImageSource(reference)).toEqual(bytes);
        await writeFile(sourcePath, Buffer.alloc(bytes.length));
        expect((await f.view({image_id: reference.imageId, region: {x: 0, y: 0, width: 10, height: 10}})).outcome).toBe("failed");
    });
});


test("child Fork receives independent original and view assets through the parent capability", async () => {
    await withTempProject(async cwd => {
        const f = fixture(cwd), path = join(cwd, "child.png");
        const source = await sharp({create: {width: 80, height: 60, channels: 3, background: "green"}}).png().toBuffer();
        await writeFile(path, source);
        const ref = imageReferences((await f.view({path})).modelContent)[0]!;
        f.history.push({role: "assistant", content: null, tool_calls: [{id: "fork", type: "function", function: {name: "agent", arguments: "{}"}}]});
        const child = createFakeLLM([async () => {
            await unlink(f.ctx.toolResultStore.imagePath(ref.imageId));
            await unlink(f.ctx.toolResultStore.imagePath(imageAssetId(ref.image.source)));
            const childStore = createTestToolResultStore(cwd, "subagent-image-child", {pillarHome: f.ctx.storage.pillarHome});
            expect(await childStore.readImageSource(ref)).toEqual(source);
            expect(await childStore.readImage(ref)).toBeInstanceOf(Buffer);
            return assistantText("图片副本确认");
        }]);
        const thread = createSubagentThreadForTest({parentContext: f.ctx, agentId: "image-child", onEvent() {},
            toolResultStoreOptions: {pillarHome: f.ctx.storage.pillarHome}, agentOptions: {callLLM: child.callLLM}},
            {kind: "fork", agentType: "fork", name: "image", description: "检查图像", prompt: "检查图像", parentToolCallId: "fork", contextSnapshot: buildForkContextSnapshot(f.history, "fork")});
        const result = await thread.run({prompt: "检查图像", signal: new AbortController().signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(result.reply).toBe("图片副本确认");
    });
});
