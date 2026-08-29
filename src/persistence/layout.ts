import {homedir} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import {getProjectKey, hashProjectValue} from "./project.js";

export interface PillarStorageLayout {
    readonly pillarHome: string;
    readonly projectsRoot: string;
}

export interface CreatePillarStorageLayoutOptions {
    pillarHome?: string;
    projectsRoot?: string;
}

/**
 * Resolve the host-owned data root once at the composition boundary.
 * Domain stores receive this immutable layout instead of reading HOME.
 */
export function createPillarStorageLayout(
    options: CreatePillarStorageLayoutOptions = {}
): PillarStorageLayout {
    if (options.pillarHome && options.projectsRoot) {
        throw new Error("Pillar storage accepts pillarHome or projectsRoot, not both");
    }
    const requestedHome = options.pillarHome ?? join(homedir(), ".pillar");
    const requestedProjectsRoot =
        options.projectsRoot ?? join(requestedHome, "projects");
    if (!isAbsolute(requestedHome) || !isAbsolute(requestedProjectsRoot)) {
        throw new Error("Pillar storage paths must be absolute");
    }
    const pillarHome = resolve(requestedHome);
    const projectsRoot = resolve(requestedProjectsRoot);
    return Object.freeze({
        pillarHome,
        projectsRoot,
    });
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
