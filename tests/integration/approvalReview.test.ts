import {describe, expect, test} from "bun:test";
import {mkdir} from "node:fs/promises";
import {createApprovalReviewer} from "../../src/permissions/reviewer.js";
import {requestApproval, type ApprovalEvent} from "../../src/permissions/approval.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createFakeLLM, assistantText, assistantToolCall} from "../helpers/fakeLLM.js";
import {runAgentForTest} from "../helpers/agent.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {AgentRunner} from "../../src/agent/index.js";
import {NetworkAccessSession} from "../../src/permissions/networkAccess.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";

const verdict = (decision: "allow" | "deny" | "needs_user") => assistantText(JSON.stringify({decision, risk: "low", reason: "fixture decision"}));
function reviewer(fake: ReturnType<typeof createFakeLLM>) {
    const run: AgentRunner = (input, history, onEvent, ctx, inputChannel, options) =>
        runAgentForTest(input, history, onEvent, ctx, {...options, callLLM: fake.callLLM, inputChannel});
    return createApprovalReviewer(run);
}

describe("automatic approval through the production tool chain", () => {
    test("连续审核故障有界停止，不能无限重试模型，也不当作危险结论", async () => {
        await withTempProject(async cwd => {
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never"});
            let calls = 0;
            ctx.approvalReviewer = async () => {calls++; throw new Error("provider unavailable");};
            for (let i = 0; i < 3; i++) expect((await requestApproval(ctx, "bash", {command: "true"}, "review", `error-${i}`)).code).toBe("review_failed");
            expect(ctx.approvalBudget.stopped).toBe(true);
            expect(ctx.approvalBudget.stopMessage).toContain("repeatedly failed to complete");
            const result = await createToolRuntime().executeTool("bash", '{"command":"true"}', ctx, "fourth");
            expect(result.outcome).toBe("denied");
            expect(calls).toBe(3);
        });
    });
    test("Full Access 尊重 Host 上限，也不会替用户回答问题", async () => {
        await withTempProject(async cwd => {
            const rt = createToolRuntime();
            const restricted = createTestContext(cwd, {permissionMode: "full-access", allowFullAccess: false});
            expect((await rt.executeTool("write_file", '{"path":"no","content":"no"}', restricted, "host-denied")).outcome).toBe("denied");
            expect(await Bun.file(`${cwd}/no`).exists()).toBe(false);
            const ctx = createTestContext(cwd, {permissionMode: "full-access", permissionPromptPolicy: "never"});
            const result = await requestApproval(ctx, "ask_user", {questions: []}, "missing decision", "question");
            expect(result.code).toBe("approval_required");
            expect(result.decision.behavior).toBe("deny");
        });
    });
    test("后台网络审核使用任务生命周期，不借用已结束主 Turn 的交互或事件", async () => {
        await withTempProject(async cwd => {
            let trigger!: () => void;
            const ready = new Promise<void>(resolve => {trigger = resolve;});
            let allowed = false;
            const runner: ShellRunnerLike = {sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run(input) {
                    await ready;
                    expect(input.networkAccess?.canReview()).toBe(true);
                    const decision = await input.networkAccess!.canUseTool("bash", "network", {host: "example.com", port: 443},
                        {signal: input.signal, presentation: {kind: "network_access", host: "example.com", port: 443}});
                    allowed = decision.behavior === "allow";
                    return {stdout: "", stderr: "", termination: {kind: "exit", code: allowed ? 0 : 1, signal: null}};
                }};
            const controller = new AbortController();
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", signal: controller.signal, shellRunner: runner,
                canUseTool: async () => {throw new Error("old Turn must not ask");}});
            const fake = createFakeLLM([verdict("allow")]);
            ctx.approvalReviewer = reviewer(fake);
            ctx.networkAccess = new NetworkAccessSession();
            ctx.onApprovalEvent = () => {throw new Error("old Turn must not receive events");};
            const tasks = createTaskRuntimeForTest(cwd, runner);
            ctx.tasks = tasks.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
            try {
                const result = await createToolRuntime().executeTool("bash", '{"command":"fixture","run_in_background":true}', ctx, "background");
                expect(result.outcome).toBe("ok");
                controller.abort("user-cancel");
                ctx.setPermissionMode("ask");
                trigger();
                const deadline = Date.now() + 2000;
                while ((await ctx.tasks.list()).some(task => task.status === "running") && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                expect((await ctx.tasks.list())[0]?.status).toBe("completed");
                expect(allowed).toBe(true);
                expect(fake.calls).toHaveLength(1);
            } finally {trigger(); await tasks.close();}
        });
    });

    test.each(["allow", "deny", "needs_user"] as const)("无人工回调：%s 只决定当前越界写入", async decision => {
        await withTempProject(async root => {
            const cwd = `${root}/workspace`; await mkdir(cwd);
            const events: ApprovalEvent[] = [];
            const fake = createFakeLLM([verdict(decision)]);
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never",
                workspaceBoundary: root, directoryAccess: createDirectoryAccessRuntime({cwd, hardBoundary: root}),
                canUseTool: async () => {throw new Error("must not call absent human");}});
            ctx.approvalReviewer = reviewer(fake);
            ctx.approvalEvidence = () => [{role: "user", origin: "user", content: "Create ../result.txt with the approved result"}];
            ctx.onApprovalEvent = event => { events.push(event); };
            const result = await createToolRuntime().executeTool("write_file", JSON.stringify({path: "../result.txt", content: "result"}), ctx, "write");
            expect(result.outcome).toBe(decision === "allow" ? "ok" : "denied");
            expect(await Bun.file(`${root}/result.txt`).exists()).toBe(decision === "allow");
            expect(fake.calls).toHaveLength(1);
            expect(events.filter(event => event.source === "auto-review").map(event => event.phase)).toEqual(["start", "end"]);
            expect(events[1]?.outcome).toBe(decision);
            expect(await ctx.directoryAccess.canAccess(`${root}/another.txt`)).toBe(false);
        });
    });

    test("普通工作区修改不启动审核，Full Access 不调用人工审核", async () => {
        await withTempProject(async cwd => {
            let reviews = 0;
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", canUseTool: async () => {throw new Error("no human");}});
            ctx.approvalReviewer = async () => {reviews++; throw new Error("not expected");};
            const rt = createToolRuntime();
            expect((await rt.executeTool("write_file", '{"path":"inside","content":"ok"}', ctx, "inside")).outcome).toBe("ok");
            ctx.setPermissionMode("full-access");
            ctx.permissionRules.ask.push({toolName: "bash", source: "local"});
            expect((await rt.executeTool("bash", '{"command":"printf ok","sandbox_permissions":"require_escalated"}', ctx, "exec")).outcome).toBe("ok");
            expect(reviews).toBe(0);
        });
    });

    test("审核者可读取相关文件，不能执行 Bash、写入或再次审核", async () => {
        await withTempProject(async cwd => {
            await Bun.write(`${cwd}/evidence.txt`, "verified evidence");
            const fake = createFakeLLM([
                options => {
                    expect(options.tools?.map(tool => tool.function.name)).toEqual(["read_file", "bash"]);
                    return assistantToolCall("read_file", {path: "evidence.txt"}, "read");
                },
                options => {
                    expect(JSON.stringify(options.messages)).toContain("verified evidence");
                    return verdict("allow");
                },
            ]);
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never"});
            ctx.approvalReviewer = reviewer(fake);
            const resolution = await requestApproval(ctx, "bash", {command: "true"}, "review", "r");
            expect(resolution.source).toBe("auto-review");
            expect(resolution.decision.behavior).toBe("allow");
            expect(ctx.fileState).not.toBeUndefined();
        });
    });

    test("非法结论只修正一次，仍非法时返回 review_failed", async () => {
        await withTempProject(async cwd => {
            const fake = createFakeLLM([assistantText("sure go ahead"), assistantText('{"decision":"allow","extra":true}')]);
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never"});
            ctx.approvalReviewer = reviewer(fake);
            const resolution = await requestApproval(ctx, "bash", {command: "true"}, "review", "invalid");
            expect(resolution.code).toBe("review_failed");
            expect(resolution.decision.behavior).toBe("deny");
            expect(fake.calls).toHaveLength(2);
        });
    });

    test("审批期间权限变化使迟到的允许失效", async () => {
        await withTempProject(async cwd => {
            let release!: () => void;
            const held = new Promise<void>(resolve => {release = resolve;});
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never"});
            ctx.approvalReviewer = async () => {await held; return {decision: "allow", risk: "low", reason: "late"};};
            const result = requestApproval(ctx, "bash", {command: "true"}, "review", "late");
            await Promise.resolve();
            ctx.approvalEpoch.invalidate();
            release();
            await expect(result).rejects.toThrow();
        });
    });

    test("连续三次拒绝停止后续工具，不再请求模型", async () => {
        await withTempProject(async cwd => {
            const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never"});
            const fake = createFakeLLM([verdict("deny"), verdict("deny"), verdict("deny")]);
            ctx.approvalReviewer = reviewer(fake);
            for (let i = 0; i < 3; i++) expect((await requestApproval(ctx, "bash", {command: "true"}, "review", `d${i}`)).decision.behavior).toBe("deny");
            expect(ctx.approvalBudget.stopped).toBe(true);
            expect((await createToolRuntime().executeTool("write_file", '{"path":"no","content":"no"}', ctx, "blocked")).outcome).toBe("denied");
            expect(await Bun.file(`${cwd}/no`).exists()).toBe(false);
            expect(fake.calls).toHaveLength(3);
        });
    });
});
