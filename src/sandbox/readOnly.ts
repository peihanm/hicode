import {resolveFilePermissionPath} from "../permissions/filePattern.js";
import {isAbsolute, resolve} from "node:path";

export interface ReadOnlyAccess {
    paths: readonly string[];
    executables: readonly string[];
    deniedPaths: readonly string[];
    privateRoot: string;
    artifacts: readonly string[];
}

function quote(path: string): string {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("Read-only Sandbox paths must be absolute");
    return JSON.stringify(path);
}

/** Exact path grants and final denials avoid broad read exceptions overriding private-file restrictions. */
export async function readOnlySandboxArgv(command: string, access: ReadOnlyAccess, configuredDenials: readonly string[], cwd: string): Promise<string[]> {
    if (process.platform !== "darwin") throw new Error("Restricted command search currently requires the macOS Sandbox");
    const pattern = (path: string) => {
        if (!isAbsolute(path) || /[\0\r\n{}()!\\]/.test(path)) throw new Error("Cannot safely enforce this read-deny pattern in the read-only Sandbox");
        if (!/[*?\[\]]/.test(path)) return `(subpath ${quote(path)})`;
        // Keep the same bounded glob dialect as Sandbox filesystem rules, not arbitrary JavaScript regex.
        if (/[\[\]]/.test(path)) throw new Error("Read-only Sandbox deny patterns support literal paths, * and ?");
        const regex = "^" + path.split(/(\*\*\/|\*\*|\*|\?)/).map(part => {
            if (part === "**/") return "(.*/)?";
            if (part === "**") return ".*";
            if (part === "*") return "[^/]*";
            if (part === "?") return "[^/]";
            return part.replace(/[.+^$|[\]{}()\\]/g, "\\$&");
        }).join("") + "$";
        return `(regex ${JSON.stringify(regex)})`;
    };
    const denials = new Set(configuredDenials);
    for (const path of configuredDenials) {
        const magic = path.search(/[*?\[\]]/);
        if (magic < 0) denials.add(await resolveFilePermissionPath(cwd, path));
        else {
            const slash = path.lastIndexOf("/", magic);
            const prefix = path.slice(0, slash) || "/";
            denials.add(resolve(await resolveFilePermissionPath(cwd, prefix), path.slice(slash + 1)));
        }
    }
    const readable = [...new Set(["/System/Library", "/usr/lib", "/private/var/db/dyld", "/dev/null",
        "/bin/bash", ...access.executables, ...access.paths].map(path => resolve(path)))];
    const profile = [
        "(version 1)", "(deny default)",
        "(allow process-fork)",
        `(allow process-exec ${["/bin/bash", ...access.executables].map(path => `(literal ${quote(path)})`).join(" ")})`,
        "(allow signal (target self))", "(allow sysctl-read)",
        // Traversal/stat is needed by dyld and realpath; it does not allow reading other file contents.
        "(allow file-read-metadata)",
        "(allow file-read* (literal \"/\"))",
        `(allow file-read* (literal ${quote(cwd)}))`,
        `(allow file-read* ${readable.map(path => `(subpath ${quote(path)})`).join(" ")})`,
        "(allow file-write* (literal \"/dev/null\"))",
        `(deny file-read* (subpath ${quote(access.privateRoot)}))`,
        ...access.artifacts.map(path => `(allow file-read* (literal ${quote(path)}))`),
        ...access.deniedPaths.map(path => `(deny file-read* (subpath ${quote(path)}))`),
        ...[...denials].map(path => `(deny file-read* ${pattern(path)})`),
        "(deny network*)",
    ].join("\n");
    return ["/usr/bin/sandbox-exec", "-p", profile, "/bin/bash", "--noprofile", "--norc", "-c", command];
}
