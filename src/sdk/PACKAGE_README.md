# HiCode TypeScript SDK

HiCode exposes its programmatic API through the ESM-only `hicode-core-sdk` package.
It runs the same Agent, ToolRuntime, permission, Hook and Session
chain as the terminal application.

```ts
import {defineHiCodeTool, loadHiCodeHostConfig, HiCode} from "hicode-core-sdk";
import {z} from "zod";

const {configuration} = loadHiCodeHostConfig({
    cwd: "/absolute/workspace",
    hicodeHome: "/absolute/host-data/hicode",
    fileSources: {
        settings: [],
        instructions: [],
        skills: [],
        agents: [],
        mcp: [],
    },
});

const lookupTicket = defineHiCodeTool({
    name: "lookup_ticket",
    description: "Read one ticket from the Host issue store",
    parameters: z.object({id: z.string()}),
    readOnly: true,
    concurrencySafe: true,
    execute: async ({id}, {signal}) => issueStore.get(id, {signal}),
});

const hicode = await HiCode.create({
    configuration,
    tools: [lookupTicket],
});
try {
    const thread = await hicode.startThread();
    const result = await thread.run("Inspect the project and run its tests.");
    console.log(result.finalResponse);
} finally {
    await hicode.close();
}
```

The published artifact includes ESM JavaScript and a bundled TypeScript
declaration. Supported runtimes are Node.js 22.12 or newer and Bun 1.3 or
newer. The Host must provide absolute workspace and storage paths; the SDK does
not implicitly load a CLI `.env` or the real user home. Host Tools run through
the same schema, permission, Hook, cancellation, and result-budget chain as
built-in Tools. `fileSources` arrays select sources but do not redefine their
canonical precedence. They are Root-only and must not directly modify workspace
files.

## Subagents

The main Agent can delegate through `agent`, coordinate with `agent_message`, and continue a retained child with `agent_followup`. Required reports are collected before normal Turn completion. Streamed `subagent` items identify the `agentId` and current `runCount`, include the actual `taskStatus`, and expose available transcript paths. Queued followups update the active Item; restarting an idle child creates a new Item. An interrupted Item can describe a task that is still running when its Turn stream ends.

Child permission requests use `host.onInteraction` and identify the child in `request.actor`. Root Turn cancellation does not cancel independent child requests; stopping the child or closing the Thread does. Cross-turn followup uses the current Turn's interaction stream. Always close the HiCode instance to clean up owned tasks. Background Shell commands (`run_in_background: true`) return a Task ID and survive normal Turn completion. Later turns can inspect or stop them with `task`; `Thread.close()` cleans up all owned processes. Completed work is delivered on a later run without starting a model request automatically. Live processes are not restored across application restarts. Background Memory maintenance remains separately disabled.
