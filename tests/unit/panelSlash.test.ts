import {expect, test} from "bun:test";
import {processSlashCommand} from "../helpers/slash.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

test("panel commands route to the right Host callback and reject arguments before opening", async () => {
    await withTempProject(async cwd => {
        const opened: string[] = [], output: string[] = [];
        const context = {
            history: [], ctx: createTestContext(cwd),
            onEvent(event: {type: string; content?: string}) {
                if (event.type === "assistant_text" && event.content) output.push(event.content);
            },
            openModel: () => {opened.push("model");},
            openProviders: () => {opened.push("providers");},
            openPermissions: () => {opened.push("permissions");},
            openResume: () => {opened.push("resume");},
            openGitDiff: () => {opened.push("diff");},
        };
        const commands = ["model", "providers", "permissions", "resume", "diff"];
        for (const name of commands) {
            await processSlashCommand(`/${name} extra`, context);
            expect(opened).toEqual([]);
        }
        expect(output).toEqual(commands.map(name => `Usage: /${name}`));
        output.length = 0;
        for (const name of commands) await processSlashCommand(`/${name}`, context);
        expect(opened).toEqual(commands);
        expect(output).toEqual([]);

        for (const [name, expected] of [
            ["model", `Current model: ${context.ctx.model}`],
            ["providers", "Provider setup is available in the interactive CLI."],
            ["permissions", "Access & approval:"],
        ]) {
            output.length = 0;
            await processSlashCommand(`/${name}`, {history: [], ctx: context.ctx, onEvent: context.onEvent});
            expect(output).toHaveLength(1);
            expect(output[0]).toContain(expected);
        }
    });
});
