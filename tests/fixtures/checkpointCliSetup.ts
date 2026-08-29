import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createFileCheckpointRuntime} from "../../src/checkpoints/index.js";
import {saveSessionSnapshot, saveSessionTurnCheckpoint} from "../../src/session/index.js";
import {createFileStateTracker} from "../../src/tools/shared/fileState.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("missing cwd");

const sessionId = `headless-rewind-${process.pid}`;
const path = join(cwd, "headless.txt");
await writeFile(path, "before\n");
const runtime = createFileCheckpointRuntime({
    cwd,
    sessionId,
    enabled: true,
    fileState: createFileStateTracker(),
});
const checkpoint = await runtime.beginTurn({prompt: "修改 headless 文件"});
await saveSessionTurnCheckpoint({
    cwd,
    model: "glm-test",
    sessionId,
    checkpointId: checkpoint!.checkpointId,
    branchId: checkpoint!.branchId,
    prompt: "修改 headless 文件",
    history: [{role: "system", content: "system"}],
    todos: [],
    permissionMode: "default",
});
await runtime.beforeWrite({
    path,
    content: "before\n",
    toolCallId: "headless-write",
});
await writeFile(path, "after\n");
await runtime.afterWrite({
    path,
    content: "after\n",
    toolCallId: "headless-write",
});
await runtime.settleTurn();
await saveSessionSnapshot({
    cwd,
    model: "glm-test",
    sessionId,
    history: [
        {role: "system", content: "system"},
        {role: "user", content: "修改 headless 文件"},
        {role: "assistant", content: "完成"},
    ],
    todos: [],
    permissionMode: "default",
    checkpointHead: runtime.getHead(),
});

console.log(JSON.stringify({
    sessionId,
    checkpointId: checkpoint!.checkpointId,
}));
