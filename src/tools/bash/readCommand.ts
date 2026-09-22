import {access, realpath, stat} from "node:fs/promises";
import {constants} from "node:fs";
import {basename, delimiter, isAbsolute, join, resolve} from "node:path";
import {isPathInside} from "../../permissions/pathGuard.js";
import type {ChildProcessEnvironment} from "../../runtime/childEnvironment.js";
import type {CommandReadAccess} from "./readAccess.js";

const SYSTEM_PROGRAMS: Record<string, string> = {ls: "/bin/ls", pwd: "/bin/pwd", cat: "/bin/cat", echo: "/bin/echo",
    head: "/usr/bin/head", tail: "/usr/bin/tail", wc: "/usr/bin/wc"};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Resolve programs without invoking a shell or inheriting aliases/startup hooks. */
export async function prepareReadCommand(accessScope: CommandReadAccess, cwd: string, environment: ChildProcessEnvironment) {
    const executables: string[] = [];
    const commands: string[] = [];
    for (const segment of accessScope.plan.segments) {
        const name = basename(segment.program);
        let executable: string | undefined;
        if (name !== "rg") executable = SYSTEM_PROGRAMS[name];
        else {
            for (const directory of (environment.base.PATH ?? "").split(delimiter)) {
                if (!isAbsolute(directory)) continue;
                const candidate = join(directory, "rg");
                try {
                    await access(candidate, constants.X_OK);
                    if (!(await stat(candidate)).isFile()) continue;
                    executable = await realpath(candidate);
                    break;
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code)))) throw error;
                }
            }
        }
        if (!executable) throw new Error("ripgrep (rg) is unavailable. Install rg on the host PATH; HiCode does not download programs during a search.");
        executable = await realpath(executable);
        if (isPathInside(accessScope.projectRoot, executable) || isPathInside(accessScope.privateRoot, executable)) throw new Error("Read-only commands cannot execute a program from the task workspace or private storage");
        if (segment.program.includes("/") && await realpath(resolve(cwd, segment.program)) !== executable) throw new Error("Read-only commands must use the trusted host executable, not a project-supplied program");
        executables.push(executable);
        const args = name === "rg" ? ["--no-config", "--no-ignore-global", ...segment.args] : segment.args;
        commands.push([executable, ...args].map(quote).join(" ") + (segment.next ? ` ${segment.next}` : ""));
    }
    return {command: commands.join(" "), access: {paths: accessScope.paths, artifacts: accessScope.artifacts, artifactDirectories: accessScope.artifactDirectories,
        deniedPaths: accessScope.deniedPaths, privateRoot: accessScope.privateRoot, executables: [...new Set(executables)]}};
}
