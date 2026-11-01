import {readHookTrust, saveHookTrust} from "../../src/hooks/approval.js";
import {hooksSettingsFileSchema} from "../../src/hooks/schema.js";
import {createHookRuntimeFactory} from "../helpers/hooks.js";
import {getHookTrustPath} from "../../src/persistence/layout.js";
import {expect, test} from "bun:test";
import {lstat, mkdir, readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createHookSessionRuntime,
    type HookEnvelope, type HookInput, type HookLifecycleEvent} from "../../src/hooks/index.js";
import {createToolResultStore} from "../../src/toolResults/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {resolvedHooks} from "../helpers/hooks.js";

const prompt: HookInput = {hook_event_name: "UserPromptSubmit", session_id: "session", turn_id: "turn", permission_mode: "default", prompt: "hello"};
const ok = (stdout = "") => ({stdout, stderr: "", termination: {kind: "exit" as const, code: 0}});

test("argv 保留空格和 Shell 字符，v2 身份、诊断和 UI 文本分开交付", async () => {
    await withTempProject(async (cwd, storage) => {
        const script = join(cwd, "check hook.cjs");
        await writeFile(script, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
            const x=JSON.parse(s);process.stdout.write(JSON.stringify({decision:'pass',userMessage:process.argv[2],additionalContext:x.version+':'+x.event.turn_id}));
            process.stderr.write('diagnostic only');});`);
        const literal = 'literal ; $(touch escaped) "value"';
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "allow"})({cwd, storage,
            childEnvironment: testChildEnvironment, hooks: resolvedHooks("UserPromptSubmit", [
                {type: "command", purpose: "control", executable: "node", args: [script, literal]},
            ])});
        const session = createHookSessionRuntime();
        const events: HookLifecycleEvent[] = [];
        const result = await runtime.execute(prompt, new AbortController().signal, {session,
            store: createToolResultStore(storage, cwd, "session"), onEvent: event => {events.push(event);}});
        expect(result.error).toBeUndefined();
        expect(result.additionalContexts).toEqual(["2:turn"]);
        expect(result.executions[0]?.userMessage).toBe(literal);
        expect(await Bun.file(join(cwd, "escaped")).exists()).toBe(false);
        expect(events.map(event => event.type)).toEqual(["hook_started", "hook_completed"]);
        expect(events[0]?.execution.executionId).toBe(events[1]?.execution.executionId);
        expect(await readFile(result.executions[0]!.artifact!.path, "utf8")).toContain("diagnostic only");
        expect(session.recent()[0]?.outcome).toBe("success");
    });
});

test.each(["broken-json", "exit", "oversize-input"])("Control %s 不成为放行决定，也不启动后续处理器", async mode => {
    await withTempProject(async (cwd, storage) => {
        const calls: string[] = [];
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "allow", executeCommand: async input => {
            calls.push(input.command!);
            return mode === "broken-json" ? ok("broken") : {...ok(), termination: {kind: "exit", code: 1}};
        }})({cwd, storage, childEnvironment: testChildEnvironment, hooks: resolvedHooks("UserPromptSubmit", [
            {type: "command", purpose: "control", command: "first"}, {type: "command", purpose: "control", command: "second"},
        ])});
        const result = await runtime.execute({...prompt, prompt: mode === "oversize-input" ? "x".repeat(16 * 1024 * 1024) : "hello"}, new AbortController().signal);
        expect(result.blocked).toBe(false);
        expect(result.error).toBeDefined();
        expect(calls).toEqual(mode === "oversize-input" ? [] : ["first"]);
    });
});

test("dispatch 期限覆盖整批，未运行的 control 标记 skipped_budget；父取消保持 interrupted", async () => {
    await withTempProject(async (cwd, storage) => {
        const calls: string[] = [];
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "allow", executeCommand: async input => {
            calls.push(input.command!);
            expect(input.timeoutMs).toBeLessThanOrEqual(100);
            await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), {once: true}));
            return {...ok(), termination: {kind: "aborted"}};
        }})({cwd, storage, childEnvironment: testChildEnvironment, hooks: resolvedHooks("UserPromptSubmit", [
            {type: "command", purpose: "observe", command: "slow"}, {type: "command", purpose: "control", command: "never"},
        ], 100)});
        const result = await runtime.execute(prompt, new AbortController().signal);
        expect(calls).toEqual(["slow"]);
        expect(result.error).toBeDefined();
        expect(result.executions.map(item => item.outcome)).toEqual(["error", "skipped_budget"]);
        const controller = new AbortController(); controller.abort("user-cancel");
        const cancelled = await runtime.execute(prompt, controller.signal);
        expect(cancelled.error).toBeUndefined();
        expect(cancelled.executions.every(item => item.outcome === "interrupted")).toBe(true);
        expect(calls).toHaveLength(1);
    });
});

test("定义变化重新批准、未变 once 不重跑、重载失败不半更新", async () => {
    await withTempProject(async (cwd, storage) => {
        let decisions = 0;
        let runs = 0;
        const settings = resolvedHooks("UserPromptSubmit", [{type: "command", purpose: "control", command: "check", once: true}]);
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "pending", executeCommand: async () => {runs++; return ok();}})({
            cwd, storage, childEnvironment: testChildEnvironment, hooks: settings,
            requestTrust: async () => {decisions++; return decisions < 3 ? "once" : "deny";},
        });
        const signal = new AbortController().signal;
        const session = createHookSessionRuntime();
        await runtime.execute(prompt, signal, {session});
        const firstId = runtime.inspect()[0]!.hookId;
        await runtime.reload(structuredClone(settings), signal);
        await runtime.execute(prompt, signal, {session});
        expect(decisions).toBe(1); expect(runs).toBe(1);
        const changed = resolvedHooks("UserPromptSubmit", [{type: "command", purpose: "control", command: "changed", once: true}]);
        await runtime.reload(changed, signal); await runtime.execute(prompt, signal, {session});
        expect(decisions).toBe(2); expect(runs).toBe(2);
        expect(runtime.inspect()[0]!.hookId).not.toBe(firstId);
        const before = runtime.inspect();
        await expect(runtime.reload(settings, signal)).rejects.toThrow("not approved");
        expect(runtime.inspect()).toEqual(before);
        expect(session.recent()).toHaveLength(2);
    });
});

test("旧项目级批准拒绝读取且不自动清理", async () => {
    await withTempProject(async (_cwd, storage) => {
        await mkdir(storage.hicodeHome, {recursive: true});
        const path = getHookTrustPath(storage);
        const value = JSON.stringify({version: 1, projects: []});
        await writeFile(path, value);
        await expect(readHookTrust(path, "/project")).rejects.toThrow("version 2");
        expect(await readFile(path, "utf8")).toBe(value);
    });
});

test("Observe 大输入标记裁剪并归档；最近执行摘要最多 100 条", async () => {
    await withTempProject(async (cwd, storage) => {
        const envelopes: HookEnvelope[] = [];
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "allow", executeCommand: async ({stdin}) => {
            envelopes.push(JSON.parse(stdin) as HookEnvelope); return ok();
        }})({cwd, storage, childEnvironment: testChildEnvironment,
            hooks: resolvedHooks("UserPromptSubmit", [{type: "command", purpose: "observe", command: "notify"}])});
        const signal = new AbortController().signal;
        const session = createHookSessionRuntime();
        await runtime.execute({...prompt, prompt: "x".repeat(70000)}, signal,
            {session, store: createToolResultStore(storage, cwd, "session")});
        expect(envelopes[0]?.truncated).toBe(true);
        expect(envelopes[0]?.input_result_id).toBeDefined();
        expect(Buffer.byteLength(JSON.stringify(envelopes[0]))).toBeLessThan(65536);
        for (let i = 0; i < 101; i++) await runtime.execute(prompt, signal, {session});
        expect(session.recent()).toHaveLength(100);
    });
});

test("配置拒绝通知型控制和 Shell/argv 混用", () => {
    for (const hooks of [
        {TurnEnd: [{hooks: [{type: "command", purpose: "control", command: "x"}]}]},
        {SessionStart: [{hooks: [{type: "command", purpose: "observe", command: "x", executable: "node", args: []}]}]},
    ]) expect(hooksSettingsFileSchema.safeParse(hooks).success).toBe(false);
});


test("Command Control stdin 完整传递大段 Unicode，末尾拒绝条件不丢失", async () => {
    await withTempProject(async (cwd, storage) => {
        const script = join(cwd, "large.cjs");
        await writeFile(script, `let input='';process.stdin.setEncoding('utf8');
            process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
                const x=JSON.parse(input);const p=x.event.prompt;
                process.stdout.write(JSON.stringify({decision:p.endsWith('DENY')?'block':'pass',reason:'checked',
                    additionalContext:Buffer.byteLength(p)+':'+p.slice(-4)}));});`);
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "allow"})({cwd, storage,
            childEnvironment: testChildEnvironment, hooks: resolvedHooks("UserPromptSubmit", [
                {type: "command", purpose: "control", executable: "node", args: [script]},
            ])});
        const content = "中文🌟".repeat(20000) + "DENY";
        const result = await runtime.execute({...prompt, prompt: content}, new AbortController().signal);
        expect(result.error).toBeUndefined();
        expect(result.blocked).toBe(true);
        expect(result.additionalContexts).toContain(Buffer.byteLength(content) + ":DENY");
    });
});


test("control decisions expire during diagnostic persistence before completion is published", async () => {
    await withTempProject(async (cwd, storage) => {
        let hookSignal: AbortSignal | undefined;
        const runtime = await createHookRuntimeFactory({readTrust: async () => () => "allow", executeCommand: async input => {
            hookSignal = input.signal; return ok(JSON.stringify({decision: "pass", additionalContext: "must not deliver"}));
        }})({cwd, storage, childEnvironment: testChildEnvironment,
            hooks: resolvedHooks("UserPromptSubmit", [{type: "command", purpose: "control", command: "fixture"}], 100)});
        const store = createToolResultStore(storage, cwd, "session");
        const persist = store.persistText.bind(store);
        store.persistText = async input => {await new Promise(resolve => setTimeout(resolve, 150)); return persist(input);};
        const events: HookLifecycleEvent[] = [];
        const result = await runtime.execute(prompt, new AbortController().signal, {store, onEvent: event => {events.push(event);}});
        expect(hookSignal?.aborted).toBe(true);
        expect(result.error).toContain("timed out");
        expect(result.additionalContexts).toHaveLength(0);
        expect(events.at(-1)).toMatchObject({type: "hook_completed", execution: {outcome: "error"}});
    });
});

test("definition approval reads once and saves a whole group; failed reload retains the active configuration", async () => {
    await withTempProject(async (cwd, storage) => {
        let reads = 0, writes = 0, failSave = false;
        const factory = createHookRuntimeFactory({
            readTrust: async (path, project) => {reads++; return readHookTrust(path, project);},
            saveTrust: async (...args) => {
                writes++;
                if (failSave) throw new Error("fixture save failed");
                await saveHookTrust(...args);
            },
        });
        const settings = (commands: string[]) => resolvedHooks("PreToolUse", commands.map(command => ({
            type: "command", purpose: "control", command,
        })));
        const initial = settings(["first", "second"]);
        const runtime = await factory({cwd, storage, childEnvironment: testChildEnvironment,
            hooks: initial, requestTrust: async () => "always"});
        expect(reads).toBe(1);
        expect(writes).toBe(1);
        const active = runtime.inspect();
        expect(active).toHaveLength(2);
        expect(active.every(item => item.approved)).toBe(true);
        const path = getHookTrustPath(storage);
        const before = await readFile(path, "utf8");
        expect(JSON.parse(before).projects).toHaveLength(2);
        await runtime.reload(initial, new AbortController().signal);
        expect(reads).toBe(1);
        expect(writes).toBe(1);

        failSave = true;
        await expect(runtime.reload(settings(["first", "second", "third", "fourth"]),
            new AbortController().signal)).rejects.toThrow("fixture save failed");
        expect(reads).toBe(2);
        expect(writes).toBe(2);
        expect(runtime.inspect()).toEqual(active);
        expect(await readFile(path, "utf8")).toBe(before);

        failSave = false;
        await runtime.reload(settings(["first", "second", "third", "fourth"]), new AbortController().signal);
        expect(runtime.inspect()).toHaveLength(4);
        expect(runtime.inspect().every(item => item.approved)).toBe(true);
        expect(JSON.parse(await readFile(path, "utf8")).projects).toHaveLength(4);
    });
});

test("trust batch validation is atomic and snapshots remain isolated by project", async () => {
    await withTempProject(async (cwd) => {
        const path = join(cwd, "trust.json");
        const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
        await Promise.all([
            saveHookTrust(path, "/first", [a, b], "always"),
            saveHookTrust(path, "/second", [a], "deny"),
        ]);
        const first = await readHookTrust(path, "/first");
        expect([first(a), first(b), first(c)]).toEqual(["allow", "allow", "pending"]);
        expect((await readHookTrust(path, "/second"))(a)).toBe("deny");
        const before = await readFile(path, "utf8");
        await expect(saveHookTrust(path, "/first", [c, "invalid-id"], "always")).rejects.toThrow();
        expect(await readFile(path, "utf8")).toBe(before);
        await saveHookTrust(path, "/first", [a, b], "deny");
        expect(first(a)).toBe("allow");
        const updated = await readHookTrust(path, "/first");
        expect([updated(a), updated(b)]).toEqual(["deny", "deny"]);
    });
});

test("trust storage rejects invalid UTF-8, oversized files and dangling symlinks without overwriting them", async () => {
    await withTempProject(async (cwd) => {
        const path = join(cwd, "trust.json");
        const id = "a".repeat(64);
        for (const input of [Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 32)]) {
            await writeFile(path, input);
            await expect(readHookTrust(path, cwd)).rejects.toThrow();
            await expect(saveHookTrust(path, cwd, [id], "always")).rejects.toThrow();
            expect((await readFile(path)).equals(input)).toBe(true);
        }
        await unlink(path);
        await symlink(join(cwd, "missing.json"), path);
        await expect(readHookTrust(path, cwd)).rejects.toThrow();
        await expect(saveHookTrust(path, cwd, [id], "always")).rejects.toThrow();
        expect((await lstat(path)).isSymbolicLink()).toBe(true);
    });
});
