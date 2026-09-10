import {expect, spyOn, test} from "bun:test";
import {z} from "zod";
import {createAgentRunner} from "../../src/agent/index.js";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {runRootTurn} from "../../src/runtime/turnRuntime.js";
import {SessionUIEventCollector, loadSession} from "../../src/session/index.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";

for (const outcome of ["success", "denied", "cancel", "tool-error", "model-error"] as const) {
    test(`真实 Root/ToolRuntime 的计时与 Session 保存：${outcome}`, async () => {
        await withTempProject(async cwd => {
            let now = 0;
            const clock = spyOn(performance, "now").mockImplementation(() => now);
            const controller = new AbortController();
            const collector = new SessionUIEventCollector();
            let toolCalls = 0;
            const toolRuntime = createToolRuntime({additionalTools: [{
                name: "timed_action", description: "test action", parameters: z.object({}),
                async execute() {
                    toolCalls++;
                    now += 300;
                    if (outcome === "tool-error") throw new Error("tool failed");
                    return "done";
                },
            }]});
            const resources = createTestRuntimeResources(cwd, {toolRuntime});
            const fake = createFakeLLM([
                () => {
                    now += 100;
                    if (outcome === "model-error") throw new Error("connection failed");
                    return assistantToolCall("timed_action", {});
                },
                () => {now += 200; return assistantText("任务结果已记录。");},
            ]);
            resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM,
                compactHistory: resources.agentRuntime.compactHistory});
            const sessionId = `timing-${outcome}`;
            const session = createRootSessionRuntime({resources, seed: {
                sessionId, history: [{role: "system", content: "test"}], compactState: createCompactState(),
            }, resumed: false});
            try {
                const run = runRootTurn({resources, session, prompt: "执行一次操作", signal: controller.signal,
                    host: {
                        async canUseTool() {
                            now += 400;
                            if (outcome === "cancel") controller.abort("user-cancel");
                            return outcome === "denied" || outcome === "cancel"
                                ? {behavior: "deny", message: "no"}
                                : {behavior: "allow"};
                        },
                        getPermissionRules: () => ({allow: [], ask: [], deny: []}),
                        getPermissionMode: () => "ask", getCollaborationMode: () => "build",
                        getPermissionPromptPolicy: () => "onRequest", setTodos() {},
                    },
                    onEvent: event => collector.handleEvent(event), onHookResult() {},
                    onLifecycleIssue(issue) {throw issue.error;},
                    getSnapshotState: () => ({todos: [], permissionMode: "ask", collaborationMode: "build",
                        uiEvents: collector.getEvents()}),
                });
                if (outcome === "model-error") await expect(run).rejects.toThrow("connection failed");
                else await run;
                const timings = collector.getEvents().filter(event => event.type === "turn_timing");
                expect(timings).toHaveLength(1);
                const summary = timings[0]!.timing;
                expect(summary.modelMs).toBe(outcome === "cancel" || outcome === "model-error" ? 100 : 300);
                expect(summary.approvalMs).toBe(outcome === "model-error" ? 0 : 400);
                expect(summary.toolMs).toBe(outcome === "success" || outcome === "tool-error" ? 300 : 0);
                expect(toolCalls).toBe(summary.toolMs > 0 ? 1 : 0);
                expect(summary.overlapMs).toBe(0);
                const restored = loadSession(resources.storage, cwd, sessionId, resources.model);
                expect(restored?.uiEvents.filter(event => event.type === "turn_timing")).toEqual(timings);
                expect(JSON.stringify(session.history)).not.toContain("approvalMs");
            } finally {
                clock.mockRestore();
                await resources.close();
            }
        });
    });
}
