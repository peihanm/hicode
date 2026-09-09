# Pillar TypeScript SDK

Pillar exposes its programmatic API through the ESM-only `pillar-core-sdk` package.
It runs the same Agent, ToolRuntime, permission, Hook and Session
chain as the terminal application.

```ts
import {definePillarTool, loadPillarHostConfig, Pillar} from "pillar-core-sdk";
import {z} from "zod";

const {configuration} = loadPillarHostConfig({
    cwd: "/absolute/workspace",
    pillarHome: "/absolute/host-data/pillar",
    fileSources: {
        settings: [],
        instructions: [],
        skills: [],
        agents: [],
        mcp: [],
    },
});

const lookupTicket = definePillarTool({
    name: "lookup_ticket",
    description: "Read one ticket from the Host issue store",
    parameters: z.object({id: z.string()}),
    readOnly: true,
    concurrencySafe: true,
    execute: async ({id}, {signal}) => issueStore.get(id, {signal}),
});

const pillar = await Pillar.create({
    configuration,
    tools: [lookupTicket],
});
try {
    const thread = await pillar.startThread();
    const result = await thread.run("Inspect the project and run its tests.");
    console.log(result.finalResponse);
} finally {
    await pillar.close();
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
