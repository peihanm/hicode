import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {AppForTest} from "../helpers/AppForTest.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {imageReferences, type MessageContent} from "../../src/images/content.js";
import {contentText} from "../../src/images/content.js";
import {prepareImage} from "../../src/images/prepare.js";
import {imageAssetId} from "../../src/images/identity.js";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {QueuedInputPreview} from "../../src/ui/input/QueuedInputPreview.js";
import {userContentText} from "../../src/ui/conversation/userContent.js";

afterEach(cleanup);
async function waitUntil(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));}
    throw new Error("UI did not reach expected state");
}
test("TUI attaches Chinese paths with spaces, removes attachments, submits pure image after source deletion", async () => {
    await withTempProject(async cwd => {
        const settings = createTestSettings();
        settings.models.primary = {source: "qwen", provider: "qwen", model: "qwen3.8-flash", label: "Qwen"};
        const resources = createTestRuntimeResources(cwd, {settings});
        const path = join(cwd, "图片 with space.png");
        await writeFile(path, await sharp({create: {width: 30, height: 20, channels: 3, background: "red"}}).png().toBuffer());
        const inputs: MessageContent[] = [];
        const instance = render(<AppForTest resources={resources} runAgentImpl={async input => {inputs.push(input); return {reply: "ok", reason: "completed", iterations: 1};}}/>);
        try {
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write(`/attach ${path}`);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("\r");
            await waitUntil(() => instance.lastFrame()?.includes("[Image #1]") === true).catch(error => {throw new Error(`${error.message}: ${instance.lastFrame()}`);});
            expect(instance.lastFrame()).toContain("❯ [Image #1]");
            expect(instance.lastFrame()).not.toContain("图片 with space.png");
            expect(instance.lastFrame()).not.toContain("30×20");
            expect(instance.lastFrame()).not.toContain("Ask Pillar to build");
            expect(inputs).toHaveLength(0);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("/detach all");
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("\r");
            await waitUntil(() => !instance.lastFrame()?.includes("[Image #1]") && instance.lastFrame()?.includes("Ask Pillar to build") === true);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write(`/attach ${path}`);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("\r");
            await waitUntil(() => instance.lastFrame()?.includes("[Image #1]") === true).catch(error => {throw new Error(`${error.message}: ${instance.lastFrame()}`);});
            await unlink(path);
            instance.stdin.write("\r");
            await waitUntil(() => inputs.length > 0);
            expect(imageReferences(inputs[0]!)).toHaveLength(1);
            expect(instance.lastFrame()).not.toContain("base64,");
        } finally {instance.unmount(); await resources.close();}
    });
});

test("pasted file drop becomes an Image attachment without Enter and preserves the surrounding prompt", async () => {
    await withTempProject(async cwd => {
        const settings = createTestSettings();
        settings.models.primary = {source: "qwen", provider: "qwen", model: "qwen3.8-flash", label: "Qwen"};
        const resources = createTestRuntimeResources(cwd, {settings});
        const path = join(cwd, "中文 screenshot.png");
        await writeFile(path, await sharp({create: {width: 31, height: 21, channels: 3, background: "blue"}}).png().toBuffer());
        const inputs: MessageContent[] = [];
        const instance = render(<AppForTest resources={resources} runAgentImpl={async input => {inputs.push(input); return {reply: "ok", reason: "completed", iterations: 1};}}/>);
        try {
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("帮我看看 ");
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write(path.replaceAll(" ", "\\ ") + " ");
            await waitUntil(() => instance.lastFrame()?.includes("[Image #1]") === true);
            expect(instance.lastFrame()).toContain("❯ [Image #1] 帮我看看");
            expect(instance.lastFrame()).not.toContain("中文 screenshot.png");
            expect(instance.lastFrame()).not.toContain("粘贴图片路径或");
            expect(instance.lastFrame()).not.toContain(path);
            expect(instance.lastFrame()).toContain("帮我看看");
            expect(inputs).toHaveLength(0);
            await unlink(path);
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("这张图");
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("\r");
            await waitUntil(() => inputs.length === 1);
            const input = inputs[0]!;
            expect(imageReferences(input)).toHaveLength(1);
            expect(Array.isArray(input) ? input.filter(part => part.type === "text") : input).toEqual([{type: "text", text: "帮我看看 这张图"}]);
            expect(instance.frames.join("\n")).not.toContain("此文字投影不含像素");
            expect(instance.frames.join("\n")).not.toContain(imageReferences(input)[0]!.imageId);
        } finally {instance.unmount(); await resources.close();}
    });
});

