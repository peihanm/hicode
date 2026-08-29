import {homedir} from "node:os";
import {join} from "node:path";
import {getProjectKey, hashProjectValue} from "./project.js";

export function getPillarHome(): string {
    return join(homedir(), ".pillar");
}

export function getProjectsRoot(): string {
    return join(getPillarHome(), "projects");
}

export function getProjectStorageDirectory(
    cwd: string,
    projectsRoot = getProjectsRoot()
): string {
    return join(projectsRoot, getProjectKey(cwd));
}

export function getSessionStorageDirectory(
    cwd: string,
    sessionId: string,
    projectsRoot = getProjectsRoot()
): string {
    return join(
        getProjectStorageDirectory(cwd, projectsRoot),
        `session-${hashProjectValue(sessionId, 24)}`
    );
}
