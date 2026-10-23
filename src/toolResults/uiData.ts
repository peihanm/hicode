import type {ShellResultReceipt} from "../tools/bash/receipt.js";
import type {FileChange} from "../fileChanges/index.js";
import type {FileReadReceipt} from "../tools/readFile/receipt.js";
import type {AgentReceipt} from "../tools/agent/receipt.js";
import type {ToolOutcome} from "./types.js";

export type ToolUIData = {
    type: "file_change";
    change: FileChange;
} | {type: "agent_receipt"; receipt: AgentReceipt} | {type: "file_read"; receipt: FileReadReceipt} | {type: "shell_result"; receipt: ShellResultReceipt};

export function toolFileChanges(data?: ToolUIData, outcome?: ToolOutcome): readonly FileChange[] {
    if (!data || data.type !== "file_change" || (outcome !== undefined && outcome !== "ok" && outcome !== "output_failed")) return [];
    return [data.change];
}
