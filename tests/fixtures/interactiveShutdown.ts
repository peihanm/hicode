import {InteractiveShutdown, bindInteractiveSignals} from "../../src/cli/interactiveShutdown.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";

const cwd = process.argv[2]!;
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
const task = await rootSession.taskSession.startShell({command: "echo $$ > child.pid; sleep 30", cwd, toolCallId: "fixture"});
process.stdout.write("READY\n");
await exiting;
await shutdown.close();
removeSignals();
process.stdout.write(`CLOSED:${(await rootSession.taskSession.get(task.id))?.status}\n`);