test("sent, restored and queued image messages share concise labels without changing model content", async () => {
    const prepared = await prepareImage(await sharp({create: {width: 3, height: 2, channels: 3, background: "red"}}).png().toBuffer(), new AbortController().signal);
    const reference = {type: "image" as const, imageId: imageAssetId(prepared.image), image: prepared.image};
    const content: MessageContent = [{type: "text", text: "这图片有什么内容"}, reference, reference];
    const original = structuredClone(content);
    const expected = "[Image #1] [Image #2] 这图片有什么内容";
    const sent = new UITurnEventStore();
    sent.appendUser(content);
    const restored = new UITurnEventStore({history: [{role: "user", content}]});
    expect(sent.getSnapshot().staticThreads[0]).toMatchObject({role: "user", text: expected});
    expect(restored.getSnapshot().staticThreads[0]).toMatchObject({role: "user", text: expected});
    sent.appendUser([reference]);
    expect(sent.getSnapshot().staticThreads.at(-1)).toMatchObject({text: "[Image #1]"});
    expect(userContentText("字面量 [Image #1]")).toBe("字面量 [Image #1]");
    expect(userContentText([{type: "text", text: "第一行\n第二行"}])).toBe("第一行\n第二行");
    const preview = render(<QueuedInputPreview messages={[{id: "queued", type: "user_input", priority: "next", content, createdAt: "2026-09-09T00:00:00Z"}]}/>);
    expect(preview.lastFrame()).toContain(expected);
    expect(preview.lastFrame()).not.toContain(reference.imageId);
    expect(content).toEqual(original);
    expect(contentText(content)).toContain(reference.imageId);
    expect(contentText(content)).toContain("view_image(image_id)");
});

test("invalid pasted image restores the path and existing draft without submitting a turn", async () => {
    await withTempProject(async cwd => {
        const settings = createTestSettings();
        settings.models.primary = {source: "qwen", provider: "qwen", model: "qwen3.8-flash", label: "Qwen"};
        const resources = createTestRuntimeResources(cwd, {settings});
        const path = join(cwd, "broken.png");
        await writeFile(path, "not an image");
        let turns = 0;
        const instance = render(<AppForTest resources={resources} runAgentImpl={async () => {turns++; return {reply: "ok", reason: "completed", iterations: 1};}}/>);
        try {
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("保留我的问题");
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write(path);
            await waitUntil(() => instance.lastFrame()?.includes("❯ " + path) === true);
            expect(instance.lastFrame()).toContain("保留我的问题");
            expect(instance.lastFrame()).not.toContain("[Image #1]");
            expect(turns).toBe(0);
        } finally {instance.unmount(); await resources.close();}
    });
});

test("inline image labels support Backspace and Ctrl+C without leaving hidden attachments", async () => {
    await withTempProject(async cwd => {
        const settings = createTestSettings();
        settings.models.primary = {source: "qwen", provider: "qwen", model: "qwen3.8-flash", label: "Qwen"};
        const resources = createTestRuntimeResources(cwd, {settings});
        const path = join(cwd, "inline.png");
        await writeFile(path, await sharp({create: {width: 3, height: 2, channels: 3, background: "red"}}).png().toBuffer());
        const inputs: MessageContent[] = [];
        const instance = render(<AppForTest resources={resources} runAgentImpl={async input => {inputs.push(input); return {reply: "ok", reason: "completed", iterations: 1};}}/>);
        try {
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write(path);
            await waitUntil(() => instance.lastFrame()?.includes("❯ [Image #1]") === true);
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write(path);
            await waitUntil(() => instance.lastFrame()?.includes("❯ [Image #1] [Image #2]") === true);
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("\u007f");
            await waitUntil(() => !instance.lastFrame()?.includes("[Image #2]"));
            expect(instance.lastFrame()).toContain("❯ [Image #1]");
            instance.stdin.write("x");
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("\u007f");
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(instance.lastFrame()).toContain("❯ [Image #1]");
            instance.stdin.write("\u007f");
            await waitUntil(() => instance.lastFrame()?.includes("Ask Pillar to build") === true);
            expect(instance.lastFrame()).not.toContain("[Image #1]");
            instance.stdin.write(path);
            await waitUntil(() => instance.lastFrame()?.includes("❯ [Image #1]") === true);
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("\u0003");
            await waitUntil(() => instance.lastFrame()?.includes("Ask Pillar to build") === true);
            expect(instance.lastFrame()).not.toContain("[Image #1]");
            instance.stdin.write("text only");
            await new Promise(resolve => setTimeout(resolve, 30));
            instance.stdin.write("\r");
            await waitUntil(() => inputs.length === 1);
            expect(inputs).toEqual(["text only"]);
        } finally {instance.unmount(); await resources.close();}
    });
});
