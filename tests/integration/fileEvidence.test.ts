import {expect, test} from "bun:test";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createFakeLLM, assistantText, assistantToolCall} from "../helpers/fakeLLM.js";
import {runAgentForTest} from "../helpers/agent.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {ToolCall} from "../../src/llm/types.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createTurnAbortController} from "../../src/runtime/abort.js";

test.each(["pages", "partial", "stale-source", "tampered", "save-failure"])("结果日志不授权源码写入，直接重读源码恢复 %s", async mode => {
    await withTempProject(async cwd => {
        const store = createTestToolResultStore(cwd, "evidence", mode === "save-failure" ? {maxSessionBytes: 0} : {});
        const ctx = createTestContext(cwd, {toolResultStore: store, model: "glm-5.2"});
        for (const [name, width] of [["a", 110], ["b", 100], ["c", 100]] as const) {
            await writeFile(join(cwd, `${name}.txt`), Array.from({length: 900}, (_, n) => `${name}${n}:${"x".repeat(width)}`).join("\n"));
        }
        const calls: ToolCall[] = ["a", "b", "c"].map(name => ({id: `read-${name}`, type: "function",
            function: {name: "read_file", arguments: JSON.stringify({path: `${name}.txt`})}}));
        let nextLine = 1;
        const readSource = () => {
            const offset = nextLine;
            nextLine += 200;
            return assistantToolCall("read_file", {path: "a.txt", offset, limit: 200}, `source-${offset}`);
        };
        const blind = () => assistantToolCall("write_file", {path: "a.txt", content: "BLIND"}, "blind");
        const fake = createFakeLLM(Array.from({length: 16}, () => async (options, index) => {
            if (index === 0) return {message: {role: "assistant" as const, content: null, tool_calls: calls}, toolCalls: calls,
                usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}};
            const last = options.messages.filter(message => message.role === "tool").at(-1);
            if (index === 1) {
                const large = options.messages.find(message => message.role === "tool" && message.tool_call_id === "read-a");
                expect(large?.content).toContain("persisted-output");
                expect(large?.content).not.toContain("a450:");
                if (mode === "save-failure") return blind();
                const artifact = await store.persistText({toolCallId: "read-a", toolName: "read_file", content: "ignored"});
                if (mode === "tampered") {
                    const bytes = await readFile(artifact.path);
                    bytes[bytes.length - 1] = 121;
                    await writeFile(artifact.path, bytes);
                }
                return assistantToolCall("read_file", {path: artifact.path, limit: 10}, "saved-log");
            }
            if (last?.tool_call_id === "saved-log") {
                expect(last.content).toContain("Saved output:");
                return blind();
            }
            if (last?.tool_call_id === "blind") {
                expect(last.content).toContain("前置条件未满足");
                if (mode === "save-failure" || mode === "tampered") return assistantText("日志不授权覆盖");
                return readSource();
            }
            if (last?.tool_call_id.startsWith("source-")) {
                if (mode === "partial") return assistantToolCall("edit_file", {path: "a.txt", edits: [{old_string: "a899:", new_string: "hidden:"}]}, "hidden");
                if (nextLine <= 900) return readSource();
                if (mode === "stale-source") await writeFile(join(cwd, "a.txt"), "external");
                return assistantToolCall("write_file", {path: "a.txt", content: "KNOWN"}, "known");
            }
            if (last?.tool_call_id === "hidden") {
                expect(last.content).toContain("未展示");
                return assistantToolCall("edit_file", {path: "a.txt", edits: [{old_string: "a0:", new_string: "visible:"}]}, "visible");
            }
            if (last?.tool_call_id === "visible") expect(last.content).toContain("已修改");
            if (last?.tool_call_id === "known") expect(last.content).toContain(mode === "stale-source" ? "前置条件未满足" : "已写入");
            return assistantText("证据验证结束");
        }));
        await runAgentForTest("读三个文件，再修改 a", [], () => {}, ctx, {callLLM: fake.callLLM});
        const content = await readFile(join(cwd, "a.txt"), "utf8");
        if (mode === "pages") expect(content).toBe("KNOWN");
        else if (mode === "stale-source") expect(content).toBe("external");
        else expect(content).toContain("a899:");
        if (mode === "partial") expect(content.startsWith("visible:")).toBe(true);
    });
});

test.each(["failed", "cancelled", "iteration-limit", "compacted"])("未交付的文件正文不授权写入 %s", async mode => {
    await withTempProject(async cwd => {
        const path = join(cwd, "file.txt");
        await writeFile(path, "original");
        const controller = createTurnAbortController();
        const ctx = createTestContext(cwd, {signal: controller.signal});
        let compacted = false;
        const read = assistantToolCall("read_file", {path}, "read");
        const fake = createFakeLLM([
            {...read, ...(mode === "compacted" ? {contextUsage: {inputTokens: 7600, tokenCount: 7600, contextWindow: 10_000}} : {})},
            options => {
                if (mode === "failed") throw new Error("offline failure");
                if (mode === "cancelled") controller.abort("user-cancel");
                if (mode === "compacted") expect(options.messages.some(message => message.role === "tool")).toBe(false);
                return assistantText("停止");
            },
        ]);
        const running = runAgentForTest("读取", [], () => {}, ctx, {
            callLLM: fake.callLLM,
            ...(mode === "iteration-limit" ? {maxIterations: 1} : {}),
            compactHistory: async ({history, preTokenCount}) => {
                compacted = true;
                history.splice(0, history.length, {role: "user", origin: "user" as const, content: "已压缩，正文未保留"});
                return {compacted: true, preTokenCount, postTokenCount: 1, threshold: 1};
            },
        });
        if (mode === "failed") await expect(running).rejects.toThrow("offline failure");
        else await running;
        if (mode === "compacted") expect(compacted).toBe(true);
        const next = createTestContext(cwd, {fileState: ctx.fileState});
        const write = await executeToolResult("write_file", JSON.stringify({path, content: "blind"}), next, "write");
        expect(write.outcome).toBe("failed");
        expect(await readFile(path, "utf8")).toBe("original");
    });
});
