import {resolve} from "node:path";
import type {ToolResultStore} from "../toolResults/index.js";
import type {ShellTaskSnapshot, TaskSessionLike, TaskSnapshot} from "./types.js";

/** A child can manage only Shell tasks it created. Root retains resource ownership. */
export type ChildTaskAccess = Pick<TaskSessionLike, "sessionId" | "startShell" | "get" | "list" | "stop">;

export function isParentTaskSession(tasks: TaskSessionLike | ChildTaskAccess): tasks is TaskSessionLike {
    return "startAgent" in tasks;
}

export function createChildTaskAccess(parent: ChildTaskAccess, files: Pick<ToolResultStore, "resolveFile">): {tasks: ChildTaskAccess; files: Pick<ToolResultStore, "resolveFile">} {
    const owned = new Set<string>();
    const isOwned = (task: TaskSnapshot): task is ShellTaskSnapshot => task.kind === "shell" && owned.has(task.id);
    const tasks: ChildTaskAccess = {
        sessionId: parent.sessionId,
        async startShell(input) {
            const task = await parent.startShell(input);
            owned.add(task.id);
            return task;
        },
        async get(id) {
            if (!owned.has(id)) return undefined;
            const task = await parent.get(id);
            return task && isOwned(task) ? task : undefined;
        },
        async list() {return (await parent.list()).filter(isOwned);},
        async stop(id) {
            if (!owned.has(id)) return undefined;
            return parent.stop(id);
        },
    };
    return {tasks, files: {async resolveFile(path) {
        const allowed = (await tasks.list()).some(task => task.kind === "shell" && task.outputResult && resolve(task.outputResult.path) === resolve(path));
        return allowed ? files.resolveFile(path) : null;
    }}};
}
