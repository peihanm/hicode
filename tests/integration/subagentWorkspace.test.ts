import {expect, test} from "bun:test";
import {mkdir, readFile, readdir, realpath, rename, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {Message} from "../../src/llm/types.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {createFakeLLM, assistantText, assistantToolCall} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {TaskSessionLike} from "../../src/tasks/types.js";

function nextFinished(tasks: TaskSessionLike): Promise<void> {
    return new Promise(resolve => {
        const unsubscribe = tasks.subscribe(event => {
            if (event.type === "task_finished") {unsubscribe(); resolve();}
        });
    });
}
const forkHistory: Message[] = [{role: "system", content: "Parent task"},
    {role: "assistant", content: null, tool_calls: [{id: "spawn", type: "function",
        function: {name: "agent", arguments: "{}"}}]}];

test("无 Git 的指定目录可以读取当前文件、修改、Bash 验证，并沿原 Task 继续返修", async () => {
    await withTempProject(async cwd => {
        const processCwd = process.cwd();
        const target = join(cwd, "packages", "worker");
        await mkdir(target, {recursive: true});
        await writeFile(join(cwd, "packages", "HICODE.md"), "INTERMEDIATE_PROJECT_RULE: keep changes scoped");
        await writeFile(join(target, "HICODE.md"), "CHILD_PROJECT_RULE: run relevant checks");
        await writeFile(join(target, "shared.txt"), "uncommitted");
        const child = createFakeLLM([
            options => {
                expect(JSON.stringify(options.messages)).toContain("INTERMEDIATE_PROJECT_RULE");
                expect(JSON.stringify(options.messages)).toContain("CHILD_PROJECT_RULE");
                expect(options.tools.map(tool => tool.function.name)).toContain("bash");
                return assistantToolCall("read_file", {path: "shared.txt"}, "read-first");
            },
            options => {
                expect(JSON.stringify(options.messages)).toContain("uncommitted");
                return assistantToolCall("edit_file", {path: "shared.txt", edits: [{old_string: "uncommitted", new_string: "verified"}]}, "edit-first");
            },
            () => assistantToolCall("bash", {command: "pwd && test -f shared.txt"}, "check-first"),
            options => {
                const output = options.messages.find(message => message.role === "tool" && message.tool_call_id === "check-first");
                expect(output?.content).toContain("packages/worker");
                expect(output?.content).not.toContain("Permission denied");
                return assistantText("first implementation verified");
            },
            options => {
                expect(JSON.stringify(options.messages)).toContain("first implementation verified");
                expect(JSON.stringify(options.messages)).toContain("continue with correction");
                return assistantToolCall("edit_file", {path: "shared.txt", edits: [{old_string: "verified", new_string: "corrected"}]}, "edit-second");
            },
            () => assistantText("correction complete"),
        ]);
        const parent = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner,
            (options, request) => createSubagentThreadForTest({...options, agentOptions: {callLLM: child.callLLM}}, request));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        parent.tasks = tasks;
        attachSubagentLauncher(parent, async () => {throw new Error("must run in background");}, () => forkHistory);
        try {
            const firstDone = nextFinished(tasks);
            const start = await executeToolResult("agent", JSON.stringify({subagent_type: "Worker", context: "inherit", name: "worker",
                description: "implement", prompt: "modify and verify", cwd: target, run_in_background: true}), parent, "spawn");
            expect(start.outcome).toBe("ok");
            await firstDone;
            const [first] = await tasks.list();
            expect(first).toMatchObject({kind: "agent", status: "completed", cwd: await realpath(target), progress: {runCount: 1}});
            expect(await readFile(join(target, "shared.txt"), "utf8")).toBe("verified");
            const secondDone = nextFinished(tasks);
            await tasks.followup(first!.id, "continue with correction");
            await secondDone;
            expect(await tasks.get(first!.id)).toMatchObject({id: first!.id, kind: "agent", status: "completed", progress: {runCount: 2}});
            expect(await readFile(join(target, "shared.txt"), "utf8")).toBe("corrected");
            expect(await readdir(cwd)).not.toContain(".git");
            expect(await readdir(cwd)).not.toContain(".hicode");
            expect(process.cwd()).toBe(processCwd);
        } finally {await runtime.close();}
    });
});

