import { useMemo } from "react";
import type { LoadedSession } from "../../src/session/index.js";
import type { PermissionMode } from "../../src/permissions/index.js";
import type { RootRuntimeResources } from "../../src/runtime/resources.js";
import { App } from "../../src/ui/App.js";
import type { AgentRunner } from "../../src/agent/index.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";

export function AppForTest({
  resources,
  initialPermissionMode,
  initialSession,
  runAgentImpl,
  requestSessionSwitch,
}: {
  resources: RootRuntimeResources;
  initialPermissionMode?: PermissionMode;
  initialSession?: LoadedSession;
  runAgentImpl?: AgentRunner;
  requestSessionSwitch?: (sessionId: string) => Promise<void>;
}) {
  const testResources = useMemo<RootRuntimeResources>(
    () => {
      const configured = {
        ...resources,
        agentRuntime: {
          ...resources.agentRuntime,
          runAgent: runAgentImpl ?? resources.agentRuntime.runAgent,
        },
      };
      Object.defineProperties(configured, {
        model: {get: () => resources.model, enumerable: true},
        provider: {get: () => resources.provider, enumerable: true},
      });
      return configured;
    },
    [resources, runAgentImpl]
  );
  const turnSession = useMemo(
    () => createUITurnSessionRuntime(testResources, initialSession),
    [initialSession, testResources]
  );
  return (
    <App
      resources={testResources}
      rootSession={turnSession.rootSession}
      resumedDraft={turnSession.resumedDraft}
      initialPermissionMode={initialPermissionMode}
      initialSession={initialSession}
      requestSessionSwitch={requestSessionSwitch}
    />
  );
}
