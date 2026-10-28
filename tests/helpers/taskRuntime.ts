import type {TaskReviewRunner} from "../../src/tasks/review/task.js";
import type {MemoryRuntimeLike} from "../../src/memory/runtime.js";
import {createTestMemoryRuntime} from "./memory.js";
import type {TaskRuntimeLike} from "../../src/tasks/index.js";
import {createTaskRuntime} from "../../src/tasks/runtime.js";
import {type SubagentRegistry} from "../../src/subagents/index.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import type {CreateSubagentThread} from "../../src/subagents/types.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {createHiCodeStorageLayout} from "../../src/persistence/index.js";
import {join} from "node:path";

export function createTaskRuntimeForTest(
    cwd: string,
    shellRunner: ShellRunnerLike,
    createSubagentThread: CreateSubagentThread = () => ({
        agentId: "unconfigured",
        async close() {}, async run() {
            throw new Error("本用例没有配置 Agent Task runner");
        },
    }),
    hicodeHome = join(cwd, ".test-task-storage"),
    subagents: SubagentRegistry = BUILTIN_SUBAGENT_REGISTRY,
    memory:MemoryRuntimeLike = createTestMemoryRuntime(cwd,{enabled:false}),
    reviewTask: TaskReviewRunner = async () => {throw new Error("This fixture does not configure task reviews");}
): TaskRuntimeLike {
    const storage = createHiCodeStorageLayout({hicodeHome});
    return createTaskRuntime(
        storage,
        cwd,
        shellRunner,
        createSubagentThread,
        subagents,
        memory,
        reviewTask
    );
}
