import {expect, test} from "bun:test";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {loadSession} from "../../src/session/storage.js";
import {getSessionSnapshotPath} from "../../src/session/paths.js";
import {hasCompleteToolPairs} from "../../src/session/codec.js";
import {runRootTurn} from "../../src/runtime/turnRuntime.js";

for (const mode of ["batch", "half"]) test(`真实子进程强制退出后恢复 ${mode}`, async () => {
    await withTempProject(async (cwd, storage) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/batchDurability.ts", import.meta.url)), cwd, mode],
            {stdio: ["ignore", "pipe", "pipe"], env: {PATH: process.env.PATH}});
        const closed = once(child, "close");
        let stderr = "";
        child.stderr.on("data", chunk => {stderr += String(chunk);});
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        let observed = "";
        try {
            for await (const chunk of child.stdout) {
                observed += String(chunk);
                if (observed.includes(mode === "batch" ? "BATCH_SAVED" : "HALF_EXECUTED")) {child.kill("SIGKILL"); break;}
            }
            await closed;
            expect(stderr).toBe("");
            expect(observed).toContain(mode === "batch" ? "BATCH_SAVED" : "HALF_EXECUTED");
            expect(await readFile(join(cwd, "written.txt"), "utf8")).toBe("side effect");
            const loaded = loadSession(storage, cwd, "continuity", "glm-test")!;
            expect(loaded).not.toBeNull();
            expect(hasCompleteToolPairs(loaded.history)).toBe(true);
            expect(loaded.history.filter(message => message.role === "tool")).toHaveLength(mode === "batch" ? 1 : 0);
            // Loading the record cannot replay or reverse an uncertain write.
            expect(await readFile(join(cwd, "written.txt"), "utf8")).toBe("side effect");
        } finally {clearTimeout(timer); child.kill("SIGKILL"); await closed;}
    });
}, 10000);

test("批次保存失败后停止下一次模型调用，已执行文件不回滚", async () => {
    await withTempProject(async (cwd, storage) => {
        const fake = createFakeLLM([assistantToolCall("write_file", {path: "written.txt", content: "saved"}, "write"), assistantText("不应请求")]);
        const f = continuityFixture(cwd, storage, fake.callLLM);
        try {
            await expect(runRootTurn({resources: f.resources, session: f.session, prompt: "write", signal: new AbortController().signal,
                host: continuityHost, async onEvent(event) {
                    if (event.type === "tool_call_end") await writeFile(getSessionSnapshotPath(storage, cwd, f.session.sessionId), "broken");
                }, onHookResult() {}, onLifecycleIssue() {}, getSnapshotState: continuityState})).rejects.toThrow("Invalid Session snapshot JSON");
            expect(fake.calls).toHaveLength(1);
            expect(await readFile(join(cwd, "written.txt"), "utf8")).toBe("saved");
        } finally {await f.resources.close();}
    });
});
