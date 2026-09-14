import {homedir} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import {getProjectKey, hashProjectValue} from "./project.js";

export interface PillarStorageLayout {
    readonly pillarHome: string;
    readonly projectsRoot: string;
}

export interface CreatePillarStorageLayoutOptions {
    pillarHome?: string;
}

/**
 * Resolve the host-owned data root once at the composition boundary.
 * Domain stores receive this immutable layout instead of reading HOME.
 */
export function createPillarStorageLayout(
    options: CreatePillarStorageLayoutOptions = {}
): PillarStorageLayout {
    const requestedHome = options.pillarHome ?? join(homedir(), ".pillar");
    if (!isAbsolute(requestedHome)) {
        throw new Error("Pillar storage paths must be absolute");
    }
    const pillarHome = resolve(requestedHome);
    return Object.freeze({
        pillarHome,
        projectsRoot: join(pillarHome, "projects"),
    });
}

/** Validate a structurally supplied SDK/Host layout at the Root boundary. */
export function normalizePillarStorageLayout(
    storage: PillarStorageLayout
): PillarStorageLayout {
    if (!storage || typeof storage !== "object") {
        throw new Error("Pillar storage layout must be an object");
    }
    const pillarHome = requireAbsoluteStoragePath(
        storage.pillarHome,
        "pillarHome"
    );
    const projectsRoot = requireAbsoluteStoragePath(
        storage.projectsRoot,
        "projectsRoot"
    );
    const expectedProjectsRoot = join(pillarHome, "projects");
    if (projectsRoot !== expectedProjectsRoot) {
        throw new Error("Pillar projectsRoot must be derived solely from pillarHome");
    }
    return Object.freeze({pillarHome, projectsRoot});
}

function requireAbsoluteStoragePath(value: string, name: string): string {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
        throw new Error(`Pillar storage ${name} must be a non-empty absolute path`);
    }
    return resolve(value.trim());
}

export function getProjectStorageDirectory(
    storage: PillarStorageLayout,
    cwd: string
): string {
    if (!isAbsolute(storage.projectsRoot)) {
        throw new Error("Pillar projects root must be an absolute path");
    }
    return join(storage.projectsRoot, getProjectKey(cwd));
}

export function getProjectSessionsDirectory(
    storage: PillarStorageLayout,
    cwd: string
): string {
    return join(getProjectStorageDirectory(storage, cwd), "sessions");
}

export function getSessionStorageDirectory(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(
        getProjectSessionsDirectory(storage, cwd),
        `session-${hashProjectValue(sessionId, 24)}`
    );
}

export function getProjectDebugDirectory(
    storage: PillarStorageLayout,
    cwd: string
): string {
    return join(getProjectStorageDirectory(storage, cwd), "debug");
}

export function getSessionContentDirectory(storage: PillarStorageLayout, cwd: string, sessionId: string): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "content");
}

export function getSessionArchiveDirectory(storage: PillarStorageLayout, cwd: string, sessionId: string): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "archives");
}

/** Rebuildable package cache, separate from Session data. */
export function getProjectBunCacheDirectory(storage: PillarStorageLayout, cwd: string): string {
    return join(getProjectStorageDirectory(storage, cwd), "cache", "bun");
}

export function getProjectNpmCacheDirectory(storage: PillarStorageLayout, cwd: string): string {
    return join(getProjectStorageDirectory(storage, cwd), "cache", "npm");
}

export function getHookTrustPath(storage: PillarStorageLayout): string {
    return join(storage.pillarHome, "trusted-projects.json");
}

export function getProjectMemoryDirectory(storage: PillarStorageLayout, cwd: string): string {
    return join(getProjectStorageDirectory(storage, cwd), "memory");
}

export function getMemoryPublicationPath(directory: string): string {
    return join(directory, "publication.json");
}

export function getMemoryViewsDirectory(directory: string): string {
    return join(directory, "views");
}

export function getMemoryInboxDirectory(directory: string): string {
    return join(directory, "inbox");
}

export function getMemoryWorkspacesDirectory(directory: string): string {
    return join(directory, "workspaces");
}

export function getMemoryWorkspacePaths(directory: string, leaseId: string): {root: string; draft: string; runtime: string} {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(leaseId)) throw new Error("Invalid Memory workspace ID");
    const root = join(getMemoryWorkspacesDirectory(directory), leaseId);
    return {root, draft: join(root, "draft"), runtime: join(root, "runtime")};
}

export function getSessionInputHistoryPath(storage: PillarStorageLayout, cwd: string, sessionId: string): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "input-history.jsonl");
}

export function getSessionIndexRecoveryDirectory(storage: PillarStorageLayout, cwd: string): string {
    return join(getProjectSessionsDirectory(storage, cwd), "index-recovery");
}

export function getPromptLogDirectory(storage: PillarStorageLayout, cwd: string, sessionId?: string): string {
    return join(sessionId ? getSessionStorageDirectory(storage,cwd,sessionId) : getProjectStorageDirectory(storage,cwd), "debug", "requests");
}

export function getSubagentStorageDirectory(storage: PillarStorageLayout, cwd: string, sessionId: string, agentId: string): string {
    return join(getSessionStorageDirectory(storage,cwd,sessionId), "subagents", hashProjectValue(agentId,32));
}

export function getProjectIdentityPath(storage:PillarStorageLayout,cwd:string):string {return join(getProjectStorageDirectory(storage,cwd),"project.json");}
export function getProjectActivityDirectory(storage:PillarStorageLayout,cwd:string):string {return join(getProjectStorageDirectory(storage,cwd),"activity");}
export function getProjectMaintenanceLockPath(storage:PillarStorageLayout,cwd:string):string {return join(getProjectStorageDirectory(storage,cwd),".maintenance.lock");}
export function getSessionIdentityPath(storage:PillarStorageLayout,cwd:string,sessionId:string):string {return join(getSessionStorageDirectory(storage,cwd,sessionId),"identity.json");}

export function getUserSettingsPath(storage: PillarStorageLayout): string {
    return join(storage.pillarHome, "settings.json");
}

export function getUserCredentialsPath(storage: PillarStorageLayout): string {
    return join(storage.pillarHome, ".env");
}
