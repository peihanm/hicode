import {lstat, realpath} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {isPathInside, resolveFilePermissionPath} from "./pathGuard.js";
import type {ApprovalResolution} from "./approval.js";

export type DirectoryGrantScope = "session" | "project";

export interface DirectoryAccessRequest {
    operation: "write" | "edit" | "delete" | "write_directory";
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
    subscribe(listener: () => void): () => void;
}

interface CreateDirectoryAccessRuntimeOptions {
    cwd: string;
    hardBoundary: string;
    initialDirectories?: readonly string[];
    persistDirectory?: (directory: string) => Promise<void>;
    allowGrants?: boolean;
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

export function createDirectoryAccessRuntime(
    options: CreateDirectoryAccessRuntimeOptions
): DirectoryAccessRuntimeLike {
    const cwd = resolve(options.cwd);
    let hardBoundary = resolve(options.hardBoundary);
    const directories = new Set<string>([cwd]);
    const listeners = new Set<() => void>();
    const initialDirectories = options.initialDirectories ?? [];
    const allowGrants = options.allowGrants ?? true;
    let initialized = false;

    const validateWithinBoundary = async (path: string): Promise<string> => {
        const candidate = await resolveFilePermissionPath(cwd, path);
        if (!isPathInside(hardBoundary, candidate)) {
            throw new Error(`Path crosses the Host boundary: ${path}`);
        }
        return candidate;
    };

    const normalizeDirectory = async (path: string): Promise<string> => {
        const candidate = resolve(cwd, path);
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
            const candidate = await resolveFilePermissionPath(cwd, path);
            if (!isPathInside(hardBoundary, candidate)) return false;
            for (const directory of directories) {
                if (isPathInside(directory, candidate)) return true;
            }
            return false;
        },
        async createRequest(path, operation) {
            await this.initialize();
            const targetPath = await validateWithinBoundary(path);
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
            for (const listener of listeners) listener();
            return normalized;
        },
        listDirectories() {
            return [...directories];
        },
        subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    };
}

/** Only a user decision can expand the directory owner's reusable grants. */
export async function commitDirectoryApproval(
    directoryAccess: DirectoryAccessRuntimeLike,
    request: DirectoryAccessRequest,
    resolution: ApprovalResolution
): Promise<void> {
    const decision = resolution.decision;
    if (decision.behavior !== "allow" || !decision.directoryScope || decision.directoryScope === "once") return;
    if (resolution.source !== "user") throw new Error("Only an explicit user decision can expand directory access");
    await directoryAccess.grantDirectory(request.suggestedDirectory, decision.directoryScope);
}

export function directoryOperationForTool(
    toolName: string
): DirectoryAccessRequest["operation"] | undefined {
    if (toolName === "write_file") return "write";
    if (toolName === "edit_file") return "edit";
    return undefined;
}
