import type {Message} from "../../src/llm/types.js";
import type {SubagentResult} from "../../src/subagents/types.js";
import {expect, test} from "bun:test";
import {mkdir, readFile, symlink, writeFile, stat, truncate, unlink} from "node:fs/promises";
import {dirname, relative} from "node:path";
import {SubagentTranscript} from "../../src/subagents/transcript.js";
import {getSubagentRecordPaths} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";

const start = {parentToolCallId: "call", agentType: "Worker", description: "test", model: "fixture", cwd: "/fixture", allowedTools: ["read_file"]};
const result: SubagentResult = {agentId: "agent", agentType: "Worker", description: "test", reply: "first",
    reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};

test("record identities cannot escape storage; start is recorded once and streaming drafts are omitted", async () => {
    await withTempProject(async (cwd, storage) => {
        const paths = getSubagentRecordPaths(storage, cwd, "../../parent", "../../../agent");
        const transcript = new SubagentTranscript(storage, cwd, "../../parent", "../../../agent");
        expect(relative(cwd, paths.events).startsWith("..")).toBe(false);
        expect(paths.events).not.toContain("../");
        await Promise.all([transcript.start(start), transcript.start(start)]);
        await transcript.recordEvent({type: "iteration", current: 1, max: 2});
        await transcript.recordEvent({type: "assistant_draft", responseId: "response", text: "private draft", truncated: false});
        await transcript.start(start);
        const entries = (await readFile(paths.events, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(entries.map(entry => entry.type)).toEqual(["start", "event"]);
        expect(entries[1].event.type).toBe("iteration");
    });
});

test("symlink transcript failure preserves the target and disables retries without losing the generated report", async () => {
    await withTempProject(async (cwd, storage) => {
        const paths = getSubagentRecordPaths(storage, cwd, "parent", "agent");
        const transcript = new SubagentTranscript(storage, cwd, "parent", "agent");
        const target = `${cwd}/private-target.txt`;
        await writeFile(target, "private\n");
        await mkdir(dirname(paths.events), {recursive: true});
        await symlink(target, paths.events);
        await transcript.start(start);
        expect(await readFile(target, "utf8")).toBe("private\n");
        await unlink(paths.events);
        await transcript.start(start);
        await transcript.recordEvent({type: "iteration", current: 1, max: 2});
        const report = await transcript.finish([], result);
        expect(report.reply).toBe("first");
        expect(report.transcriptPath).toBeUndefined();
        expect(report.transcriptIssue).toContain("incomplete or unavailable");
        await expect(stat(paths.events)).rejects.toThrow();
    });
});

test("followups preserve history deltas while latest state contains only report metadata and record paths", async () => {
    await withTempProject(async (cwd, storage) => {
        const paths = getSubagentRecordPaths(storage, cwd, "parent", "agent");
        const transcript = new SubagentTranscript(storage, cwd, "parent", "agent");
        await transcript.start(start);
        const history: Message[] = [{role: "user", origin: "user", content: "x".repeat(100_000)}];
        let report: SubagentResult = result;
        for (let i = 0; i < 10; i++) {
            history.push({role: "assistant", content: `reply ${i}`});
            await transcript.start(start);
            report = await transcript.finish(history, result);
        }
        expect((await stat(paths.events)).size).toBeLessThan(130_000);
        const state = JSON.parse(await readFile(paths.state, "utf8"));
        expect(state.version).toBe(2);
        expect(state).not.toHaveProperty("history");
        expect(state.result).toEqual(report);
        expect(state.conversationPath).toBe(paths.conversation);
        expect((await stat(paths.state)).size).toBeLessThan(3000);
        const events = (await readFile(paths.events, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(events.filter(event => event.type === "start")).toHaveLength(1);
        const snapshots = events.filter(event => event.type === "snapshot");
        expect(snapshots[1].historyDelta.retained).toBe(2);
        expect(snapshots[1].historyDelta.appended).toHaveLength(1);
        let restored: Message[] = [];
        for (const event of snapshots) restored = [...restored.slice(0, event.historyDelta.retained), ...event.historyDelta.appended];
        expect(restored).toEqual(history);
    });
});

test("failed history append keeps prior state and returns an honest report without a transcript path", async () => {
    await withTempProject(async (cwd, storage) => {
        const paths = getSubagentRecordPaths(storage, cwd, "parent", "agent");
        const transcript = new SubagentTranscript(storage, cwd, "parent", "agent");
        await transcript.start(start);
        await transcript.finish([{role: "assistant", content: "first"}], result);
        const previous = await readFile(paths.state, "utf8");
        await truncate(paths.events, 64 * 1024 * 1024);
        const report = await transcript.finish([{role: "assistant", content: "second"}], {...result, reply: "second"});
        expect(report.reply).toBe("second");
        expect(report.transcriptPath).toBeUndefined();
        expect(report.transcriptIssue).toContain("incomplete or unavailable");
        expect(await readFile(paths.state, "utf8")).toBe(previous);
    });
});

test("snapshot diagnostics survive a successful report write", async () => {
    await withTempProject(async (cwd, storage) => {
        const paths = getSubagentRecordPaths(storage, cwd, "parent", "agent");
        const transcript = new SubagentTranscript(storage, cwd, "parent", "agent");
        await transcript.start(start);
        transcript.noteIssue("Current conversation snapshot could not be saved");
        const report = await transcript.finish([], result);
        expect(report.transcriptPath).toBe(paths.events);
        expect(report.transcriptIssue).toContain("snapshot could not be saved");
        expect(JSON.parse(await readFile(paths.state, "utf8")).result).toEqual(report);
    });
});
