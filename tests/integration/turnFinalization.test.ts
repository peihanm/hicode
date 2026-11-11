import {expect, test, spyOn} from "bun:test";
import {createRootTurnRunnerFactory} from "../../src/runtime/turnRuntime.js";
import type {HookInput} from "../../src/hooks/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {createFakeLLM, assistantText} from "../helpers/fakeLLM.js";

test.each([false, true])("failed Turn reports persistence accurately (saveFailure=%s) without hiding the original error", async saveFailure => {
    await withTempProject(async (cwd, storage) => {
        const fake = createFakeLLM([() => {throw new Error("original provider failure");}]);
        const fixture = continuityFixture(cwd, storage, fake.callLLM);
        const outcomes: Array<Extract<HookInput, {hook_event_name: "TurnEnd"}>> = [];
        const run = createRootTurnRunnerFactory(saveFailure ? {saveSession: async () => {throw new Error("save failed");}} : {});
        try {
            await expect(run({resources: fixture.resources, session: fixture.session, host: continuityHost,
                signal: new AbortController().signal, prompt: "test", getSnapshotState: continuityState,
                onEvent() {}, onHookResult() {}, onLifecycleIssue() {},
                onTurnFinalized(outcome) {outcomes.push(outcome); throw new Error("observer failed");},
            })).rejects.toThrow("original provider failure");
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0]).toMatchObject({status: "failed", reason: "error", persistence_status: saveFailure ? "failed" : "saved"});
        } finally {await fixture.resources.close();}
    });
});

test("cancellation still finalizes exactly once after saving", async () => {
    await withTempProject(async (cwd, storage) => {
        const controller = new AbortController();
        const fake = createFakeLLM([() => {controller.abort("user-cancel"); throw new Error("cancelled provider");}]);
        const fixture = continuityFixture(cwd, storage, fake.callLLM);
        const outcomes: Array<Extract<HookInput, {hook_event_name: "TurnEnd"}>> = [];
        try {
            await expect(createRootTurnRunnerFactory()({resources: fixture.resources, session: fixture.session, host: continuityHost,
                signal: controller.signal, prompt: "test", getSnapshotState: continuityState,
                onEvent() {}, onHookResult() {}, onLifecycleIssue() {},
                onTurnFinalized(outcome) {outcomes.push(outcome);},
            })).resolves.toMatchObject({reason: "interrupted"});
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0]).toMatchObject({status: "cancelled", reason: "user-cancel", persistence_status: "saved"});
        } finally {await fixture.resources.close();}
    });
});


test.each([false, true])("TurnEnd uses the Session Hook scope without reconstructing ToolContext (earlyFailure=%s)", async earlyFailure => {
    await withTempProject(async (cwd, storage) => {
        const fixture = continuityFixture(cwd, storage, createFakeLLM([assistantText("done")]).callLLM);
        const contexts = spyOn(fixture.session, "createContext");
        const hooks: Array<{input: HookInput; session: unknown}> = [];
        const hookSpy = spyOn(fixture.resources.hooks, "execute").mockImplementation(async (input, _signal, context) => {
            hooks.push({input, session: context?.session});
            return {blocked: false, additionalContexts: [], executions: []};
        });
        const initialization = earlyFailure ? spyOn(fixture.session, "initialize").mockRejectedValue(new Error("initialization failed")) : undefined;
        try {
            const result = createRootTurnRunnerFactory()({resources: fixture.resources, session: fixture.session,
                host: continuityHost, signal: new AbortController().signal, turnId: "single-context", prompt: "test",
                getSnapshotState: continuityState, onEvent() {}, onHookResult() {}, onLifecycleIssue() {}});
            if (earlyFailure) await expect(result).rejects.toThrow("initialization failed");
            else await expect(result).resolves.toMatchObject({reason: "completed"});
            expect(contexts).toHaveBeenCalledTimes(earlyFailure ? 0 : 1);
            const end = hooks.filter(hook => hook.input.hook_event_name === "TurnEnd");
            expect(end).toHaveLength(1);
            expect(end[0]!.input).toMatchObject({session_id: fixture.session.sessionId, turn_id: "single-context",
                status: earlyFailure ? "failed" : "completed"});
            if (!earlyFailure) expect(end[0]!.session).toBe(hooks[0]!.session);
        } finally {
            initialization?.mockRestore(); contexts.mockRestore(); hookSpy.mockRestore();
            await fixture.resources.close();
        }
    });
});
