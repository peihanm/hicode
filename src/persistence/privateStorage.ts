import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import type {PillarStorageLayout} from "./layout.js";

function storageRelativePath(
    storage: PillarStorageLayout,
    targetPath: string
): {home: string; relativePath: string} {
    const home = resolve(storage.pillarHome);
    const target = resolve(targetPath);
    const relativePath = relative(home, target);
    if (
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`Pillar storage 路径越界: ${targetPath}`);
    }
    return {home, relativePath};
}

function assertDirectory(path: string): void {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Pillar storage 目录不安全: ${path}`);
    }
}

export function ensurePrivateStorageDirectory(
    storage: PillarStorageLayout,
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
function readPrivateStorageFile(
    storage: PillarStorageLayout,
    path: string,
    maxBytes: number
): Buffer | null {
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

    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = fstatSync(descriptor);
        if (!metadata.isFile()) {
            throw new Error(`Pillar storage 文件不是 regular file: ${path}`);
        }
        if (metadata.size > maxBytes) {
            throw new Error(`Pillar storage 文件超过大小上限: ${path}`);
        }
        return readFileSync(descriptor);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

export function readPrivateStorageTextFile(
    storage: PillarStorageLayout,
    path: string,
    maxBytes: number
): string | null {
    return readPrivateStorageFile(storage, path, maxBytes)?.toString("utf8") ?? null;
}
