import {createMemoryAwareAgentRunner, type MemoryRuntimeLike} from "../../src/memory/runtime.js";
import {createTestMemoryRuntime, remember} from "../helpers/memory.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {expect, test} from "bun:test";
import {writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {createCompactState} from "../../src/context/state.js";
import {tokenCountWithEstimation} from "../../src/context/tokens.js";
import {executeToolCallBatch} from "../../src/agent/toolBatch.js";
import {hasCompleteToolPairs} from "../../src/session/store/codec.js";
import {loadSession} from "../../src/session/store/sessionStore.js";
import type {HiCodeStorageLayout} from "../../src/persistence/layout.js";
import type {AgentEvent} from "../../src/agent/types.js";

function fixture(cwd: string, storage: HiCodeStorageLayout, memory?: MemoryRuntimeLike) {
    const resources = createTestRuntimeResources(cwd, {storage, ...(memory ? {memory} : {}), skills: [
        {name: "review", source: "host", id: "review", description: "Review guidance", content: "Check $ARGUMENTS carefully."},
    ]});
    const session = createRootSessionRuntime({resources, seed: {sessionId: "restore", compactState: createCompactState(),
        history: [{role: "system", content: "fixture"}, {role: "user", origin: "user", content: "Review the source"}]}});
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const ctx = session.createContext({signal: controller.signal, onEvent: event => {events.push(event);},
        host: {canUseTool: async () => ({behavior: "deny", message: "No test approvals"}),
            getPermissionMode: () => "ask", getPermissionPromptPolicy: () => "never",
            getPermissionRules: session.permissions.getRules, setTodos() {}},
        getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask"})});
    let calls = 0;
    const tool = async (name: string, args: unknown) => {
        const call = {id: `original-${++calls}`, type: "function" as const, function: {name, arguments: JSON.stringify(args)}};
        session.history.push({role: "assistant", content: null, tool_calls: [call]});
        await executeToolCallBatch({toolCalls: [call], history: session.history, ctx, turnId: ctx.turnId,
            onEvent() {}, executeTool: resources.toolRuntime.executeTool, isToolConcurrencySafe: () => false});
    };
    const compact = async (activeContext = ctx) => {
        session.history.push({role: "assistant", content: "Old investigation. ".repeat(12_000)},
            {role: "user", origin: "user", content: "Continue the review"});
        return createCompactHistoryRunner({generateSummary: async () => "Continue reviewing the source with the review Skill."})({
            history: session.history, ctx: activeContext, tools: resources.toolRuntime.getToolSchemas(), preTokenCount: 200_000, force: true});
    };
    const restored = () => session.history.filter(message => message.role === "tool" && message.tool_call_id.startsWith("restore-"));
    return {resources, session, ctx, controller, events, tool, compact, restored};
}

test("Root 压缩重读当前文件并补回 Skill 参数，事件/Hook/配对/Resume 均保留", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            const path = join(cwd, "source.ts");
            await writeFile(path, "old source\n");
            await f.tool("read_file", {path});
            await f.tool("skill", {skill: "review", args: "auth"});
            await writeFile(path, "current source\n");
            const hooks: string[] = [];
            f.ctx.runHook = async input => {
                hooks.push(input.hook_event_name);
                return {blocked: false, executions: [], additionalContexts: input.hook_event_name === "PostToolBatch" ? ["restoration hook"] : []};
            };
            expect((await f.compact()).compacted).toBe(true);
            expect(f.restored()).toHaveLength(2);
            expect(JSON.stringify(f.restored())).toContain("current source");
            expect(JSON.stringify(f.restored())).not.toContain("old source");
            expect(JSON.stringify(f.restored())).toContain("Check auth carefully.");
            expect(hooks.filter(name => name === "PostToolBatch")).toHaveLength(2);
            expect(f.events.filter(event => event.type === "tool_call_start")).toHaveLength(2);
            expect(f.events.filter(event => event.type === "tool_call_end")).toHaveLength(2);
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
            expect(f.ctx.fileState.check(path, "current source\n")).toEqual({ok: false, reason: "not_read"});
            f.ctx.fileState.commitVisible(f.session.history);
            expect(f.ctx.fileState.check(path, "current source\n", {requireFullRead: true})).toEqual({ok: true});
            expect(loadSession(storage, cwd, "restore")!.history.slice(1)).toEqual(f.session.history.slice(1));
        } finally {await f.resources.close();}
    });
});

