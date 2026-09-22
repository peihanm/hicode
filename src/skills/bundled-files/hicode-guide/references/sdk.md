# TypeScript SDK and unattended use

## Entry and packaging

The source repository exports `./sdk`; the SDK packaging task produces a package named `hicode-core-sdk`. Do not assume it has been published to npm. From a checkout, `bun run build:sdk` prepares it and `bun run verify:sdk-package` verifies the built package with Node/Bun consumers. Consult that build's reported output path for local installation.

SDK and CLI share the Agent/tool/session execution framework. The SDK Host owns storage, configuration, approvals and resource lifetime; it does not open the CLI's configuration menus.

## Minimal configuration

After installing the built SDK package in the host application, this example uses an existing provider credential in the host environment. Replace the absolute directories and choose a model available to the account:

```ts
import {HiCode, loadHiCodeHostConfig} from 'hicode-core-sdk';

const {configuration} = loadHiCodeHostConfig({
  cwd: '/absolute/workspace',
  hicodeHome: '/absolute/host-data/hicode',
  workspaceBoundary: '/absolute/workspace',
  fileSources: {
    settings: [], instructions: [], skills: [], agents: [], mcp: [],
  },
  settingsOverrides: {
    models: {primary: {source: 'qwen', model: 'qwen3.8-flash'}},
    memory: {enabled: false},
  },
});

const hicode = await HiCode.create({configuration});
try {
  const thread = await hicode.startThread({collaborationMode: 'plan'});
  const result = await thread.run('Explain the project structure.');
  console.log(result.finalResponse);
  console.log(result.stopReason);
} finally {
  await hicode.close();
}
```

This example makes a real model request if run; it is not an offline verification script. Without an interaction callback, requests that need permission or a user answer are refused, not implicitly approved.

`loadHiCodeHostConfig` does not load `.env` or fall back to the user's actual `~/.hicode`. The host supplies credentials in its environment, with variable names selected by provider configuration. Do not embed keys in the example or pass them through Settings/logs.

## Configuration controls

- `cwd`, `hicodeHome`, and the workspace boundary are absolute paths. Storage remains under the injected home.
- `fileSources` explicitly selects which user/project configuration domains may be read. An empty `skills` file-source list disables user/project Skill files, not product-bundled guidance.
- `settingsOverrides` is strict Host configuration, applied after selected file sources. Unknown fields are rejected; do not import internal modules to evade validation.
- `rootContributions` can provide inline instructions, Skills, Agents and stdio MCP definitions. Host Skill content has no implied local resource directory. Host MCP still needs server approval.
- Root configuration, provider connections and tool capabilities are shared; a Thread owns conversation/session state; every run has a separate signal and interaction lifetime.

Use the same Thread for followup user requests. `startThread()` creates a new conversation; `resumeThread(sessionId)` restores a saved one from the Host's storage. Neither operation restores live background children from another process.

## Handling permissions without a person clicking

The Host may supply `host.onInteraction(request, context)` when creating HiCode. It receives permission requests, user questions, MCP approvals and Hook trust requests. Return an explicit permitted response for that request kind; do not auto-allow every request indiscriminately.

For Turn permissions, ordinary allow/deny applies to the original validated input. A question requires answers keyed to the actual questions; a plain allow is not an answer. Scope modifiers for directory/network grants apply only to those request kinds. The callback cannot rewrite arguments, return invented tool results, or expand the Host hard boundary.

Listen to `context.signal` so cancelled requests close promptly and late approvals have no effect. No callback, an invalid response or callback failure is fail-closed. Preauthorize intended paths/policies in Host configuration where appropriate; use the independent reviewer if explicitly selected. Full Access requires explicit Host opt-in and still cannot bypass hard boundaries or server trust.

Current SDK/headless execution does not allow background Agent tasks. Use supported foreground delegation and do not promise CLI-style background task followup in SDK code.

## Results and cancellation

`thread.run()` returns structured items, finalResponse, usage, stopReason, iterations and duration. Inspect stopReason and tool outcomes; a returned string alone is not proof of successful completion. `thread.runStreamed()` exposes the same operation as an event stream; consume or close it before starting another turn on that Thread.

Per-turn options include `signal`, `permissionMode`, `collaborationMode` and optional `maxIterations` (1–100). Use a new AbortController for each run. Always close the HiCode instance in `finally` to release sessions, MCP connections and processes. Host event/log content can include user data or source code and should not be published without review.
