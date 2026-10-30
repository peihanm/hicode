import {expect, test} from "bun:test";
import {mkdir, readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactState} from "../../src/context/state.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {getSubagentRecordPaths, getSubagentStorageDirectory} from "../../src/persistence/layout.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";
import {createTestContext} from "../helpers/testContext.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {prepareCommandReadAccess} from "../../src/tools/bash/readAccess.js";
import type {ToolContextHost} from "../../src/runtime/toolContext.js";
import type {PermissionRules} from "../../src/permissions/types.js";
import {createSessionPersistence} from "../../src/session/storage.js";
import {createSubagentRecordAccess} from "../../src/subagents/recordView.js";
import {createSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

test("Root can inspect its own child outside the workspace without approval; other parents, children and explicit deny cannot", async () => {
    await withTempProject(async (outer, storage) => {
        const cwd = join(outer, "project");
        await mkdir(cwd);
        await writeFile(join(cwd, "source.txt"), "SOURCE_EVIDENCE\n");
        const fake = createFakeLLM([
            assistantToolCall("read_file", {path: "source.txt"}, "inspect"),
            assistantText("CHILD_REPORT"), assistantText("FOLLOWUP_REPORT\n" + "😀".repeat(4001) + "\n" + "paged evidence\n".repeat(2500)),
        ]);
        const resources = createTestRuntimeResources(cwd, {storage, agentRuntime: {
            runAgent: async () => {throw new Error("Root model must not be called");},
            compactHistory: async () => {throw new Error("Compaction must not be called");},
            reviewApproval: async () => {throw new Error("Approval model must not be called");},
            reviewTask: async () => {throw new Error("Review model must not be called");},
            createSubagentThread: (options, request) => createSubagentThreadForTest({...options,
                toolResultStoreOptions: {hicodeHome: storage.hicodeHome}, agentOptions: {callLLM: fake.callLLM}}, request),
        }});
        let approvals = 0;
        const rules: PermissionRules = {allow: [], ask: [], deny: []};
        const host: ToolContextHost = {canUseTool: async () => {approvals++; return {behavior: "deny", message: "No approval expected"};},
            getPermissionMode: () => "ask", getPermissionPromptPolicy: () => "onRequest", getPermissionRules: () => rules, setTodos() {}};
        const makeSession = (id: string) => {
            const session = createRootSessionRuntime({resources, seed: {sessionId: id,
                history: [{role: "user", origin: "user", content: "Inspect the child work"}], compactState: createCompactState()}});
            const ctx = session.createContext({signal: new AbortController().signal, host, onEvent() {},
                getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask"})});
            return {session, ctx};
        };
        const {session, ctx} = makeSession("parent");
        const call = (name: string, input: unknown, context = ctx) => resources.toolRuntime.executeTool(name, JSON.stringify(input), context, `read-${name}`);
        try {
            const task = await session.taskSession.startAgent({parentContext: ctx,
                request: {agentType: "Worker", description: "Inspect", prompt: "Read source.txt and report", parentToolCallId: "spawn"}});
            await waitForTaskCompletion(session.taskSession, [task.id], ctx.signal, "agent");
            const paths = getSubagentRecordPaths(storage, cwd, "parent", task.id);
            const status = await call("task", {action: "status", task_id: task.id});
            expect(status.modelContent).toContain(`Conversation: ${paths.conversation}`);
            expect(status.modelContent).toContain(paths.events);
            expect((await session.taskSession.pendingNotifications())[0]?.message).toContain("conversation and execution records");
            for (const path of [paths.conversation, paths.state, paths.events]) {
                const read = await call("read_file", {path});
                expect(read.outcome).toBe("ok");
                expect(read.modelContent).toContain("Subagent record");
            }
            const conversation = await call("read_file", {path: paths.conversation});
            expect(conversation.modelContent).toContain("SOURCE_EVIDENCE");
            expect(conversation.modelContent).toContain("CHILD_REPORT");
            expect(conversation.modelContent).toContain("Persisted snapshot time:");
            expect(conversation.modelContent).not.toContain("You are HiCode");
            expect(approvals).toBe(0);
            const state = JSON.parse(await readFile(paths.state, "utf8"));
            expect(state).not.toHaveProperty("history");
            expect(state.conversationPath).toBe(paths.conversation);
            const plan = await prepareCommandReadAccess(`rg SOURCE_EVIDENCE '${paths.conversation}'`, cwd, ctx);
            expect(plan?.artifacts).toHaveLength(1);

            const foreign = makeSession("other-parent");
            expect((await call("read_file", {path: paths.conversation}, foreign.ctx)).outcome).toBe("denied");
            const child = createTestContext(cwd, {sessionId: "subagent-other", workspaceBoundary: cwd});
            child.storage = storage;
            expect((await createToolRuntime().executeTool("read_file", JSON.stringify({path: paths.conversation}), child, "child-read")).outcome).toBe("denied");
            await expect(prepareCommandReadAccess(`cat '${paths.conversation}'`, cwd, child)).rejects.toThrow("no child-record");
            rules.deny = [{toolName: "read_file", source: "user"}];
            expect((await call("read_file", {path: paths.conversation})).outcome).toBe("denied");
            rules.deny = [];
            rules.ask = [{toolName: "read_file", source: "user"}];
            expect((await call("read_file", {path: paths.conversation})).outcome).toBe("denied");
            expect(approvals).toBe(1);
            rules.ask = [];
            expect((await call("write_file", {path: paths.state, content: "tamper"})).outcome).toBe("denied");
            const alias = join(cwd, "conversation-alias.txt");
            await symlink(paths.conversation, alias);
            expect((await call("read_file", {path: alias})).outcome).toBe("denied");

            await session.taskSession.followup(task.id, "Follow up on the same work");
            await waitForTaskCompletion(session.taskSession, [task.id], ctx.signal, "agent");
            expect((await call("read_file", {path: paths.conversation})).modelContent).toContain("FOLLOWUP_REPORT");
            const page = await call("read_file", {path: paths.conversation});
            expect(page.modelContent).toContain("Continue with read_file");
            expect(String(page.modelContent).length).toBeLessThanOrEqual(60000);
            expect((await call("read_file", {path: paths.conversation, offset: 2001})).modelContent).toContain("paged evidence");
            const rendered = await readFile(paths.conversation, "utf8");
            expect(rendered).not.toContain("�");
            const before = await readFile(paths.events, "utf8");
            expect(before).toContain("CHILD_REPORT");
            const resumed = makeSession("parent");
            expect((await call("read_file", {path: paths.conversation}, resumed.ctx)).outcome).toBe("ok");

            // A corrupted snapshot cannot be hidden by the previously generated view.
            const snapshot = join(getSubagentStorageDirectory(storage, cwd, "parent", task.id), "snapshot.json");
            await writeFile(snapshot, "corrupt");
            expect((await call("read_file", {path: paths.conversation})).outcome).toBe("denied");
            expect(await readFile(paths.events, "utf8")).toBe(before);
            await unlink(paths.state);
            await symlink(join(cwd, "source.txt"), paths.state);
            expect((await call("read_file", {path: paths.state})).outcome).toBe("denied");
            expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("SOURCE_EVIDENCE\n");
            expect(dirname(paths.state)).toBe(getSubagentStorageDirectory(storage, cwd, "parent", task.id));
        } finally {await resources.close();}
    });
});

test.skipIf(process.env.HICODE_RUN_SANDBOX_INTEGRATION !== "1")("real Sandbox permits only the parent's exact child conversation search", async () => {
    await withTempProject(async (outer, storage) => {
        const cwd = join(outer, "project");
        await mkdir(cwd);
        const owner = {parentSessionId: "parent", agentId: "worker"};
        await createSessionPersistence(storage, cwd, owner, "internal").save({cwd, sessionId: "subagent-worker", model: "test",
            history: [{role: "assistant", content: "CHILD_RECORD_NEEDLE"}], todos: [], permissionMode: "ask", allowEmpty: true});
        const sandbox = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [], denyWrite: []}, network: {mode: "restricted", allowedDomains: [], allowLocalBinding: false},
        }});
        try {
            expect(sandbox.status.kind).toBe("ready");
            const ctx = createTestContext(cwd, {sessionId: "parent", workspaceBoundary: cwd, readOnlyTools: true,
                shellRunner: createShellRunner(sandbox, testChildEnvironment), canUseTool: async () => {throw new Error("Unexpected approval");}});
            ctx.storage = storage;
            ctx.subagentRecords = createSubagentRecordAccess(storage, cwd, "parent");
            const path = getSubagentRecordPaths(storage, cwd, "parent", "worker").conversation;
            const runtime = createToolRuntime();
            expect((await runtime.executeTool("read_file", JSON.stringify({path}), ctx, "read")).outcome).toBe("ok");
            const search = await runtime.executeTool("bash", JSON.stringify({command: `rg CHILD_RECORD_NEEDLE '${path}'`}), ctx, "search");
            expect(search.outcome).toBe("ok");
            expect(search.modelContent).toContain("CHILD_RECORD_NEEDLE");
            const denied = await runtime.executeTool("bash", JSON.stringify({command: `ls '${storage.hicodeHome}'`}), ctx, "private");
            expect(denied.outcome).toBe("denied");
        } finally {await sandbox.close();}
    });
});
