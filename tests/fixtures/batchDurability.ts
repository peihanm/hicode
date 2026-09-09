import {createTestStorage} from "../helpers/tempProject.js";
import {continuityFixture, continuityHost, continuityState} from "../helpers/continuity.js";
import {assistantToolCall} from "../helpers/fakeLLM.js";
import {runRootTurn} from "../../src/runtime/turnRuntime.js";
const cwd = process.argv[2]!;
const mode = process.argv[3]!;
if (!cwd || !["batch", "half"].includes(mode)) throw new Error("expected fixture arguments");
let calls = 0;
const f = continuityFixture(cwd, createTestStorage(cwd), async () => {
    if (++calls === 1) return assistantToolCall("write_file", {path: "written.txt", content: "side effect"}, "write");
    process.stdout.write("BATCH_SAVED\n");
    await new Promise<void>(() => {});
    throw new Error("unreachable");
});
if (mode === "half") {
    const execute = f.resources.toolRuntime.executeTool;
    f.resources.toolRuntime.executeTool = async (...args) => {
        const result = await execute(...args);
        process.stdout.write("HALF_EXECUTED\n");
        await new Promise<void>(() => {});
        return result;
    };
}
await runRootTurn({resources: f.resources, session: f.session, prompt: "write", signal: new AbortController().signal,
    host: continuityHost, onEvent() {}, onHookResult() {}, onLifecycleIssue() {}, getSnapshotState: continuityState});
