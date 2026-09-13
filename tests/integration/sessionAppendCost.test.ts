import {expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createSessionPersistence, loadSession} from "../../src/session/storage.js";
import {prepareSessionArchive} from "../../src/session/archive.js";
import {getSessionSnapshotPath} from "../../src/session/paths.js";
import {getSessionContentDirectory} from "../../src/persistence/layout.js";
import type {SaveSessionSnapshotInput} from "../../src/session/types.js";

for (const archived of [false, true]) test(`追加不重新读取/编码既有正文，archived=${archived}`, async () => {
    await withTempProject(async (cwd, storage) => {
        for (const size of [256 * 1024, 8 * 1024 * 1024]) {
            const sessionId = `cost-${size}`;
            const writer = createSessionPersistence(storage, cwd, sessionId);
            let input: SaveSessionSnapshotInput = {cwd, sessionId, model: "glm-test", todos: [], permissionMode: "ask", collaborationMode: "build",
                history: [{role: "user", origin: "user", content: "原始任务"},
                    ...Array.from({length: 4}, (_, n) => ({role: "assistant" as const, content: `${n}:` + "x".repeat(size / 4)}))]};
            await writer.save(input);
            if (archived) {
                const draft = prepareSessionArchive(storage, cwd, sessionId, input.history);
                input = {...input, compactState: {compactCount: 1, consecutiveFailures: 0, archives: [draft.record]},
                    history: [{role: "user", origin: "compaction", content: "交接摘要"}, input.history[0]!]};
                await writer.compact(input, draft, new AbortController().signal);
            }
            const reads = spyOn(fs, "readFileSync");
            const encodes = spyOn(JSON, "stringify");
            let readBytes = 0, encodedBytes = 0;
            try {
                await writer.save({...input, history: [...input.history, {role: "assistant", content: "新增结果"}]});
                readBytes = reads.mock.results.reduce((sum, result) => sum + (result.type === "return" && Buffer.isBuffer(result.value) ? result.value.length : 0), 0);
                encodedBytes = encodes.mock.results.reduce((sum, result) => sum + (result.type === "return" && typeof result.value === "string" ? Buffer.byteLength(result.value) : 0), 0);
            } finally {reads.mockRestore(); encodes.mockRestore();}
            expect(readBytes).toBeLessThan(64 * 1024);
            expect(encodedBytes).toBeLessThan(64 * 1024);
            expect(loadSession(storage, cwd, sessionId, "glm-test")?.history.at(-1)?.content).toBe("新增结果");
        }
    });
});

test("跨提交缓存不能掩盖磁盘内容被篡改", async () => {
    await withTempProject(async (cwd, storage) => {
        const writer = createSessionPersistence(storage, cwd, "tamper");
        const input: SaveSessionSnapshotInput = {cwd, sessionId: "tamper", model: "glm-test", todos: [], permissionMode: "ask", collaborationMode: "build",
            history: [{role: "user", origin: "user", content: "original"}]};
        await writer.save(input);
        const record: {conversation: string[]} = JSON.parse(await readFile(getSessionSnapshotPath(storage, cwd, "tamper"), "utf8"));
        await writeFile(join(getSessionContentDirectory(storage, cwd, "tamper"), `${record.conversation[0]}.json`), '{}');
        await expect(writer.save(input)).rejects.toThrow("changed since last commit");
        expect(() => loadSession(storage, cwd, "tamper", "glm-test")).toThrow();
    });
});
