import {expect, test} from "bun:test";
import {readFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {ensureSessionIdentity} from "../../src/persistence/storageIdentity.js";
import {getPromptLogDirectory, getProjectSessionsDirectory} from "../../src/persistence/layout.js";

for (const outcome of ["success", "invalid", "cancelled"] as const) {
    test(`reviewer ${outcome} logs belong to the parent and finish with completed request records`, async () => {
        await withTempProject(async (cwd, storage) => {
            const keyName = "HICODE_REVIEW_STORAGE_OFFLINE_KEY";
            const previousKey = process.env[keyName];
            const previousFetch = globalThis.fetch;
            const controller = new AbortController();
            let requests = 0;
            process.env[keyName] = "offline-fixture";
            globalThis.fetch = Object.assign(async () => {
                requests++;
                if (outcome === "cancelled") {
                    controller.abort("user-cancel");
                    throw new Error("offline cancellation");
                }
                const reply = outcome === "success" ? JSON.stringify({decision: "allow", risk: "low", reason: "offline review"}) : "invalid verdict";
                return new Response(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: reply}, finish_reason: "stop"}]})}\n\ndata: [DONE]\n\n`,
                    {headers: {"content-type": "text/event-stream"}});
            }, {preconnect() {}});
            const settings = createTestSettings();
            settings.models.primary = {source: "qwen", model: "qwen3.8-flash", label: "Offline Qwen"};
            settings.sources.qwen = {...settings.sources.qwen, apiKeyEnv: keyName};
            const resources = createTestRuntimeResources(cwd, {storage, settings});
            const parent = createTestContext(cwd, {sessionId: "parent", model: "qwen3.8-flash", provider: "qwen"});
            const id = randomUUID();
            try {
                await ensureSessionIdentity(storage, cwd, parent.sessionId);
                const operation = resources.agentRuntime.reviewApproval({id, kind: "tool", sessionId: parent.sessionId,
                        turnId: parent.turnId, toolCallId: "approval", toolName: "write_file", cwd,
                        input: {path: "file.txt", content: "x"}, reason: "test",
                        evidence: [{role: "user", origin: "hook_rejected", content: "REJECTED_AUTHORIZATION"},
                            {role: "user", origin: "user", content: "write file.txt"}]}, parent, controller.signal);
                if (outcome === "success") expect((await operation).decision).toBe("allow");
                else if (outcome === "invalid") await expect(operation).rejects.toThrow("Automatic review did not return a valid verdict");
                else await expect(operation).rejects.toBe("user-cancel");
                expect(requests).toBe(outcome === "invalid" ? 2 : 1);
                expect(await readdir(getProjectSessionsDirectory(storage, cwd))).toHaveLength(1);
                const directory = getPromptLogDirectory(storage, cwd, parent.sessionId);
                const runs = await readdir(directory);
                expect(runs).toHaveLength(1);
                const run = JSON.parse(await readFile(join(directory, runs[0]!, "run.json"), "utf8"));
                expect(run.trace).toMatchObject({scope: "session", sessionId: parent.sessionId, agentId: id, runId: id});
                expect(run.pending).toEqual([]);
                expect(run.completedAt).toBeDefined();
                const files = (await readdir(join(directory, runs[0]!))).filter(file => file !== "run.json");
                for (const file of files) expect(await readFile(join(directory, runs[0]!, file), "utf8")).not.toContain("REJECTED_AUTHORIZATION");
                await resources.close();
            } finally {
                await resources.close();
                globalThis.fetch = previousFetch;
                if (previousKey === undefined) delete process.env[keyName]; else process.env[keyName] = previousKey;
            }
        });
    });
}
