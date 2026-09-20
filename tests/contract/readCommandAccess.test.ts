import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createReadOnlyBashTool} from "../../src/tools/bash/bash.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {hooksSettingsFileSchema} from "../../src/hooks/schema.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";

test("read-only roles and Plan reject unsupported shell capabilities without requesting approval", async () => {
    await withTempProject(async cwd => {
        let approvals = 0;
        for (const options of [{readOnlyTools: true}, {collaborationMode: "plan" as const}]) {
            const ctx = createTestContext(cwd, {...options, canUseTool: async () => {approvals++; return {behavior: "allow"};}});
            for (const command of ["node -e 'process.stdout.write(1)'", "rg --pre ./pre -e x .", "rg x . > output", "PATH=. rg x ."]) {
                expect((await executeToolResult("bash", JSON.stringify({command}), ctx, command)).outcome).toBe("denied");
            }
            expect((await executeToolResult("bash", JSON.stringify({command: "pwd"}), ctx, "pwd")).outcome).toBe("ok");
        }
        expect(approvals).toBe(0);
    });
});

test("internal read-only Bash override cannot inherit a writable consolidator's shell capability", async () => {
    await withTempProject(async cwd => {
        const runtime = createToolRuntime({allowedToolNames: ["bash", "write_file"], toolOverrides: [createReadOnlyBashTool()]});
        const ctx = createTestContext(cwd);
        for (const input of [{command: "echo bad > out"}, {command: "pwd", run_in_background: true}, {command: "pwd", sandbox_permissions: "require_escalated"}]) {
            expect((await runtime.executeTool("bash", JSON.stringify(input), ctx, "blocked")).outcome).toBe("denied");
        }
        expect((await runtime.executeTool("bash", JSON.stringify({command: "ls ."}), ctx, "list")).outcome).toBe("ok");
        expect((await runtime.executeTool("write_file", JSON.stringify({path: "draft.md", content: "draft"}), ctx, "write")).outcome).toBe("ok");
    });
});

test("missing rg and unavailable sandbox fail without automatic fallback", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "file.txt"), "needle");
        const missing = createShellRunner(createDisabledSandboxRuntime(), createChildProcessEnvironment({PATH: "/nonexistent"}, []));
        const unavailable = createShellRunner({...createDisabledSandboxRuntime(), status: {kind: "unavailable", reason: "offline fixture", warnings: []}}, createChildProcessEnvironment(process.env, []));
        for (const [shellRunner, reason] of [[missing, "ripgrep (rg) is unavailable"], [unavailable, "offline fixture"]] as const) {
            const result = await executeToolResult("bash", JSON.stringify({command: "rg needle file.txt"}), createTestContext(cwd, {shellRunner}), reason);
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain(reason);
        }
    });
});

test("removed exact tool Hook matchers require edits but identically named agents remain valid", () => {
    const hooks = [{type: "command", purpose: "observe", command: "echo observed"}];
    expect(hooksSettingsFileSchema.safeParse({PostToolUse: [{matcher: "read_file|grep", hooks}]}).success).toBe(false);
    expect(hooksSettingsFileSchema.safeParse({PostToolUse: [{matcher: "bash", hooks}]}).success).toBe(true);
    expect(hooksSettingsFileSchema.safeParse({SubagentStart: [{matcher: "grep", hooks}]}).success).toBe(true);
});