test.each(["file-deny", "shell-deny", "read-only", "plan", "elevated", "tool-scope"])("子 Agent 不扩大父能力：%s", async mode => {
    await withTempProject(async cwd => {
        const target = join(cwd, "child"); await mkdir(target);
        await writeFile(join(target, "secret.txt"), "SECRET_CONTENT");
        const parent = createTestContext(cwd, {
            ...(mode === "plan" ? {collaborationMode: "plan" as const} : {}),
            ...(mode === "read-only" ? {readOnlyTools: true} : {}),
            ...(mode === "tool-scope" ? {toolNames: ["read_file"]} : {}),
        });
        if (mode === "file-deny") parent.permissionRules.deny.push({toolName: "read_file", content: "child/secret.txt", source: "host"});
        if (mode === "shell-deny") parent.permissionRules.deny.push({toolName: "bash", source: "host"});
        const name = mode === "file-deny" ? "read_file" : ["elevated", "shell-deny", "tool-scope"].includes(mode) ? "bash" : "write_file";
        const args = name === "read_file" ? {path: "secret.txt"} : name === "write_file" ? {path: "blocked.txt", content: "wrong"}
            : {command: "pwd", ...(mode === "elevated" ? {sandbox_permissions: "require_escalated"} : {})};
        const child = createFakeLLM([
            () => assistantToolCall(name, args, "blocked"),
            options => {
                const result = options.messages.find(message => message.role === "tool" && message.tool_call_id === "blocked");
                expect(result?.content).toMatch(/denied|not provided in this model request/i);
                expect(result?.content).not.toContain("SECRET_CONTENT");
                return assistantText("blocked as expected");
            },
        ]);
        const thread = createSubagentThreadForTest({parentContext: parent, agentId: "bounded", onEvent() {}, agentOptions: {callLLM: child.callLLM}},
            {agentType: "Worker", name: "worker", description: "bounded", prompt: "test", parentToolCallId: "spawn",
                cwd: target, workspaceWriteApproved: true, contextSnapshot: {history: [{role: "system", content: "parent"}]}});
        await thread.run({prompt: "test", signal: new AbortController().signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(child.calls).toHaveLength(2);
        expect(await readdir(target)).not.toContain("blocked.txt");
    });
});

test("cwd 外部目录需已有授权，继续前拒绝 Symlink 换向，不改父 cwd", async () => {
    await withTempProject(async root => {
        const main = join(root, "main"), other = join(root, "other");
        await mkdir(main); await mkdir(other);
        const directoryAccess = createDirectoryAccessRuntime({cwd: main, hardBoundary: root});
        const parent = createTestContext(main, {directoryAccess});
        const child = createFakeLLM([() => assistantText("allowed directory")]);
        const request = {agentType: "Worker" as const, name: "worker", description: "cwd", prompt: "cwd",
            parentToolCallId: "spawn", cwd: other, readOnly: true, contextSnapshot: {history: [{role: "system" as const, content: "parent"}]}};
        const create = () => createSubagentThreadForTest({parentContext: parent, agentId: "cwd-check", onEvent() {}, agentOptions: {callLLM: child.callLLM}}, request);
        const run = {prompt: "run", signal: new AbortController().signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL};
        await expect(create().run(run)).rejects.toThrow("authorized director");
        expect(child.calls).toHaveLength(0);
        await directoryAccess.grantDirectory(other, "session");
        const thread = create(); await thread.run(run);
        await rename(other, join(root, "moved")); await symlink(main, other);
        await expect(thread.run(run)).rejects.toThrow("working directory changed before continuation");
        expect(child.calls).toHaveLength(1);
        expect(parent.cwd).toBe(main);
    });
});

test("模型生成期间工作目录被换向时，旧工具调用不能写入新目标", async () => {
    await withTempProject(async root => {
        const target = join(root, "worker"), other = join(root, "other");
        await mkdir(target); await mkdir(other);
        const child = createFakeLLM([
            async () => {
                await rename(target, join(root, "original-worker")); await symlink(other, target);
                return assistantToolCall("write_file", {path: "wrong.txt", content: "must not write"}, "stale-cwd");
            },
            options => {
                expect(options.messages.find(message => message.role === "tool" && message.tool_call_id === "stale-cwd")?.content)
                    .toContain("working directory changed before tool execution");
                return assistantText("directory changed; stopped");
            },
        ]);
        const thread = createSubagentThreadForTest({parentContext: createTestContext(root), agentId: "swap", onEvent() {}, agentOptions: {callLLM: child.callLLM}},
            {agentType: "Worker", name: "worker", description: "swap", prompt: "write", parentToolCallId: "spawn",
                cwd: target, workspaceWriteApproved: true, contextSnapshot: {history: [{role: "system", content: "parent"}]}});
        await thread.run({prompt: "write", signal: new AbortController().signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(child.calls).toHaveLength(2);
        expect(await readdir(other)).toHaveLength(0);
    });
});
