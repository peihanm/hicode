import type {PermissionMode} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {ResumeMode} from "../session/index.js";
import type {HiCodeRootConfiguration} from "../runtime/rootConfiguration.js";

export type HeadlessOutputFormat = "text" | "json";

export interface HeadlessOptions {
    configuration: HiCodeRootConfiguration;
    prompt: string;
    images?: readonly string[];
    permissionMode?: PermissionMode;
    collaborationMode?: CollaborationMode;
    resumeMode: ResumeMode;
    outputFormat: HeadlessOutputFormat;
}

export type HeadlessRunSummary = import("../sdk/types.js").TurnResult & {ok: boolean; exitCode: number};
