import {lstat, realpath} from "node:fs/promises";
import {dirname, isAbsolute, relative, resolve} from "node:path";
import {isPathInside} from "./pathGuard.js";

export type DirectoryGrantScope = "session" | "project";

export interface DirectoryAccessRequest {
    operation: "write" | "edit" | "delete";
    targetPath: string;
    suggestedDirectory: string;
}

export interface DirectoryAccessRuntimeLike {
    readonly hardBoundary: string;

    initialize(): Promise<void>;

    canAccess(path: string): Promise<boolean>;

    createRequest(
        path: string,
        operation: DirectoryAccessRequest["operation"]
    ): Promise<DirectoryAccessRequest>;

    grantDirectory(directory: string, scope: DirectoryGrantScope): Promise<string>;

    listDirectories(): readonly string[];
}

interface CreateDirectoryAccessRuntimeOptions {
    cwd: string;
    hardBoundary: string;
    initialDirectories?: readonly string[];
    persistDirectory?: (directory: string) => Promise<void>;
    allowGrants?: boolean;
}

function absolutePath(cwd: string, path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

async function requireDirectory(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Authorization target is not a regular directory: ${path}`);
    }
    return realpath(path);
}

async function nearestExistingDirectory(path: string): Promise<string> {
    let candidate = path;
    while (true) {
        try {
            return await requireDirectory(candidate);
        } catch (error) {
            if (
                !error ||
                typeof error !== "object" ||
                !("code" in error) ||
                (error as {code?: string}).code !== "ENOENT"
            ) {
                throw error;
            }
        }
        const parent = dirname(candidate);
        if (parent === candidate) {
            throw new Error(`Cannot find a parent directory to authorize: ${path}`);
        }
        candidate = parent;
    }
}

async function canonicalTarget(path: string): Promise<string> {
    let existing = path;
    while (true) {
        try {
            await lstat(existing);
            break;
        } catch (error) {
            if (
                !error ||
                typeof error !== "object" ||
                !("code" in error) ||
                (error as {code?: string}).code !== "ENOENT"
            ) {
                throw error;
            }
        }
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
    }
    const canonicalExisting = await realpath(existing);
    return resolve(canonicalExisting, relative(existing, path));
}

export function createDirectoryAccessRuntime(
    options: CreateDirectoryAccessRuntimeOptions
): DirectoryAccessRuntimeLike {
    const cwd = resolve(options.cwd);
    let hardBoundary = resolve(options.hardBoundary);
    const directories = new Set<string>([cwd]);
    const initialDirectories = options.initialDirectories ?? [];
    const allowGrants = options.allowGrants ?? true;
    let initialized = false;

    const validateWithinBoundary = async (path: string): Promise<string> => {
        const candidate = await canonicalTarget(absolutePath(cwd, path));
        if (!isPathInside(hardBoundary, candidate)) {
            throw new Error(`Path crosses the Host boundary: ${path}`);
        }
        return candidate;
    };

    const normalizeDirectory = async (path: string): Promise<string> => {
        const candidate = absolutePath(cwd, path);
        const normalized = await requireDirectory(candidate);
        if (!isPathInside(hardBoundary, normalized)) {
            throw new Error(`Path crosses the Host boundary: ${path}`);
        }
        return normalized;
    };

    return {
        get hardBoundary() {
            return hardBoundary;
        },
        async initialize() {
            if (initialized) return;
            hardBoundary = await realpath(hardBoundary);
            const normalizedCwd = await normalizeDirectory(cwd);
            directories.clear();
            directories.add(normalizedCwd);
            for (const configured of initialDirectories) {
                directories.add(await normalizeDirectory(configured));
            }
            initialized = true;
        },
        async canAccess(path) {
            await this.initialize();
            const candidate = await canonicalTarget(absolutePath(cwd, path));
            if (!isPathInside(hardBoundary, candidate)) return false;
            for (const directory of directories) {
                if (isPathInside(directory, candidate)) return true;
            }
            return false;
        },
        async createRequest(path, operation) {
            await this.initialize();
            const targetPath = await validateWithinBoundary(
                absolutePath(cwd, path)
            );
            const suggestedDirectory = await nearestExistingDirectory(
                dirname(targetPath)
            );
            return {operation, targetPath, suggestedDirectory};
        },
        async grantDirectory(directory, scope) {
            if (!allowGrants) {
                throw new Error("This Runtime cannot expand directory access");
            }
            await this.initialize();
            const normalized = await normalizeDirectory(directory);
            if (scope === "project") {
                if (!options.persistDirectory) {
                    throw new Error("This Host does not support persistent directory grants");
                }
                await options.persistDirectory(normalized);
            }
            directories.add(normalized);
            return normalized;
        },
        listDirectories() {
            return [...directories];
        },
    };
}

export function directoryOperationForTool(
    toolName: string
): DirectoryAccessRequest["operation"] | undefined {
    if (toolName === "write_file") return "write";
    if (toolName === "edit_file") return "edit";
    return undefined;
}
