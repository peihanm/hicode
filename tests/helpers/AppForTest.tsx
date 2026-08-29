import { useMemo } from "react";
import type { LoadedSession } from "../../src/session/index.js";
import type { PermissionMode } from "../../src/permissions/index.js";
import type { RootRuntimeResources } from "../../src/runtime/resources.js";
import { App } from "../../src/ui/App.js";
import type { AgentRunner } from "../../src/agent/index.js";

export function AppForTest({
  resources,
  initialPermissionMode,
  initialSession,
  runAgentImpl,
}: {
  resources: RootRuntimeResources;
  initialPermissionMode?: PermissionMode;
  initialSession?: LoadedSession;
  runAgentImpl: AgentRunner;
}) {
  const testResources = useMemo<RootRuntimeResources>(
    () => ({
      ...resources,
      agentRuntime: {
        ...resources.agentRuntime,
        runAgent: runAgentImpl,
      },
    }),
    [resources, runAgentImpl]
  );
  return (
    <App
      resources={testResources}
      initialPermissionMode={initialPermissionMode}
      initialSession={initialSession}
    />
  );
}
