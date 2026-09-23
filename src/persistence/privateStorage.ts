import {readBoundedTextFile} from "./readTextFile.js";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import type {HiCodeStorageLayout} from "./layout.js";

function storageRelativePath(
    storage: HiCodeStorageLayout,
    targetPath: string
): {home: string; relativePath: string} {
    const home = resolve(storage.hicodeHome);
    const target = resolve(targetPath);
    const relativePath = relative(home, target);
    if (
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`HiCode storage path is out of bounds: ${targetPath}`);
    }
    return {home, relativePath};
}

function assertDirectory(path: string): void {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Unsafe HiCode storage directory: ${path}`);
    }
}

export function ensurePrivateStorageDirectory(
    storage: HiCodeStorageLayout,
    directory: string
): void {
    const {home, relativePath} = storageRelativePath(storage, directory);
    mkdirSync(home, {recursive: true, mode: 0o700});
    assertDirectory(home);
    chmodSync(home, 0o700);
    let current = home;
    for (const component of relativePath.split(sep)) {
        if (!component || component === ".") continue;
        current = join(current, component);
        try {
            mkdirSync(current, {mode: 0o700});
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        assertDirectory(current);
        chmodSync(current, 0o700);
    }
}

/** Read a private regular file without following a leaf symlink. */
export function readPrivateStorageTextFile(
    storage: HiCodeStorageLayout,
    path: string,
    maxBytes: number
): string | null {
    const directory = dirname(path);
    const {home, relativePath} = storageRelativePath(storage, directory);
    let current = home;
    try {
        assertDirectory(current);
        for (const component of relativePath.split(sep)) {
            if (!component || component === ".") continue;
            current = join(current, component);
            assertDirectory(current);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }

    try {
        return readBoundedTextFile(path, maxBytes);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}
