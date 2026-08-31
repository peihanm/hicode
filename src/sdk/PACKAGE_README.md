# Pillar TypeScript SDK

Pillar exposes its programmatic API through the ESM-only `pillar-core-sdk` package.
It runs the same Agent, ToolRuntime, permission, Hook, checkpoint, and Session
chain as the terminal application.

```ts
import {loadPillarHostConfig, Pillar} from "pillar-core-sdk";

const {configuration} = loadPillarHostConfig({
    cwd: "/absolute/workspace",
    pillarHome: "/absolute/host-data/pillar",
    fileSources: {
        settings: [],
        instructions: [],
        skills: [],
        agents: [],
        mcp: [],
        lsp: [],
    },
});

const pillar = await Pillar.create({configuration});
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
not implicitly load a CLI `.env` or the real user home.