test("尾部已有内容不重复补回；最多重读三文件，沿最近 offset 并限制 200 行", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            for (let n = 0; n < 5; n++) {
                await writeFile(join(cwd, `${n}.ts`), Array.from({length: 500}, (_, i) => `${i + 1}: file ${n}`).join("\n"));
                await f.tool("read_file", {path: `${n}.ts`, offset: n + 1, limit: 400});
            }
            await f.tool("skill", {skill: "review"});
            const previous = [...f.session.history];
            const retained = previous.slice(-4); // File 4 and Skill are still visible.
            f.session.history.splice(2, f.session.history.length - 2, ...retained);
            await f.ctx.restoreAfterCompaction!(f.ctx, previous, f.session.history, () => true);
            const calls = f.session.history.flatMap(message => message.role === "assistant" ? message.tool_calls ?? [] : [])
                .filter(call => call.id.startsWith("restore-"));
            expect(calls.map(call => JSON.parse(call.function.arguments))).toEqual([3, 2, 1].map(n => ({path: join(cwd, `${n}.ts`), offset: n + 1, limit: 200})));
            expect(JSON.stringify(f.restored())).toContain("Line range: 4-203");
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
        } finally {await f.resources.close();}
    });
});

test.each(["deny", "deleted", "oversize", "hook-oversize"] as const)("补回 %s 保留可用内容及真实失败，不把部分读取当完整读取", async mode => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            const path = join(cwd, "source.ts");
            await writeFile(path, "old\n");
            await f.tool("read_file", {path});
            const current = mode === "oversize" ? "a".repeat(100) + "\n" : "current\n";
            await writeFile(path, mode === "oversize" ? current.repeat(200) : current);
            if (mode === "deny") f.session.permissions.setRules({allow: [], ask: [], deny: [{toolName: "read_file", source: "host"}]});
            if (mode === "deleted") await unlink(path);
            if (mode === "hook-oversize") f.ctx.runHook = async input => ({blocked: false, executions: [], additionalContexts: input.hook_event_name === "PostToolBatch" ? ["x".repeat(50_000)] : []});
            expect((await f.compact()).compacted).toBe(true);
            expect(f.restored()).toHaveLength(1);
            const text = JSON.stringify(f.restored());
            expect(text).not.toContain("old\\n");
            if (mode === "oversize") {
                expect(text).toContain("remaining output omitted");
                expect(text).toContain("a".repeat(100));
                const output = String(f.restored()[0]!.content);
                const end = Number(output.match(/Line range: 1-(\d+)/)?.[1]);
                expect(end).toBeGreaterThan(0);
                expect(end).toBeLessThan(200);
                expect(output).toContain(`offset=${end + 1}`);
                const sourceLines = output.split("\n").filter(line => /^ *\d+\t/.test(line));
                expect(sourceLines).toHaveLength(end);
                expect(sourceLines.every(line => line.split("\t")[1] === "a".repeat(100))).toBe(true);
                expect(loadSession(storage, cwd, "restore")!.history.slice(1)).toEqual(f.session.history.slice(1));
            } else if (mode === "hook-oversize") {
                expect(text).toContain("current");
                expect(JSON.stringify(f.session.history)).toContain("Hook context is incomplete");
                const hook = f.session.history.at(-1);
                expect(String(hook?.content)).toEndWith("</system-reminder>");
            } else expect(f.events.some(event => event.type === "tool_call_end" && event.outcome !== "ok")).toBe(true);
            f.ctx.fileState.commitVisible(f.session.history);
            expect(f.ctx.fileState.check(path, mode === "oversize" ? current.repeat(200) : current, {requireFullRead: true}))
                .toEqual(mode === "hook-oversize" ? {ok: true} : {ok: false, reason: "not_read"});
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
        } finally {await f.resources.close();}
    });
});

