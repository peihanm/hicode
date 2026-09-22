import {homedir} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import {getProjectKey, hashProjectValue} from "./project.js";

export interface HiCodeStorageLayout {
    readonly hicodeHome: string;
    readonly projectsRoot: string;
}

export interface CreateHiCodeStorageLayoutOptions {
    hicodeHome?: string;
}

/**
 * Resolve the host-owned data root once at the composition boundary.
 * Domain stores receive this immutable layout instead of reading HOME.
 */
export function createHiCodeStorageLayout(
    options: CreateHiCodeStorageLayoutOptions = {}
): HiCodeStorageLayout {
    const requestedHome = options.hicodeHome ?? join(homedir(), ".hicode");
    if (!isAbsolute(requestedHome)) {
        throw new Error("HiCode storage paths must be absolute");
    }
    const hicodeHome = resolve(requestedHome);
    return Object.freeze({
        hicodeHome,
        projectsRoot: join(hicodeHome, "projects"),
    });
}

/** Validate a structurally supplied SDK/Host layout at the Root boundary. */
export function normalizeHiCodeStorageLayout(
    storage: HiCodeStorageLayout
): HiCodeStorageLayout {
    if (!storage || typeof storage !== "object") {
        throw new Error("HiCode storage layout must be an object");
    }
    const hicodeHome = requireAbsoluteStoragePath(
        storage.hicodeHome,
        "hicodeHome"
    );
    const projectsRoot = requireAbsoluteStoragePath(
        storage.projectsRoot,
        "projectsRoot"
    );
    const expectedProjectsRoot = join(hicodeHome, "projects");
    if (projectsRoot !== expectedProjectsRoot) {
        throw new Error("HiCode projectsRoot must be derived solely from hicodeHome");
    }
    return Object.freeze({hicodeHome, projectsRoot});
}

function requireAbsoluteStoragePath(value: string, name: string): string {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
        throw new Error(`HiCode storage ${name} must be a non-empty absolute path`);
    }
    return resolve(value.trim());
}

export function getProjectStorageDirectory(
    storage: HiCodeStorageLayout,
    cwd: string
): string {
    if (!isAbsolute(storage.projectsRoot)) {
        throw new Error("HiCode projects root must be an absolute path");
    }
    return join(storage.projectsRoot, getProjectKey(cwd));
}

export function getProjectSessionsDirectory(
    storage: HiCodeStorageLayout,
    cwd: string
): string {
    return join(getProjectStorageDirectory(storage, cwd), "sessions");
}

export function getSessionStorageDirectory(
    storage: HiCodeStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(
        getProjectSessionsDirectory(storage, cwd),
        `session-${hashProjectValue(sessionId, 24)}`
    );
}

export function getProjectDebugDirectory(
    storage: HiCodeStorageLayout,
    cwd: string
): string {
    return join(getProjectStorageDirectory(storage, cwd), "debug");
}

export function getSessionContentDirectory(storage: HiCodeStorageLayout, cwd: string, sessionId: string): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "content");
}

export function getSessionArchiveDirectory(storage: HiCodeStorageLayout, cwd: string, sessionId: string): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "archives");
}

/** Rebuildable package cache, separate from Session data. */
export function getProjectBunCacheDirectory(storage: HiCodeStorageLayout, cwd: string): string {
    return join(getProjectStorageDirectory(storage, cwd), "cache", "bun");
}

export function getProjectNpmCacheDirectory(storage: HiCodeStorageLayout, cwd: string): string {
    return join(getProjectStorageDirectory(storage, cwd), "cache", "npm");
}

export function getHookTrustPath(storage: HiCodeStorageLayout): string {
    return join(storage.hicodeHome, "trusted-projects.json");
}

export function getProjectMemoryDirectory(storage: HiCodeStorageLayout, cwd: string): string {
    return join(getProjectStorageDirectory(storage, cwd), "memory");
}

export function getMemoryStatePath(directory: string): string {
    return join(directory, "state.json");
}

export function getMemoryIndexPath(directory: string): string {
    return join(directory, "MEMORY.md");
}

export function getMemoryTopicsDirectory(directory: string): string {
    return join(directory, "topics");
}

export function getMemoryWorkspacesDirectory(directory: string): string {
    return join(directory, "workspaces");
}

export function getMemoryWorkspacePaths(directory: string, leaseId: string): {root: string; draft: string; runtime: string} {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(leaseId)) throw new Error("Invalid Memory workspace ID");
    const root = join(getMemoryWorkspacesDirectory(directory), leaseId);
    return {root, draft: join(root, "draft"), runtime: join(root, "runtime")};
}

export function getSessionInputHistoryPath(storage: HiCodeStorageLayout, cwd: string, sessionId: string): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "input-history.jsonl");
}

export function getSessionIndexRecoveryDirectory(storage: HiCodeStorageLayout, cwd: string): string {
    return join(getProjectSessionsDirectory(storage, cwd), "index-recovery");
}

export function getPromptLogDirectory(storage: HiCodeStorageLayout, cwd: string, sessionId?: string): string {
    return join(sessionId ? getSessionStorageDirectory(storage,cwd,sessionId) : getProjectStorageDirectory(storage,cwd), "debug", "requests");
}

export function getSubagentStorageDirectory(storage: HiCodeStorageLayout, cwd: string, sessionId: string, agentId: string): string {
    return join(getSessionStorageDirectory(storage,cwd,sessionId), "subagents", hashProjectValue(agentId,32));
}

export function getProjectIdentityPath(storage:HiCodeStorageLayout,cwd:string):string {return join(getProjectStorageDirectory(storage,cwd),"project.json");}
export function getProjectActivityDirectory(storage:HiCodeStorageLayout,cwd:string):string {return join(getProjectStorageDirectory(storage,cwd),"activity");}
export function getProjectMaintenanceLockPath(storage:HiCodeStorageLayout,cwd:string):string {return join(getProjectStorageDirectory(storage,cwd),".maintenance.lock");}
export function getSessionIdentityPath(storage:HiCodeStorageLayout,cwd:string,sessionId:string):string {return join(getSessionStorageDirectory(storage,cwd,sessionId),"identity.json");}

export function getUserSettingsPath(storage: HiCodeStorageLayout): string {
    return join(storage.hicodeHome, "settings.json");
}

export function getUserCredentialsPath(storage: HiCodeStorageLayout): string {
    return join(storage.hicodeHome, ".env");
}
