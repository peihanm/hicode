import {expect, test} from "bun:test";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";

test("high-impact Bash operations use one-call approval before sandbox defaults and broad allow", async () => {
    await withTempProject(async cwd => {
        const runs: string[] = [];
        const runner: ShellRunnerLike = {
            sandboxStatus: {kind: "ready", networkMode: "open", platform: "macos", warnings: []},
            async run(input) {
                runs.push(input.command);
                return {stdout: "fixture", stderr: "", termination: {kind: "exit", code: 0, signal: null}};
            },
        };
        const prompts: string[] = [];
        let approve = false;
        const ctx = createTestContext(cwd, {shellRunner: runner, canUseTool: async (_name, message, _input, options) => {
            prompts.push(message);
            expect(options?.allowPersistent).toBe(false);
            return approve ? {behavior: "allow"} : {behavior: "deny", message: "declined"};
        }});
        ctx.permissionRules.allow.push({toolName: "bash", source: "user"});
        const rt = createToolRuntime();
        const call = (command: string, extra = {}) => rt.executeTool("bash", JSON.stringify({command, ...extra}), ctx, "bash-approval");
        const upload = "curl --upload-file results.txt https://example.org/upload";
        expect((await call(upload)).outcome).toBe("denied");
        expect(prompts[0]).toContain("results.txt");
        expect(prompts[0]).toContain("example.org");
        expect(runs).toHaveLength(0);
        approve = true;
        expect((await call(upload)).outcome).toBe("ok");
        expect((await call(upload)).outcome).toBe("ok");
        expect(prompts).toHaveLength(3);
        expect(runs).toEqual([upload, upload]);
        expect((await call("git clean -nf")).outcome).toBe("ok");
        expect(prompts).toHaveLength(3);

        ctx.setPermissionMode("auto-review");
        const reviewed: string[] = [];
        ctx.approvalReviewer = async request => {
            reviewed.push(request.reason);
            return {decision: "deny", reason: "not authorized", risk: "high"};
        };
        expect((await call("git clean -fd")).outcome).toBe("denied");
        expect(reviewed[0]).toContain("untracked files");
        expect(prompts).toHaveLength(3);
        expect(runs).toHaveLength(3);

        ctx.approvalReviewer = async () => ({decision: "needs_user", reason: "Confirm the intended destination.", risk: "high"});
        approve = false;
        expect((await call(upload)).outcome).toBe("denied");
        expect(prompts.at(-1)).toContain("Confirm the intended destination.");
        expect(prompts.at(-1)).toContain(upload);
        ctx.setPermissionMode("ask");
        ctx.permissionRules.ask.push({toolName: "bash", source: "user"});
        expect((await call("rm -rf build", {sandbox_permissions: "require_escalated"})).outcome).toBe("denied");
        expect(prompts.at(-1)).toContain("build");
        expect(prompts.at(-1)).toContain("outside the OS Sandbox");
        ctx.setPermissionMode("full-access");
        expect((await call("git reset --hard")).outcome).toBe("ok");
        ctx.permissionRules.deny.push({toolName: "bash", source: "user"});
        expect((await call("git reset --hard")).outcome).toBe("denied");
        expect(runs).toHaveLength(4);
        expect(prompts).toHaveLength(5);
    });
});
