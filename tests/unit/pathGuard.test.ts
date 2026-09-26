import {expect, test} from "bun:test";
import {mkdir, symlink} from "node:fs/promises";
import {join} from "node:path";
import {isPathInside, validateWorkspacePath} from "../../src/permissions/pathGuard.js";
import {withTempProject} from "../helpers/tempProject.js";

test("ordinary dot-prefixed names stay inside the workspace; traversal and symlink escapes do not", async () => {
    await withTempProject(async root => {
        const workspace = join(root, "project"), outside = join(root, "outside");
        await mkdir(workspace); await mkdir(outside);
        for (const name of ["..cache", "...", "..notes.txt"]) {
            expect(isPathInside(workspace, join(workspace, name))).toBe(true);
            expect(await validateWorkspacePath(workspace, workspace, name)).toMatchObject({ok: true});
        }
        for (const path of [root, outside, `${workspace}-other`]) expect(isPathInside(workspace, path)).toBe(false);
        await symlink(outside, join(workspace, "..link"));
        expect(await validateWorkspacePath(workspace, workspace, "..link/new.txt")).toMatchObject({ok: false});
        expect(await validateWorkspacePath(workspace, workspace, "../outside/new.txt")).toMatchObject({ok: false});
    });
});
