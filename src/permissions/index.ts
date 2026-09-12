// Public permissions entry point.
// Other modules import from ../permissions/index.js.

export type {
    PermissionResult,
    PermissionDecision,
    PermissionMode,
    PermissionPromptPolicy,
    PermissionPromptPresentation,
    PermissionRules,
} from "./types.js";

export {matchPattern} from "./matchPattern.js";
export {
    matchesToolPermissionRule,
    resolvePermission,
} from "./resolvePermission.js";
export {generateRuleForTool, addToAllowList} from "./addRule.js";
export {
    createDirectoryAccessRuntime,
    directoryOperationForTool,
} from "./directoryAccess.js";
export type {
    DirectoryAccessRequest,
    DirectoryAccessRuntimeLike,
    DirectoryGrantScope,
} from "./directoryAccess.js";
export {
    getPermissionModeDescription,
    getPermissionModeShortLabel,
    isPermissionMode,
    parsePermissionMode,
} from "./mode.js";
