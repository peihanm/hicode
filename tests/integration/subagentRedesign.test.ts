import {z} from "zod";
import type {Tool} from "../../src/tools/types.js";
import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {createSubagentRegistry} from "../../src/subagents/registry.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {createChildTaskAccess} from "../../src/tasks/childAccess.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {childTaskTool, taskTool} from "../../src/tools/task/task.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createFakeLLM, assistantText, assistantToolCall} from "../helpers/fakeLLM.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import type {Todo} from "../../src/todos.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {contentText} from "../../src/images/content.js";

const assignment = {agentType: "specialist", description: "Implement a bounded task", prompt: "work", parentToolCallId: "delegate"};
const registry = () => createSubagentRegistry({issues: [], definitions: [{source: "host", id: "specialist", agentType: "specialist", whenToUse: "work", systemPrompt: "Complete the assignment."}]});
const todo: Todo = {content: "Verify the change", activeForm: "Verifying", status: "in_progress"};

test("custom child inherits ordinary tools and parent model, owns Todo and Skills, and continues past 30 calls", async () => {
    await withTempProject(async cwd => {
        await writeFile(`${cwd}/source.txt`, "evidence");
        const parentTodos = [{...todo, content: "Parent task"}];
        const parent = createTestContext(cwd, {model: "main-model", fastModel: "fast-model", setTodos: values => {parentTodos.splice(0, parentTodos.length, ...values);}});
        parent.skills = [{source: "host", id: "guidance", name: "guidance", description: "Review guidance", content: "Keep changes scoped. No extra permissions."}];
        const events: AgentEvent[] = [];
        const fake = createFakeLLM([
            options => {
                expect(options.model).toBe("main-model");
                const names = options.tools.map(tool => tool.function.name);
                for (const name of ["read_file", "write_file", "bash", "view_image", "skill", "todo_write"]) expect(names).toContain(name);
                for (const name of ["agent", "agent_followup", "ask_user", "task"]) expect(names).not.toContain(name);
                return assistantToolCall("todo_write", {todos: [todo]}, "own-plan");
            },
            options => {
                expect(JSON.stringify(options.messages)).toContain("Verify the change");
                return assistantToolCall("skill", {skill: "guidance"}, "skill");
            },
            ...Array.from({length: 32}, (_, i) => assistantToolCall("read_file", {path: "source.txt"}, `read-${i}`)),
            options => {
                expect(JSON.stringify(options.messages)).toContain("Keep changes scoped");
                return assistantToolCall("todo_write", {todos: [{...todo, status: "completed"}]}, "finish-plan");
            },
            assistantText("Verified the requested change."),
        ]);
        const thread = createSubagentThreadForTest({agentId: "owned-todo", parentContext: parent, onEvent: event => {events.push(event);}, registry: registry(), agentOptions: {callLLM: fake.callLLM}}, assignment);
        parent.model = "changed-after-spawn";
        const result = await thread.run({prompt: assignment.prompt, signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(result.reason).toBe("completed");
        expect(result.iterations).toBe(36);
        expect(fake.calls.every(call => call.model === "main-model")).toBe(true);
        expect(parentTodos).toEqual([{...todo, content: "Parent task"}]);
        expect(events.filter(event => event.type === "subagent_progress" && event.event.type === "todos")).toHaveLength(2);
    });
});

test("unfinished Todo returns incomplete after one reminder and stays available for followup", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const fake = createFakeLLM([
            assistantToolCall("todo_write", {todos: [todo]}, "plan"),
            assistantText("Finished."), assistantText("Still missing access."),
            options => {
                expect(JSON.stringify(options.messages)).toContain("in_progress");
                expect(JSON.stringify(options.messages)).toContain("The unfinished plan is carried forward");
                expect(JSON.stringify(options.messages)).toContain("Todo updated this run: no");
                return assistantToolCall("todo_write", {todos: [{...todo, status: "completed"}]}, "done");
            }, assistantText("Verified after receiving access."),
        ]);
        const thread = createSubagentThreadForTest({agentId: "continuation", parentContext: parent, onEvent() {}, registry: registry(), agentOptions: {callLLM: fake.callLLM}}, assignment);
        const first = await thread.run({prompt: "work", signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(first.reason).toBe("incomplete");
        expect(first.reply).toContain("Unfinished child tasks");
        expect(first.iterations).toBe(3);
        const second = await thread.run({prompt: "continue", signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(second.reason).toBe("completed");
    });
});

test("child keeps the real permission-denied result without an extra model finalization", async () => {
    await withTempProject(async cwd => {
        const probe: Tool = {name: "approval_probe", description: "Offline refusal fixture", parameters: z.object({}),
            isReadOnly: () => true, checkPermissions: async () => ({behavior: "allow"}),
            async execute(_input, ctx) {
                for (let i = 0; i < 3; i++) ctx.approvalBudget.record(true);
                return {content: "Permission denied", outcome: "denied"};
            }};
        const parent = createTestContext(cwd, {toolNames: [...createToolRuntime().toolNames, probe.name]});
        parent.availableTools = [...parent.availableTools, probe];
        const fake = createFakeLLM([assistantToolCall("approval_probe", {}, "deny")]);
        const thread = createSubagentThreadForTest({agentId: "denied", parentContext: parent, onEvent() {}, registry: registry(),
            agentOptions: {callLLM: fake.callLLM}}, assignment);
        const result = await thread.run({prompt: "work", signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(result.reason).toBe("permission_denied");
        expect(fake.calls).toHaveLength(1);
    });
});

test("child Shell task capability excludes parent and sibling tasks and cannot spawn agents", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner);
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        try {
            const root = await tasks.startShell({command: "printf root", cwd, toolCallId: "root", waitMs: 1000});
            const child = createChildTaskAccess(tasks, parent.toolResultFiles);
            const sibling = createChildTaskAccess(tasks, parent.toolResultFiles);
            const own = await child.tasks.startShell({command: "printf child", cwd, toolCallId: "child", waitMs: 1000});
            const other = await sibling.tasks.startShell({command: "printf sibling", cwd, toolCallId: "sibling", waitMs: 1000});
            expect((await child.tasks.list()).map(task => task.id)).toEqual([own.id]);
            expect(await child.tasks.get(root.id)).toBeUndefined();
            expect(await child.tasks.stop(other.id)).toBeUndefined();
            expect(child.tasks).not.toHaveProperty("startAgent");
            expect(child.tasks).not.toHaveProperty("close");
            parent.tasks = child.tasks;
            const tools = createToolRuntime({allowedToolNames: ["task"], toolOverrides: [childTaskTool(taskTool)]});
            const result = await tools.executeTool("task", JSON.stringify({action: "status", task_id: own.id}), parent, "status");
            expect(contentText(result.modelContent)).toContain("child");
            expect((await tools.executeTool("task", JSON.stringify({action: "stop", task_id: own.id}), parent, "stop")).outcome).toBe("ok");
            expect((await tools.executeTool("task", JSON.stringify({action: "followup", task_id: root.id, message: "work"}), parent, "invalid")).outcome).not.toBe("ok");
            expect(await child.files.resolveFile("/unrelated")).toBeNull();
        } finally {await runtime.close();}
    });
});

test("a read-only custom role cannot gain writes from a writable launch", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const definition = registry().get("specialist")!.definition;
        const restricted = createSubagentRegistry({issues: [], definitions: [{...definition, readOnly: true}]});
        const fake = createFakeLLM([
            assistantToolCall("write_file", {path: "forbidden.txt", content: "no"}, "write"),
            options => {
                expect(contentText(options.messages.find(message => message.role === "tool" && message.tool_call_id === "write")!.content)).toContain("read-only");
                return assistantText("Cannot modify files in this role.");
            },
        ]);
        const thread = createSubagentThreadForTest({agentId: "read-only", parentContext: parent, onEvent() {}, registry: restricted, agentOptions: {callLLM: fake.callLLM}}, {...assignment, workspaceWriteApproved: true});
        await thread.run({prompt: "work", signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(await Bun.file(`${cwd}/forbidden.txt`).exists()).toBe(false);
    });
});

