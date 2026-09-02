// permissions 模块的统一出口
// 方便其他文件 import：from "../permissions/index.js"

export type {
    PermissionResult,
    PermissionDecision,
    PermissionMode,
    PermissionPromptPolicy,
    PermissionRules,
} from "./types.js";

export {matchPattern} from "./matchPattern.js";
export {
    matchesToolPermissionRule,
    resolvePermission,
} from "./resolvePermission.js";
export {generateRuleForTool, addToAllowList} from "./addRule.js";
export {
    getPermissionModeDescription,
    getPermissionModeShortLabel,
    isPermissionMode,
    parsePermissionMode,
} from "./mode.js";
