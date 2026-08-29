import {chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {getProjectDebugDirectory, type PillarStorageLayout} from "../persistence/index.js";
import type {LLMCallKind, PromptLogPendingResponse, PromptLogRequest, PromptLogResponse,} from "./types.js";

// Prompt logs are project runtime diagnostics, not repository configuration.
// 失败不致命，避免影响 agent 主流程。
const PROMPT_LOG_DIR = "prompt-logs";

export interface PromptLogHandle {
    finish(response: PromptLogResponse): void;
}

function toolName(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const fn = (value as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") return undefined;
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
}

function compactRequest(request: PromptLogRequest): Record<string, unknown> {
    const {messages, tools, ...metadata} = request;
    const toolNames = (tools ?? [])
        .map(toolName)
        .filter((name): name is string => name !== undefined);
    return {
        ...metadata,
        messages,
        ...(toolNames.length > 0 ? {toolNames} : {}),
    };
}

export function beginPromptLog(
    storage: PillarStorageLayout,
    cwd: string,
    kind: LLMCallKind,
    model: string,
    request: PromptLogRequest
): PromptLogHandle {
    const timestamp = new Date().toISOString();
    const persistedRequest = compactRequest(request);
    let filepath: string | undefined;
    let temporaryPath: string | undefined;

    const write = (
        response: PromptLogResponse | PromptLogPendingResponse
    ): void => {
        if (!filepath) return;
        try {
            writeFileSync(
                temporaryPath!,
                JSON.stringify(
                    {
                        timestamp,
                        updatedAt: new Date().toISOString(),
                        kind,
                        model,
                        request: persistedRequest,
                        response,
                    },
                    null,
                    2
                ),
                {encoding: "utf8", mode: 0o600}
            );
            renameSync(temporaryPath!, filepath);
        } catch (error) {
            if (temporaryPath) {
                try {
                    unlinkSync(temporaryPath);
                } catch {
                }
            }
            process.stderr.write(
                `[prompt-log] 落盘失败: ${error instanceof Error ? error.message : String(error)}\n`
            );
        }
    };

    try {
        const logDir = join(
            getProjectDebugDirectory(storage, cwd),
            PROMPT_LOG_DIR
        );
        mkdirSync(logDir, {recursive: true, mode: 0o700});
        chmodSync(logDir, 0o700);
        const ts = timestamp.replace(/[:.]/g, "-");
        const filename = `${ts}_${randomUUID()}.json`;
        filepath = join(logDir, filename);
        temporaryPath = `${filepath}.${process.pid}.tmp`;
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
