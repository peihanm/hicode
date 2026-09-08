import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {AppForTest} from "../helpers/AppForTest.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {imageReferences, type MessageContent} from "../../src/images/content.js";

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
            await waitUntil(() => instance.lastFrame()?.includes("30×20") === true).catch(error => {throw new Error(`${error.message}: ${instance.lastFrame()}`);});
            expect(instance.lastFrame()).toContain("图片 with space.png");
            expect(inputs).toHaveLength(0);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("/detach all");
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("\r");
            await waitUntil(() => !instance.lastFrame()?.includes("30×20") && instance.lastFrame()?.includes("Ask Pillar to build") === true);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write(`/attach ${path}`);
            await new Promise(resolve => setTimeout(resolve, 80));
            instance.stdin.write("\r");
            await waitUntil(() => instance.lastFrame()?.includes("30×20") === true).catch(error => {throw new Error(`${error.message}: ${instance.lastFrame()}`);});
            await unlink(path);
            instance.stdin.write("\r");
            await waitUntil(() => inputs.length > 0);
            expect(imageReferences(inputs[0]!)).toHaveLength(1);
            expect(instance.lastFrame()).not.toContain("base64,");
        } finally {instance.unmount(); await resources.close();}
    });
});
