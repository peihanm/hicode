import {join} from "node:path";
import type {TaskRuntimeLike} from "../../src/tasks/index.js";
import {TaskJournal} from "../../src/tasks/journal.js";
import {TaskRuntime} from "../../src/tasks/runtime.js";
import {
    BUILTIN_SUBAGENT_REGISTRY,
    type CreateSubagentRunner,
    type SubagentRegistry,
} from "../../src/subagents/index.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {WorktreeRuntime} from "../../src/worktrees/runtime.js";
import {WorktreeManifestStore} from "../../src/worktrees/manifest.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

export function createTaskRuntimeForTest(
    cwd: string,
    shellRunner: ShellRunnerLike,
    createSubagentRunner: CreateSubagentRunner = () => async () => {
        throw new Error("本用例没有配置 Agent Task runner");
    },
    projectsRoot = join(cwd, ".test-task-projects"),
    subagents: SubagentRegistry = BUILTIN_SUBAGENT_REGISTRY
): TaskRuntimeLike {
    const storage = createPillarStorageLayout({projectsRoot});
    return new TaskRuntime(
        shellRunner,
        createSubagentRunner,
        new TaskJournal(storage, cwd),
        new WorktreeRuntime(
            cwd,
            new WorktreeManifestStore(join(projectsRoot, "worktree-manifests"))
        ),
        subagents
    );
}
