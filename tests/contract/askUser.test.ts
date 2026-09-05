import {describe, expect, test} from "bun:test";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

const questions = [{question: "选择方案", options: [{label: "A"}, {label: "B"}]}];

describe("ask_user answer provenance", () => {
    test("模型 schema 不含答案，模型预填答案在交互前拒绝", async () => {
        await withTempProject(async cwd => {
            const runtime = createToolRuntime();
            const schema = runtime.getToolSchemas().find(tool => tool.function.name === "ask_user");
            expect(JSON.stringify(schema?.function.parameters)).not.toContain('"answers"');
            expect(JSON.stringify(schema?.function.parameters)).not.toContain('"answer"');
            let interactions = 0;
            const ctx = createTestContext(cwd, {canUseTool: async () => {
                interactions++;
                return {behavior: "allow"};
            }});
            for (const input of [
                {questions, answers: {"选择方案": "MODEL"}},
                {questions: [{...questions[0], answer: "MODEL"}]},
                {questions: [questions[0], {...questions[0], question: " 选择方案 "}]},
            ]) {
                const result = await runtime.executeTool("ask_user", JSON.stringify(input), ctx, "invalid-question");
                expect(result.outcome).toBe("failed");
            }
            expect(interactions).toBe(0);
        });
    });

    test("只接受对应原问题的完整 Host 答案，自由文本答案可用", async () => {
        await withTempProject(async cwd => {
            const runtime = createToolRuntime();
            const invalidAnswers: Array<Record<string, string> | undefined> = [undefined, {}, {"别的问题": "A"}, {"选择方案": " "}, {"选择方案": "A", extra: "B"}];
            for (const answers of invalidAnswers) {
                const ctx = createTestContext(cwd, {canUseTool: async () => ({behavior: "allow", answers})});
                const result = await runtime.executeTool("ask_user", JSON.stringify({questions}), ctx, "missing-answers");
                expect(result.outcome).toBe("failed");
                expect(result.modelContent).not.toContain("用户回答:");
            }
            const ctx = createTestContext(cwd, {canUseTool: async () => ({behavior: "allow", answers: {"选择方案": "自定义方案"}})});
            const result = await runtime.executeTool("ask_user", JSON.stringify({questions}), ctx, "answered");
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain('"选择方案"="自定义方案"');
        });
    });

    test("取消不消费答案，批准也不能替换问题", async () => {
        await withTempProject(async cwd => {
            const runtime = createToolRuntime();
            const changed = createTestContext(cwd, {canUseTool: async () => ({
                behavior: "allow", updatedInput: {questions, answers: {"选择方案": "A"}},
            })});
            const result = await runtime.executeTool("ask_user", JSON.stringify({questions}), changed, "replace-question");
            expect(result.outcome).toBe("denied");
            const abort = new AbortController();
            const cancelled = createTestContext(cwd, {signal: abort.signal, canUseTool: async () => {
                abort.abort("user-cancel");
                return {behavior: "allow", answers: {"选择方案": "A"}};
            }});
            expect((await runtime.executeTool("ask_user", JSON.stringify({questions}), cancelled, "cancel-answer")).outcome).toBe("interrupted");
        });
    });

    test("Host 不能通过修改提问对象的引用替换批准对象，多题答案保持原题序", async () => {
        await withTempProject(async cwd => {
            const runtime = createToolRuntime();
            const ctx = createTestContext(cwd, {canUseTool: async (_name, _message, input) => {
                const received = input as {questions: typeof questions};
                received.questions[0]!.question = "被修改的问题";
                return {behavior: "allow", answers: {"被修改的问题": "A"}};
            }});
            expect((await runtime.executeTool("ask_user", JSON.stringify({questions}), ctx, "mutated-reference")).outcome).toBe("failed");
            const second = {...questions[0], question: "选择环境"};
            const answered = createTestContext(cwd, {canUseTool: async () => ({
                behavior: "allow", answers: {"选择环境": "B", "选择方案": "A"},
            })});
            const result = await runtime.executeTool("ask_user", JSON.stringify({questions: [...questions, second]}), answered, "two-answers");
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toBe('用户回答: "选择方案"="A", "选择环境"="B"');
        });
    });
});
