import type {TaskRuntimeLike} from "../../src/tasks/index.js";
import {createTaskRuntime} from "../../src/tasks/runtime.js";
import {
    BUILTIN_SUBAGENT_REGISTRY,
    type SubagentRegistry,
} from "../../src/subagents/index.js";
import type {CreateSubagentThread} from "../../src/subagents/types.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";
import {testChildEnvironment} from "./childEnvironment.js";
import {join} from "node:path";

export function createTaskRuntimeForTest(
    cwd: string,
    shellRunner: ShellRunnerLike,
    createSubagentThread: CreateSubagentThread = () => ({
        agentId: "unconfigured",
        async run() {
            throw new Error("本用例没有配置 Agent Task runner");
        },
    }),
    pillarHome = join(cwd, ".test-task-storage"),
    subagents: SubagentRegistry = BUILTIN_SUBAGENT_REGISTRY
): TaskRuntimeLike {
    const storage = createPillarStorageLayout({pillarHome});
    return createTaskRuntime(
        storage,
        cwd,
        testChildEnvironment,
        shellRunner,
        createSubagentThread,
        subagents
    );
}
