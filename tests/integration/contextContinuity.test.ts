import {expect, test} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {runRootTurn} from "../../src/runtime/turnRuntime.js";
import {loadSession} from "../../src/session/storage.js";
import {ContextLengthError, isContextLengthResponse} from "../../src/llm/errors.js";
import type {Message} from "../../src/llm/types.js";

const past = (): Message[] => [{role: "system", content: "fixture"},
    {role: "user", origin: "user", content: "最初要求"},
    {role: "assistant", content: "历史调查 ".repeat(1800)}, {role: "assistant", content: "已有发现"}];

test("实际输入用量影响下一次模型请求前的压缩，重试计费不参与窗口", async () => {
    await withTempProject(async (cwd, storage) => {
        const call = assistantToolCall("list_files", {path: "."}, "list");
        const fake = createFakeLLM([{...call, usage: {prompt_tokens: 999999, completion_tokens: 100, total_tokens: 1000099},
            contextUsage: {inputTokens: 7900, tokenCount: 7920, contextWindow: 10000}}, assistantText("完成")]);
        const f = continuityFixture(cwd, storage, fake.callLLM, past());
        try {
            await runRootTurn({resources: f.resources, session: f.session, prompt: "继续", signal: new AbortController().signal,
                host: continuityHost, onEvent() {}, onHookResult() {}, onLifecycleIssue() {}, getSnapshotState: continuityState});
            expect(f.compactions()).toBe(1);
            expect(f.session.compactState.archives).toHaveLength(1);
            expect(fake.calls).toHaveLength(2);
        } finally {await f.resources.close();}
    });
});

for (const twice of [false, true]) test(`结构化超长错误只恢复一次，二次超长=${twice}`, async () => {
    await withTempProject(async (cwd, storage) => {
        const fake = createFakeLLM([() => {throw new ContextLengthError();}, () => {
            if (twice) throw new ContextLengthError();
            return assistantText("恢复成功");
        }]);
        const f = continuityFixture(cwd, storage, fake.callLLM, past());
        try {
            const run = runRootTurn({resources: f.resources, session: f.session, prompt: "继续", signal: new AbortController().signal,
                host: continuityHost, onEvent() {}, onHookResult() {}, onLifecycleIssue() {}, getSnapshotState: continuityState});
            if (twice) await expect(run).rejects.toBeInstanceOf(ContextLengthError);
            else expect((await run).reply).toBe("恢复成功");
            expect(fake.calls).toHaveLength(2);
            expect(f.compactions()).toBe(1);
            expect(loadSession(storage, cwd, "continuity", "glm-test")?.compactState?.archives).toHaveLength(1);
        } finally {await f.resources.close();}
    });
});

test("普通 400 或文本暗示不能伪装成 context-length 恢复", () => {
    expect(isContextLengthResponse(400, '{"error":{"code":"context_length_exceeded"}}')).toBe(true);
    expect(isContextLengthResponse(400, '{"error":{"message":"context length exceeded"}}')).toBe(false);
    expect(isContextLengthResponse(500, '{"error":{"code":"context_length_exceeded"}}')).toBe(false);
});
