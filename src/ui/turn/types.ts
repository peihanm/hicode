import type {
    PermissionDecision,
    PermissionPromptPresentation,
} from "../../permissions/index.js";

export interface ConfirmReq {
    id: number;
    question: string;
    toolName: string;
    input: unknown;
    allowAddToAllowList?: boolean;
    presentation?: PermissionPromptPresentation;
    resolve: (decision: PermissionDecision) => void;
}
