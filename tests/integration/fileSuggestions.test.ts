import {expect, test} from "bun:test";
import {mkdir, readdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import type {ShellTermination} from "../../src/tools/bash/process.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {FileSuggestions} from "../../src/runtime/fileSuggestions.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

const signal = () => new AbortController().signal;
test("file suggestions enumerate once, rank paths, refresh new files and keep output out of storage", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "src"));
        await mkdir(join(cwd, "node_modules"));
        await writeFile(join(cwd, ".ignore"), "ignored.ts\n");
        for (const path of ["src/InputBox.tsx", "src/MultilineTextInput.tsx", "src/中文 file.ts", ".env", "ignored.ts", "node_modules/library.ts"]) await writeFile(join(cwd, path), "CONTENT_MUST_NOT_BE_IMPORTED");
        await symlink(join(cwd, "src/InputBox.tsx"), join(cwd, "linked.ts"));
        const base = createTestContext(cwd);
        let runs = 0;
        const source = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, shellRunner: {
            sandboxStatus: base.shellRunner.sandboxStatus,
            run: args => {runs++; return base.shellRunner.run(args);},
        }}));
        try {
            const first = await source.search("input", signal());
            expect(first.paths[0]).toBe("src/InputBox.tsx");
            expect(first.paths).toContain("src/MultilineTextInput.tsx");
            expect((await source.search("中文", signal())).paths).toEqual(["src/中文 file.ts"]);
            const all = await source.search("", signal());
            for (const path of [".env", "ignored.ts", "linked.ts", "node_modules/library.ts"]) expect(all.paths).not.toContain(path);
            expect(runs).toBe(1);
            await writeFile(join(cwd, "src/new-file.ts"), "new");
            expect((await source.search("new-file", signal())).paths).toEqual([]);
            source.invalidate();
            expect((await source.search("new-file", signal())).paths).toEqual(["src/new-file.ts"]);
            expect(runs).toBe(2);
            expect(await readdir(base.toolResultStore.sessionDir).catch(() => [])).toEqual([]);
        } finally {await source.close();}
    });
});

test("concurrent queries share enumeration; cancellation and shutdown discard pending work", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "alpha.ts"), "a");
        const base = createTestContext(cwd);
        let runs = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {release = resolve;});
        const source = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, shellRunner: {
            sandboxStatus: base.shellRunner.sandboxStatus,
            run: async args => {runs++; await gate; return base.shellRunner.run(args);},
        }}));
        const old = new AbortController();
        const first = source.search("old", old.signal).catch(() => "cancelled");
        const second = source.search("alpha", signal());
        old.abort(); release();
        expect(await first).toBe("cancelled");
        expect((await second).paths).toEqual(["alpha.ts"]);
        expect(runs).toBe(1);
        await source.close();
        await expect(source.search("alpha", signal())).rejects.toThrow("closed");
    });
});

test("file suggestion access rules fail locally without opening approval", async () => {
    await withTempProject(async cwd => {
        let approvals = 0;
        const source = new FileSuggestions(abort => {
            const ctx = createTestContext(cwd, {signal: abort, permissionPromptPolicy: "never", canUseTool: async () => {approvals++; return {behavior: "allow"};}});
            ctx.permissionRules.ask.push({toolName: "bash", source: "local"});
            return ctx;
        });
        await expect(source.search("", signal())).rejects.toThrow();
        expect(approvals).toBe(0);
        await source.close();
    });
});

const sandboxEnabled = process.platform === "darwin" && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";
test.skipIf(!sandboxEnabled)("real macOS suggestions use restricted rg and exclude private storage without approvals", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, "src"));
        await writeFile(join(cwd, "src/visible.ts"), "CONTENT_NOT_LOADED");
        await writeFile(join(cwd, ".env"), "fixture-only");
        await mkdir(storage.hicodeHome, {recursive: true});
        await writeFile(join(storage.hicodeHome, "private.txt"), "private");
        const sandbox = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [], denyWrite: []}, network: {allowedDomains: [], allowLocalBinding: false},
        }});
        const runner = createShellRunner(sandbox, testChildEnvironment);
        let approvals = 0;
        const source = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, shellRunner: runner, workspaceBoundary: "/",
            canUseTool: async () => {approvals++; return {behavior: "deny", message: "Unexpected approval"};}}));
        try {
            expect(sandbox.status.kind).toBe("ready");
            const result = await source.search("", signal());
            expect(result.paths).toEqual(["src/visible.ts"]);
            expect(approvals).toBe(0);
        } finally {await source.close(); await sandbox.close();}
    });
}, 15_000);

test("rule changes invalidate cached paths and shutdown waits for cancelled enumeration", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "visible.ts"), "x");
        const base = createTestContext(cwd);
        const source = new FileSuggestions(abort => ({...base, signal: abort}));
        expect((await source.search("visible", signal())).paths).toEqual(["visible.ts"]);
        base.permissionRules.deny.push({toolName: "bash", source: "local"});
        await expect(source.search("visible", signal())).rejects.toThrow();
        await source.close();
        let started!: () => void;
        const ready = new Promise<void>(resolve => {started = resolve;});
        let stopped = false;
        const waiting = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, shellRunner: {
            sandboxStatus: base.shellRunner.sandboxStatus,
            run: async args => {
                started();
                await new Promise<void>(resolve => args.signal.addEventListener("abort", () => resolve(), {once: true}));
                stopped = true;
                return {stdout: "", stderr: "", termination: {kind: "aborted", reason: "user-cancel"}};
            },
        }}));
        const pending = waiting.search("", signal()).catch(() => undefined);
        await ready;
        await waiting.close();
        expect(stopped).toBe(true);
        await pending;
    });
});

test("missing host rg reports the actual dependency error instead of a false limit failure", async () => {
    await withTempProject(async cwd => {
        const runner = createShellRunner(createDisabledSandboxRuntime(), createChildProcessEnvironment({PATH: "/nonexistent"}, []));
        const source = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, shellRunner: runner}));
        try {await expect(source.search("", signal())).rejects.toThrow("ripgrep (rg) is unavailable");}
        finally {await source.close();}
    });
});

for (const [termination, reason] of [
    [{kind: "timeout", timeoutMs: 10_000}, "timed out after 10000ms"],
    [{kind: "output_limit", maxBuffer: 4096}, "4096-byte limit"],
    [{kind: "exit", code: 2, signal: null}, "rg exit code 2"],
    [{kind: "exit", code: 1, signal: "SIGKILL"}, "SIGKILL"],
] satisfies Array<[ShellTermination, string]>) test(`file enumeration distinguishes ${reason}`, async () => {
    await withTempProject(async cwd => {
        const source = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, shellRunner: {
            sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
            run: async () => ({stdout: "", stderr: "", termination}),
        }}));
        try {await expect(source.search("", signal())).rejects.toThrow(reason);}
        finally {await source.close();}
    });
});

test("CLI filesystem-wide permission ceiling is not the project executable trust root", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "index.html"), "fixture");
        const source = new FileSuggestions(abort => createTestContext(cwd, {signal: abort, workspaceBoundary: "/"}));
        try {expect((await source.search("in", signal())).paths).toEqual(["index.html"]);}
        finally {await source.close();}
    });
});
