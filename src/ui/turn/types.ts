import type {
    PermissionDecision,
    PermissionPromptPresentation,
} from "../../permissions/index.js";

export interface ConfirmReq {
    question: string;
    toolName: string;
    input: unknown;
    allowAddToAllowList?: boolean;
    presentation?: PermissionPromptPresentation;
    resolve: (decision: PermissionDecision) => void;
}
