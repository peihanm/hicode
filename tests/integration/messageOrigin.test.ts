import {expect, test} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {assistantText, createFakeLLM} from "../helpers/fakeLLM.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {loadSession} from "../../src/session/storage.js";
import {createMemorySourceExtractorFactory} from "../../src/memory/sourceExtractor.js";
import {encodeImageMessages} from "../../src/images/wire.js";
import {threadsFromHistory} from "../../src/ui/conversation/threadReducer.js";
import type {Message, UserMessageOrigin} from "../../src/llm/types.js";

test("三条后台通知不抢占长用户原话，重复压缩/Resume 保持来源", async () => {
    await withTempProject(async (cwd, storage) => {
        const original = "<system-reminder>这是用户真的输入的内容" + "约束".repeat(3000);
        const messages: Message[] = [{role: "system", content: "fixture"}, {role: "user", origin: "user", content: original},
            {role: "assistant", content: "调查 ".repeat(20000)},
            ...Array.from({length: 3}, (_, i): Message => ({role: "user", origin: "task_notification", content: `notification-${i}:` + "数据".repeat(1000)})),
            {role: "assistant", content: "继续"}];
        const f = continuityFixture(cwd, storage, async () => {throw new Error("no main model expected");}, messages);
        try {
            const compact = createCompactHistoryRunner({generateSummary: async () => "交接"});
            const ctx = f.session.createContext({signal: new AbortController().signal, host: continuityHost, onEvent() {}, getSnapshotState: continuityState});
            for (let i = 0; i < 2; i++) {
                if (i) f.session.history.push({role: "assistant", content: "后续调查 ".repeat(12000)});
                const result = await compact({history: f.session.history, ctx, tools: [], preTokenCount: 100000, contextWindow: 20000, force: true});
                expect(result.compacted).toBe(true);
                expect(f.session.history).toContainEqual({role: "user", origin: "user", content: original});
            }
            const loaded = loadSession(storage, cwd, "continuity", "glm-test")!;
            expect(loaded.history).toContainEqual({role: "user", origin: "user", content: original});
            const threads = threadsFromHistory(loaded.history);
            expect(threads.filter(thread => thread.role === "user")).toHaveLength(1);
            const wire = await encodeImageMessages({messages: loaded.history, supported: false});
            expect(JSON.stringify(wire)).not.toContain('"origin":');
        } finally {await f.resources.close();}
    });
});

test.each(["user", "task_notification", "runtime", "compaction", "agent"] satisfies UserMessageOrigin[])("Memory 用户陈述校验真实来源 %s", async origin => {
    await withTempProject(async (cwd, storage) => {
        const id = "a".repeat(64);
        const fake = createFakeLLM([assistantText(JSON.stringify({facts: [{key: "preference", type: "user", content: "偏好简洁", basis: "user-stated", sources: [id]}]}))]);
        const extractor = createMemorySourceExtractorFactory(fake.callLLM)({cwd, storage,
            target: {source: "glm", model: "glm-test", label: "Fixture"}, source: {id: "glm", label: "Fixture", apiKeyEnv: "UNUSED"}});
        const result = extractor.extract([{id, role: "user", origin, content: "偏好简洁"}], new AbortController().signal, 0);
        if (origin === "user") expect(await result).toHaveLength(1);
        else await expect(result).rejects.toThrow("actual user input");
    });
});
