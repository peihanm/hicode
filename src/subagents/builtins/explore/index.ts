import type {SubagentRegistration} from "../../registration.js";
import {EXPLORE_AGENT} from "./definition.js";

export const EXPLORE_SUBAGENT: SubagentRegistration = {
    definition: EXPLORE_AGENT,
    concurrencySafe: true,
    createRuntimeConfig(parentContext) {
        return {
            contextResources: {
                    toolNames: parentContext.toolNames, availableTools: parentContext.availableTools,
                readOnlyTools: true,
                storage: parentContext.storage,
                cwd: parentContext.cwd,
                workspaceBoundary:
                    parentContext.workspaceBoundary ?? parentContext.cwd,
                skills: [],
                shellRunner: parentContext.shellRunner,
            },
            permissionRules: {
                allow: [],
                ask: [...parentContext.permissionRules.ask],
                deny: [...parentContext.permissionRules.deny],
            },
            permissionMode: "ask",
            collaborationMode: parentContext.collaborationMode,
            permissionPromptPolicy: "never",
        };
    },
};