test("background task snapshots expose independent todos and retain incomplete status", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const fake = createFakeLLM([assistantToolCall("todo_write", {todos: [{...todo, status: "pending"}]}, "plan"), assistantText("Waiting for input.")]);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, (options, request) =>
            createSubagentThreadForTest({...options, registry: registry(), agentOptions: {callLLM: fake.callLLM}}, request), undefined, registry());
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        parent.tasks = tasks;
        try {
            let finish!: () => void;
            const finished = new Promise<void>(resolve => {finish = resolve;});
            const unsubscribe = tasks.subscribe(event => {if (event.type === "task_finished") finish();});
            const task = await tasks.startAgent({request: assignment, parentContext: parent});
            await finished;
            unsubscribe();
            expect(await tasks.get(task.id)).toMatchObject({status: "failed", reason: "incomplete", progress: {todos: [{...todo, status: "pending"}]}});
        } finally {await runtime.close();}
    });
});

test("a messaging endpoint cannot add a tool excluded by the parent's actual scope", async () => {
    await withTempProject(async cwd => {
        let sent = false;
        const parent = createTestContext(cwd, {toolNames: ["read_file"]});
        const fake = createFakeLLM([
            options => {
                expect(options.tools.map(tool => tool.function.name)).toEqual(["read_file"]);
                return assistantToolCall("agent_message", {action: "send", target: "parent", message: "no"}, "unexposed");
            },
            options => {
                expect(contentText(options.messages.find(message => message.role === "tool")!.content)).toContain("was not provided");
                return assistantText("The communication tool is unavailable.");
            },
        ]);
        const thread = createSubagentThreadForTest({agentId: "no-messaging", parentContext: parent, onEvent() {}, registry: registry(),
            agentOptions: {callLLM: fake.callLLM}, agentMessaging: {
                async send() {sent = true; return {messageId: "unexpected"};}, async wait() {throw new Error("Messaging must remain unavailable");},
            }}, assignment);
        await thread.run({prompt: "work", signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
        expect(sent).toBe(false);
    });
});
