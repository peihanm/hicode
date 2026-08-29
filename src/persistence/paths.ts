import {createPillarStorageLayout} from "./layout.js";

export function getPillarHome(): string {
    return createPillarStorageLayout().pillarHome;
}

export function getProjectsRoot(): string {
    return createPillarStorageLayout().projectsRoot;
}
