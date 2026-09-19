import {writeFile} from "node:fs/promises";
import {InteractiveShutdown, bindInteractiveSignals} from "../../src/cli/interactiveShutdown.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";

const cwd = process.argv[2]!;
const terminalTest = process.argv[3]?.startsWith("terminal") === true;
const resources = createTestRuntimeResources(cwd);
const {rootSession} = createUITurnSessionRuntime(resources);
await rootSession.initialize();
const shutdown = new InteractiveShutdown();
shutdown.register(async () => {
    resources.beginShutdown();
    await new Promise(resolve => setTimeout(resolve, 1200));
    await resources.close();
});
let leave!: () => void;
const exiting = new Promise<void>(resolve => {leave = resolve;});
const removeSignals = bindInteractiveSignals(shutdown, leave);
if (terminalTest) {
    // Simulate a terminal disappearing without its usual hangup signal.
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", () => {});
    if (process.argv[3] === "terminal") process.stdin.resume();
}
const task = await rootSession.taskSession.startShell({command: "echo $$ > child.pid; sleep 30 & echo $! > grandchild.pid; wait", cwd, toolCallId: "fixture"});
process.stdout.write("READY\n");
await exiting;
await shutdown.close();
removeSignals();
const status = (await rootSession.taskSession.get(task.id))?.status;
await writeFile(`${cwd}/closed.json`, JSON.stringify({status, code: process.exitCode}));
if (!terminalTest) process.stdout.write(`CLOSED:${status}\n`);
