import { useMemo } from "react";
import type { LoadedSession } from "../../src/session/index.js";
import type { PermissionMode } from "../../src/permissions/index.js";
import type {CollaborationMode} from "../../src/collaboration/index.js";
import type { RootRuntimeResources } from "../../src/runtime/resources.js";
import { App } from "../../src/ui/App.js";
import type { AgentRunner } from "../../src/agent/index.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";
import {TerminalSizeProvider} from "../../src/ui/terminalSize.js";

export function AppForTest({
  resources,
  initialPermissionMode,
  initialCollaborationMode,
  initialSession,
  runAgentImpl,
  requestSessionSwitch,
}: {
  resources: RootRuntimeResources;
  initialPermissionMode?: PermissionMode;
  initialCollaborationMode?: CollaborationMode;
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
        fastModel: {get: () => resources.fastModel, enumerable: true},
        fastProvider: {get: () => resources.fastProvider, enumerable: true},
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
    <TerminalSizeProvider>
      <App
        resources={testResources}
        rootSession={turnSession.rootSession}
        resumedDraft={turnSession.resumedDraft}
        initialPermissionMode={initialPermissionMode}
        initialCollaborationMode={initialCollaborationMode}
        initialSession={initialSession}
        requestSessionSwitch={requestSessionSwitch}
      />
    </TerminalSizeProvider>
  );
}
