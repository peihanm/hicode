import {expect, test} from "bun:test";
import {mkdir, realpath, symlink} from "node:fs/promises";
import {join} from "node:path";
import {isPathInside, resolveFilePermissionPath, validateWorkspacePath} from "../../src/permissions/pathGuard.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {createFilePermissionMatcher} from "../../src/permissions/filePattern.js";
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

test("new descendants of a real directory alias agree across path, grant and rule checks", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "private"));
        await symlink(join(cwd, "private"), join(cwd, "alias"));
        const path = "alias/future/new.txt";
        const target = join(await realpath(cwd), "private/future/new.txt");
        expect(await resolveFilePermissionPath(cwd, path)).toBe(target);
        expect(await validateWorkspacePath(cwd, cwd, path)).toMatchObject({ok: true});
        const directories = createDirectoryAccessRuntime({cwd, hardBoundary: cwd});
        expect(await directories.canAccess(path)).toBe(true);
        expect((await directories.createRequest(path, "write")).targetPath).toBe(target);
        const match = await createFilePermissionMatcher(cwd, path, ["private/**"]);
        expect(match("private/**", "deny")).toBe(true);
    });
});

test("broken symlinks are rejected instead of treated as ordinary missing write targets", async () => {
    await withTempProject(async cwd => {
        await symlink(join(cwd, "not-created"), join(cwd, "broken"));
        const directories = createDirectoryAccessRuntime({cwd, hardBoundary: cwd});
        for (const path of ["broken", "broken/new.txt"]) {
            await expect(resolveFilePermissionPath(cwd, path)).rejects.toThrow();
            expect(await validateWorkspacePath(cwd, cwd, path)).toMatchObject({ok: false});
            await expect(directories.canAccess(path)).rejects.toThrow();
            await expect(directories.createRequest(path, "write")).rejects.toThrow();
            await expect(createFilePermissionMatcher(cwd, path, ["**"])).rejects.toThrow();
        }
    });
});