test.each(["cancel", "hook-failure", "event-failure"] as const)("补回 %s 保留已经开始的完整调用组，停止后续补回", async mode => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            await writeFile(join(cwd, "source.ts"), "current\n");
            await f.tool("read_file", {path: "source.ts"});
            await f.tool("skill", {skill: "review"});
            f.ctx.runHook = async input => {
                if (input.hook_event_name === "PostToolBatch") {
                    if (mode === "cancel") f.controller.abort("stop restoration");
                    if (mode === "hook-failure") throw new Error("Hook failed");
                }
                return {blocked: false, executions: [], additionalContexts: []};
            };
            if (mode === "event-failure") f.events.push = () => {throw new Error("Event sink failed");};
            await expect(f.compact()).rejects.toThrow();
            expect(f.session.compactState.compactCount).toBe(1);
            expect(f.restored()).toHaveLength(1);
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
            expect(loadSession(storage, cwd, "restore")!.history.slice(1)).toEqual(f.session.history.slice(1));
        } finally {await f.resources.close();}
    });
});

test("补回服从完整请求预算，没有余量不执行工具", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            await f.tool("skill", {skill: "review"});
            const previous = [...f.session.history];
            f.session.history.splice(2);
            const limit = tokenCountWithEstimation(f.session.history);
            await f.ctx.restoreAfterCompaction!(f.ctx, previous, f.session.history, messages => tokenCountWithEstimation(messages) <= limit);
            expect(f.restored()).toHaveLength(0);
            expect(f.events).toHaveLength(0);
        } finally {await f.resources.close();}
    });
});

test("最多补回两个 Skill；文件与 Skill 共用 20k 总预算，超量有明确提示", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            for (let n = 0; n < 3; n++) {
                await writeFile(join(cwd, `${n}.ts`), ("x".repeat(50) + "\n").repeat(150));
                await f.tool("read_file", {path: `${n}.ts`});
                f.ctx.skills.push({name: `guide${n}`, source: "host", id: `guide${n}`, description: "Guide", content: "s".repeat(8_000)});
                await f.tool("skill", {skill: `guide${n}`});
            }
            const previous = [...f.session.history];
            f.session.history.splice(2);
            const initial = tokenCountWithEstimation(f.session.history);
            await f.ctx.restoreAfterCompaction!(f.ctx, previous, f.session.history, () => true);
            const calls = f.session.history.flatMap(message => message.role === "assistant" ? message.tool_calls ?? [] : []);
            const skills = calls.filter(call => call.function.name === "skill");
            expect(skills.map(call => JSON.parse(call.function.arguments).skill)).toEqual(["guide2", "guide1"]);
            expect(calls.filter(call => call.function.name === "read_file")).toHaveLength(3);
            expect(tokenCountWithEstimation(f.session.history) - initial).toBeLessThanOrEqual(20_000);
            expect(JSON.stringify(f.restored())).toContain("omitted");
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
        } finally {await f.resources.close();}
    });
});

