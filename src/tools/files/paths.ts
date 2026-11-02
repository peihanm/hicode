import {isAbsolute, relative, resolve} from "node:path";

export function resolveToolPath(cwd: string, inputPath: string): string {
    return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

export function displayToolPath(cwd: string, absPath: string): string {
    const rel = relative(cwd, absPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        return rel;
    }
    return absPath;
}
