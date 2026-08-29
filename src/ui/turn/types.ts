import type {PermissionDecision} from "../../permissions/index.js";

export interface ConfirmReq {
    question: string;
    toolName: string;
    input: unknown;
    allowAddToAllowList?: boolean;
    resolve: (decision: PermissionDecision) => void;
}
