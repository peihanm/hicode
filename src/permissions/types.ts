// 权限系统类型定义
// 参考 claude-code src/types/permissions.ts:240-266

// 权限意向：工具通过 checkPermissions 声明自己需要什么级别的权限
// executeTool 拿到意向后决定是否弹窗、是否直接执行、是否拒绝
import type {DirectoryAccessRequest, DirectoryGrantScope} from "./directoryAccess.js";

export type PermissionPromptPresentation =
    | {
        kind: "network_access";
        host: string;
        port: number;
    }
    | {
        kind: "host_execution";
        reason: string;
        command: string;
    }
    | ({kind: "filesystem_access"} & DirectoryAccessRequest);

export type PermissionResult =
    | { behavior: "allow" } // 放行，不问用户
    | { behavior: "deny"; message: string } // 拒绝，不执行
    | {
        behavior: "ask";
        message: string;
        allowPersistent?: boolean;
        presentation?: PermissionPromptPresentation;
    } // 需要问用户
    | { behavior: "passthrough" }; // 交给默认规则（根据 isReadOnly 决定）

// 权限决策：canUseTool 的返回值（用户裁决的结果）
// 当工具 checkPermissions 返回 ask 时，由调用方弹窗让用户决定
// updatedInput：UI 可以把用户的额外输入注入回来（如 askUser 的答案）
//   参考 claude-code：AskUserQuestion 的答案通过 PermissionDecision.updatedInput 回流
export type PermissionDecision =
    | {
        behavior: "allow";
        updatedInput?: unknown;
        directoryScope?: "once" | DirectoryGrantScope;
        networkScope?: "once" | "session";
    } // 用户同意（可携带修改后的 input）
    | { behavior: "deny"; message: string }; // 用户拒绝

// ─── 配置规则相关类型 ───

// PermissionMode：顶层模式开关
// 参考 claude-code src/types/permissions.ts:16-38
export type PermissionMode =
    | "default" // 已验证的工作区/Sandbox 副作用自动放行，其余按规则确认
    | "readOnly" // 只读自动放行，写操作需要确认
    | "bypassPermissions"; // 高权限模式（仍不绕过 deny/ask 和用户交互）

// Host 是否能够处理权限交互。never 只把 ask 收窄为 deny，不扩大权限。
export type PermissionPromptPolicy = "onRequest" | "never";

// 权限规则来源
type PermissionRuleSource = "user" | "project" | "local" | "host";

// 单条权限规则
// 参考 claude-code src/types/permissions.ts:67-79
export interface PermissionRule {
    toolName: string;
    content?: string; // undefined = 整工具匹配；有值 = 按参数模式匹配
    source: PermissionRuleSource;
}

// 规则集合（按 behavior 分桶）
export interface PermissionRules {
    allow: PermissionRule[];
    ask: PermissionRule[];
    deny: PermissionRule[];
}
