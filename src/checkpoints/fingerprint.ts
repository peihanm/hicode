import {createHash} from "node:crypto";
import {lstat, readFile, realpath, stat} from "node:fs/promises";
import {isAbsolute, relative, resolve, sep} from "node:path";
import type {FileFingerprint} from "./types.js";

export const MAX_CHECKPOINT_FILE_BYTES = 20 * 1024 * 1024;

export function hashCheckpointContent(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

export function fingerprintContent(
    content: string | Buffer,
    mode?: number
): FileFingerprint {
    return {
        kind: "regular",
        sha256: hashCheckpointContent(content),
        byteLength: Buffer.byteLength(content),
        ...(mode === undefined ? {} : {mode}),
    };
}

export function missingFingerprint(): FileFingerprint {
    return {kind: "missing"};
}

export function fingerprintsEqual(
    left: FileFingerprint,
    right: FileFingerprint
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "missing") return true;
    return (
        left.sha256 === right.sha256 &&
        left.byteLength === right.byteLength
    );
}

function isErrorCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as {code?: string}).code === code
    );
}

function isInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function isRelativeInside(path: string): boolean {
    return path.length > 0 &&
        !path.startsWith(`..${sep}`) &&
        path !== ".." &&
        !isAbsolute(path);
}

async function nearestExistingParent(path: string): Promise<string> {
    let candidate = path;
    while (true) {
        try {
            await stat(candidate);
            return candidate;
        } catch (error) {
            if (!isErrorCode(error, "ENOENT")) throw error;
        }
        const parent = resolve(candidate, "..");
        if (parent === candidate) return candidate;
        candidate = parent;
    }
}

export interface ValidatedCheckpointPath {
    absolutePath: string;
    relativePath: string;
    mode?: number;
    exists: boolean;
}

export async function validateCheckpointPath(
    cwd: string,
    inputPath: string
): Promise<ValidatedCheckpointPath> {
    const canonicalCwd = await realpath(cwd);
    const lexicalCwd = resolve(cwd);
    const requestedPath = resolve(inputPath);
    const lexicalCandidate = relative(lexicalCwd, requestedPath);
    const canonicalCandidate = relative(canonicalCwd, requestedPath);
    const lexicalRelative = isRelativeInside(lexicalCandidate)
        ? lexicalCandidate
        : canonicalCandidate;
    if (!isRelativeInside(lexicalRelative)) {
        throw new Error("Checkpoint 只支持当前项目内的文件");
    }
    const absolutePath = resolve(canonicalCwd, lexicalRelative);

    try {
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink()) {
            throw new Error("Checkpoint 不支持 symlink");
        }
        if (!info.isFile()) {
            throw new Error("Checkpoint 只支持 regular file");
        }
        const canonicalTarget = await realpath(absolutePath);
        if (!isInside(canonicalCwd, canonicalTarget)) {
            throw new Error("Checkpoint 目标解析到项目外路径");
        }
        return {
            absolutePath: canonicalTarget,
            relativePath: relative(canonicalCwd, canonicalTarget).split(sep).join("/"),
            mode: info.mode,
            exists: true,
        };
    } catch (error) {
        if (!isErrorCode(error, "ENOENT")) throw error;
        const parent = await nearestExistingParent(resolve(absolutePath, ".."));
        const canonicalParent = await realpath(parent);
        if (
            canonicalParent !== canonicalCwd &&
            !isInside(canonicalCwd, canonicalParent)
        ) {
            throw new Error("Checkpoint 新文件的父目录解析到项目外路径");
        }
        return {
            absolutePath,
            relativePath: lexicalRelative.split(sep).join("/"),
            exists: false,
        };
    }
}

export async function fingerprintFile(path: string): Promise<{
    fingerprint: FileFingerprint;
    content?: Buffer;
}> {
    try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error("不是 regular file");
        }
        if (info.size > MAX_CHECKPOINT_FILE_BYTES) {
            throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} 字节上限`);
        }
        const content = await readFile(path);
        return {
            fingerprint: fingerprintContent(content, info.mode),
            content,
        };
    } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
            return {fingerprint: missingFingerprint()};
        }
        throw error;
    }
}
