import {expect, test} from "bun:test";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {PermissionRequests} from "../../src/permissions/requests.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

const state = {todos: [], uiEvents: [], permissionMode: "ask" as const};
const input = JSON.stringify({delivery: "async", questions: [{question: "Address?"}]});

test("async question returns before the Host answers; late answers keep their request identity and user provenance", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        // SDK also disables background tasks; questions remain available when Host supports interaction.
        const session = createRootSessionRuntime({resources, allowBackgroundTasks: false,
            seed: {sessionId: "async-questions", history: [{role: "system", content: "test"}], compactState: createCompactState()}});
        const requests = new PermissionRequests();
        const controller = new AbortController();
        const ctx = session.createContext({signal: controller.signal, onEvent() {}, getSnapshotState: () => state,
            host: {canUseTool: (...args) => requests.request(...args), setTodos() {}, getPermissionMode: () => "ask",
                getPermissionRules: () => ({allow: [], ask: [], deny: []}), getPermissionPromptPolicy: () => "onRequest"}});
        try {
            await session.initialize();
            await session.beginTurn("test", state);
            const result = await resources.toolRuntime.executeTool("ask_user", input, ctx, "question-1");
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain("question-1");
            expect(session.messageQueue.list()).toHaveLength(0);
            const pending = requests.getQuestionSnapshot()!;
            expect(pending.questionDelivery).toBe("async");
            session.endTurn();
            pending.resolve({behavior: "allow", answers: {"Address?": "localhost"}});
            requests.clear(pending);
            await new Promise(resolve => setTimeout(resolve, 30));
            const messages = session.messageQueue.list();
            expect(messages).toHaveLength(1);
            expect(messages[0]!.type).toBe("user_answer");
            expect(messages[0]!.content).toContain('question-1');
            expect(messages[0]!.content).toContain('"Address?"="localhost"');
            pending.resolve({behavior: "allow", answers: {"Address?": "duplicate"}});
            expect(session.messageQueue.list()).toHaveLength(1);
            await session.flushSnapshots();
            expect(session.takeStorageIssues()).toEqual([]);

            await resources.toolRuntime.executeTool("ask_user", input, ctx, "question-2");
            const declined = requests.getQuestionSnapshot()!;
            declined.resolve({behavior: "deny", message: "Dismissed"}); requests.clear(declined);
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(session.messageQueue.list()[1]!.type).toBe("runtime_message");
            expect(session.messageQueue.list()[1]!.content).toContain("No answer or authorization");

            await resources.toolRuntime.executeTool("ask_user", input, ctx, "question-3");
            const cancelled = requests.getQuestionSnapshot()!;
            controller.abort("user-cancel");
            cancelled.resolve({behavior: "allow", answers: {"Address?": "late"}});
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(requests.getQuestionSnapshot()).toBeNull();
            expect(session.messageQueue.list()).toHaveLength(2);
        } finally {requests.dispose(); await session.runSessionEnd("test"); await resources.close();}
    });
});

test("async requests are bounded and Session close cancels outstanding Host requests without accepting late answers", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        const session = createRootSessionRuntime({resources, seed: {sessionId: "closing-questions",
            history: [{role: "system", content: "test"}], compactState: createCompactState()}});
        const requests = new PermissionRequests();
        const ctx = session.createContext({signal: new AbortController().signal, onEvent() {}, getSnapshotState: () => state,
            host: {canUseTool: (...args) => requests.request(...args), setTodos() {}, getPermissionMode: () => "full-access",
                getPermissionRules: () => ({allow: [], ask: [], deny: []}), getPermissionPromptPolicy: () => "onRequest"}});
        try {
            await session.initialize();
            for (let i = 0; i < 4; i++) {
                expect((await resources.toolRuntime.executeTool("ask_user", input, ctx, `q-${i}`)).outcome).toBe("ok");
            }
            const pending = requests.getQuestionSnapshot()!;
            expect(pending).not.toBeNull();
            expect((await resources.toolRuntime.executeTool("ask_user", input, ctx, "q-5")).outcome).toBe("failed");
            expect(session.messageQueue.list()).toHaveLength(0);
            await session.runSessionEnd("test");
            expect(requests.getQuestionSnapshot()).toBeNull();
            pending.resolve({behavior: "allow", answers: {"Address?": "late"}});
            await Bun.sleep(10);
            expect(session.messageQueue.list()).toHaveLength(0);
        } finally {requests.dispose(); await resources.close();}
    });
});
