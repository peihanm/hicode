import {expect, test} from "bun:test";
import {mkdir, realpath, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {linuxFilesystemPolicy} from "../../src/sandbox/linuxPolicy.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";

function config(root: string): SandboxRuntimeConfig {
    return {filesystem: {allowWrite: [root], denyRead: [], denyWrite: [join(root, ".git"), join(root, ".hicode"), join(root, ".env")]},
        network: {allowedDomains: [], deniedDomains: []}};
}

test("Linux discovers nested protected paths, hidden directories and aliases on each command", async () => {
    await withTempProject(async root => {
        const nested = join(await realpath(root), ".hidden", "nested");
        await mkdir(nested, {recursive: true});
        await mkdir(join(nested, ".git"));
        await mkdir(join(nested, ".hicode"));
        await writeFile(join(nested, ".env.production"), "fixture");
        await symlink(root, join(nested, "cycle"));
        await symlink("missing", join(root, "dangling"));
        const base = config(root);
        const first = await linuxFilesystemPolicy(base, AbortSignal.timeout(5000));
        expect(first.filesystem.denyWrite).toEqual(expect.arrayContaining([
            join(nested, ".git"), join(nested, ".hicode"), join(nested, ".env.production"),
        ]));
        expect(base.filesystem.denyWrite).toHaveLength(3);
        await writeFile(join(nested, ".env.next"), "new");
        const second = await linuxFilesystemPolicy(base, AbortSignal.timeout(5000));
        expect(second.filesystem.denyWrite).toContain(join(nested, ".env.next"));
        expect(first.filesystem.denyWrite).not.toContain(join(nested, ".env.next"));
    });
});

test("Linux rejects configured glob denies and responds to cancellation", async () => {
    await withTempProject(async root => {
        for (const field of ["denyRead", "denyWrite"] as const) {
            const input = config(root);
            input.filesystem[field].push(join(root, "**", "secret"));
            await expect(linuxFilesystemPolicy(input, AbortSignal.timeout(5000))).rejects.toThrow("literal denyRead/denyWrite");
        }
        await expect(linuxFilesystemPolicy(config(root), AbortSignal.abort())).rejects.toThrow();
        await writeFile(join(root, ".env*"), "fixture");
        await expect(linuxFilesystemPolicy(config(root), AbortSignal.timeout(5000))).rejects.toThrow("pattern characters");
    });
});
