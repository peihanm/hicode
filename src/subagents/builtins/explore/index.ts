import type {SubagentRegistration} from "../../registration.js";
import {EXPLORE_AGENT} from "./definition.js";

export const EXPLORE_SUBAGENT: SubagentRegistration = {
    definition: EXPLORE_AGENT,
    concurrencySafe: true,
    createRuntimeConfig(parentContext) {
        return {
            toolRuntimeOptions: {
                allowedToolNames: EXPLORE_AGENT.allowedTools,
            },
            contextResources: {
                storage: parentContext.storage,
                cwd: parentContext.cwd,
                workspaceBoundary:
                    parentContext.workspaceBoundary ?? parentContext.cwd,
                skills: [],
                lspManager: parentContext.lspManager,
                shellRunner: parentContext.shellRunner,
            },
            permissionRules: {
                allow: [],
                ask: [...parentContext.permissionRules.ask],
                deny: [...parentContext.permissionRules.deny],
            },
            permissionMode: "dontAsk",
        };
    },
};