test("大 Skill 单行保留 Unicode 正文前缀，Hook 使用剩余空间，整组不超过 5k", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            f.ctx.skills[0]!.content = "Guidance start: " + "中文😀".repeat(6000) + "HIDDEN_END";
            await f.tool("skill", {skill: "review"});
            f.ctx.runHook = async input => ({blocked: false, executions: [],
                additionalContexts: input.hook_event_name === "PostToolBatch" ? ["hook-start " + "x".repeat(3000)] : []});
            expect((await f.compact()).compacted).toBe(true);
            const text = String(f.restored()[0]!.content);
            expect(text).toContain("Guidance start: 中文😀");
            expect(text).toContain("</skill-source>");
            expect(text).not.toContain("HIDDEN_END");
            expect(text).toContain("Restoration excerpt is incomplete");
            expect(text.isWellFormed()).toBe(true);
            const start = f.session.history.findIndex(message => message.role === "assistant" && message.tool_calls?.[0]?.id.startsWith("restore-"));
            expect(tokenCountWithEstimation(f.session.history.slice(start))).toBeLessThanOrEqual(5000);
            expect(JSON.stringify(f.session.history.slice(start))).toContain("Hook context");
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
        } finally {await f.resources.close();}
    });
});

test("文件补回服从较小的完整请求余量；单行放不下时给出原 offset，不伪造半行", async () => {
    await withTempProject(async (cwd, storage) => {
        const f = fixture(cwd, storage);
        try {
            const path = join(cwd, "large.ts");
            await writeFile(path, "skip\n" + "x".repeat(2000) + "\nlast\n");
            await f.tool("read_file", {path, offset: 2});
            const previous = [...f.session.history];
            f.session.history.splice(2);
            const initial = tokenCountWithEstimation(f.session.history);
            await f.ctx.restoreAfterCompaction!(f.ctx, previous, f.session.history, messages => tokenCountWithEstimation(messages) <= initial + 500);
            const text = String(f.restored()[0]!.content);
            expect(text).toContain("Line range: none");
            expect(text).toContain("offset=2");
            expect(text).not.toContain("x".repeat(10));
            expect(tokenCountWithEstimation(f.session.history) - initial).toBeLessThanOrEqual(500);
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
        } finally {await f.resources.close();}
    });
});


test.each(["ignored", "unavailable"] as const)("Memory %s 后压缩补回使用当前能力，普通文件仍可重读", async mode => {
    await withTempProject(async (cwd, storage) => {
        const memory = createTestMemoryRuntime(cwd);
        const f = fixture(cwd, storage, memory);
        try {
            const path = await remember(memory, "private", "MEMORY_BODY_MUST_NOT_RETURN");
            await writeFile(join(cwd, "source.ts"), "current source\n");
            await f.tool("read_file", {path});
            await f.tool("read_file", {path: "source.ts"});
            expect(JSON.stringify(f.session.history)).toContain("MEMORY_BODY_MUST_NOT_RETURN");
            if (mode === "unavailable") await writeFile(join(memory.directory, "state.json"), "invalid state");
            const run = createMemoryAwareAgentRunner(async (_prompt, _history, _event, ctx, _channel, options) => {
                await options.getAdditionalUserContextBlocks?.();
                expect(ctx.memoryFiles).toBeUndefined();
                expect((await f.compact(ctx)).compacted).toBe(true);
                return {reply: "done", reason: "completed", iterations: 1};
            }, memory);
            await run(mode === "ignored" ? "本轮不要使用记忆" : "continue", f.session.history, () => {},
                f.ctx, EMPTY_AGENT_INPUT_CHANNEL, {getToolSchemas: f.resources.toolRuntime.getToolSchemas,
                    executeTool: f.resources.toolRuntime.executeTool, isToolConcurrencySafe: f.resources.toolRuntime.isConcurrencySafe});
            expect(f.restored()).toHaveLength(2);
            const text = JSON.stringify(f.restored());
            expect(text).toContain("current source");
            expect(text).not.toContain("MEMORY_BODY_MUST_NOT_RETURN");
            expect(f.events.some(event => event.type === "tool_call_end" && event.outcome !== "ok")).toBe(true);
            expect(hasCompleteToolPairs(f.session.history)).toBe(true);
        } finally {await f.resources.close();}
    });
});
