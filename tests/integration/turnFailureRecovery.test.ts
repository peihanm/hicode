import {expect, test} from "bun:test";
import {stat} from "node:fs/promises";
import {join} from "node:path";
import {runRootTurn} from "../../src/runtime/turnRuntime.js";
import {loadSession} from "../../src/session/storage.js";
import {hasCompleteToolPairs} from "../../src/session/codec.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactState} from "../../src/context/state.js";
import {withTempProject} from "../helpers/tempProject.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";

for (const failureEvent of ["token_update", "assistant_text"] as const) {
    test(`failure in ${failureEvent} before the batch closes all calls and saves recoverable History`, async () => {
        await withTempProject(async (cwd, storage) => {
            const response = assistantToolCall("bash", {command: "printf executed > marker"}, "pending", "Starting");
            const second = assistantToolCall("bash", {command: "printf second > marker"}, "pending-second").message.tool_calls![0]!;
            response.message.tool_calls!.push(second);
            const fake = createFakeLLM([response, assistantText("recovered")]);
            const fixture = continuityFixture(cwd, storage, fake.callLLM);
            const run = {resources: fixture.resources, session: fixture.session, host: continuityHost,
                signal: new AbortController().signal, getSnapshotState: continuityState,
                onHookResult() {}, onLifecycleIssue(issue: {error: unknown}) {throw issue.error;}};
            try {
                await expect(runRootTurn({...run, prompt: "first", onEvent(event) {
                    if (event.type === failureEvent) throw new Error("projection failed");
                }})).rejects.toThrow("projection failed");
                expect(hasCompleteToolPairs(fixture.session.history)).toBe(true);
                expect(fixture.session.history).toContainEqual({role: "tool", tool_call_id: "pending",
                    content: "Tool was not executed because the turn failed: projection failed"});
                expect(fixture.session.history).toContainEqual({role: "tool", tool_call_id: "pending-second",
                    content: "Tool was not executed because the turn failed: projection failed"});
                await expect(stat(join(cwd, "marker"))).rejects.toMatchObject({code: "ENOENT"});
                const loaded = loadSession(storage, cwd, fixture.session.sessionId)!;
                expect(loaded.history.slice(1)).toEqual(fixture.session.history.slice(1));
                const resumed = createRootSessionRuntime({resources: fixture.resources, seed: {
                    sessionId: loaded.sessionId, history: loaded.history, compactState: loaded.compactState ?? createCompactState(),
                }});
                expect((await runRootTurn({...run, session: resumed, prompt: "second", onEvent() {}})).reply).toBe("recovered");
                expect(fake.calls).toHaveLength(2);
                expect(hasCompleteToolPairs(fake.calls[1]!.messages)).toBe(true);
            } finally {await fixture.resources.close();}
        });
    });
}

test("an incomplete input History fails closed before invoking a model or appending input", async () => {
    await withTempProject(async (cwd, storage) => {
        const orphan = assistantToolCall("bash", {command: "true"}, "orphan").message;
        const fake = createFakeLLM([assistantText("must not run")]);
        const fixture = continuityFixture(cwd, storage, fake.callLLM, [{role: "system", content: "test"}, orphan]);
        try {
            await expect(runRootTurn({resources: fixture.resources, session: fixture.session, host: continuityHost,
                signal: new AbortController().signal, prompt: "next", getSnapshotState: continuityState,
                onEvent() {}, onHookResult() {}, onLifecycleIssue() {}})).rejects.toThrow("incomplete Tool Call pairs");
            expect(fake.calls).toHaveLength(0);
            expect(fixture.session.history).toHaveLength(2);
        } finally {await fixture.resources.close();}
    });
});
