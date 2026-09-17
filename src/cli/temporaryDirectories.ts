import {realpath, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute} from "node:path";

/** CLI defaults only; embedded Hosts retain their explicit directory boundary. */
export async function cliTemporaryDirectories(): Promise<string[]> {
    const paths = process.platform === "win32" ? [tmpdir()] : ["/tmp", tmpdir()];
    const directories = new Set<string>();
    for (const path of paths) {
        if (!isAbsolute(path)) throw new Error("The system temporary directory must be absolute");
        const canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a temporary directory: ${path}`);
        directories.add(canonical);
    }
    return [...directories];
}
