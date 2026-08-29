import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import type {LLMCallKind, PromptLogPendingResponse, PromptLogRequest, PromptLogResponse,} from "./types.js";

// prompt log 落盘目录：.pillar/prompt-log/
// 失败不致命，避免影响 agent 主流程。
const PROMPT_LOG_DIR = ".pillar/prompt-log";
let promptLogSeq = 0;

export function nextPromptLogSeq(): number {
    promptLogSeq += 1;
    return promptLogSeq;
}

export interface PromptLogHandle {
    finish(response: PromptLogResponse): void;
}

export function beginPromptLog(
    cwd: string,
    seq: number,
    kind: LLMCallKind,
    model: string,
    request: PromptLogRequest
): PromptLogHandle {
    const timestamp = new Date().toISOString();
    let filepath: string | undefined;

    const write = (
        response: PromptLogResponse | PromptLogPendingResponse
    ): void => {
        if (!filepath) return;
        try {
            writeFileSync(
                filepath,
                JSON.stringify(
                    {
                        timestamp,
                        updatedAt: new Date().toISOString(),
                        seq,
                        kind,
                        model,
                        request,
                        response,
                    },
                    null,
                    2
                ),
                "utf-8"
            );
        } catch (error) {
            process.stderr.write(
                `[prompt-log] 落盘失败: ${error instanceof Error ? error.message : String(error)}\n`
            );
        }
    };

    try {
        const logDir = join(cwd, PROMPT_LOG_DIR);
        if (!existsSync(logDir)) {
            mkdirSync(logDir, {recursive: true});
        }
        const ts = timestamp.replace(/[:.]/g, "-");
        const filename = `${ts}_${String(seq).padStart(4, "0")}.json`;
        filepath = join(logDir, filename);
        write({status: "pending"});
    } catch (error) {
        process.stderr.write(
            `[prompt-log] 落盘失败: ${error instanceof Error ? error.message : String(error)}\n`
        );
    }

    return {
        finish: write,
    };
}
