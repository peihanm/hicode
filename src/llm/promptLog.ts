import {
    chmodSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import {randomUUID} from "node:crypto";
import {dirname, join} from "node:path";
import {
    getProjectDebugDirectory,
    getProjectStorageDirectory,
    type PillarStorageLayout,
} from "../persistence/index.js";
import type {LLMCallKind, PromptLogPendingResponse, PromptLogRequest, PromptLogResponse,} from "./types.js";

// Prompt logs are project runtime diagnostics, not repository configuration.
// 失败不致命，避免影响 agent 主流程。
const PROMPT_LOG_DIR = "prompt-logs";
const MAX_PROMPT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_LOG_FILES = 200;
const MAX_PROMPT_LOG_TOTAL_BYTES = 512 * 1024 * 1024;
const PROMPT_LOG_FILE = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f-]+\.json$/i;

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

function isCode(error: unknown, code: string): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error &&
        (error as {code?: string}).code === code
    );
}

function ensureDirectory(path: string): void {
    try {
        mkdirSync(path, {mode: 0o700});
    } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
    }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Prompt Log 目录不安全: ${path}`);
    }
    chmodSync(path, 0o700);
}

function ensurePromptLogDirectory(
    storage: PillarStorageLayout,
    cwd: string
): string {
    const projectDirectory = getProjectStorageDirectory(storage, cwd);
    const debugDirectory = getProjectDebugDirectory(storage, cwd);
    const logDirectory = join(debugDirectory, PROMPT_LOG_DIR);
    mkdirSync(storage.pillarHome, {recursive: true, mode: 0o700});
    ensureDirectory(storage.pillarHome);
    for (const directory of [
        storage.projectsRoot,
        projectDirectory,
        debugDirectory,
        logDirectory,
    ]) {
        ensureDirectory(directory);
    }
    return logDirectory;
}

function redactSerializedLog(serialized: string, secrets: readonly string[]): string {
    const values = [...new Set(secrets.filter((value) => value.length > 0))]
        .sort((left, right) => right.length - left.length);
    let redacted = serialized;
    for (const value of values) {
        const encoded = JSON.stringify(value).slice(1, -1);
        redacted = redacted.replaceAll(value, "[REDACTED]");
        if (encoded !== value) {
            redacted = redacted.replaceAll(encoded, "[REDACTED]");
        }
    }
    return redacted;
}

function prunePromptLogs(directory: string): void {
    const files = readdirSync(directory, {withFileTypes: true})
        .filter((entry) => entry.isFile() && PROMPT_LOG_FILE.test(entry.name))
        .map((entry) => {
            const path = join(directory, entry.name);
            return {name: entry.name, path, size: statSync(path).size};
        })
        .sort((left, right) => right.name.localeCompare(left.name));
    let retainedBytes = 0;
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const withinCount = index < MAX_PROMPT_LOG_FILES;
        const withinBytes = retainedBytes + file.size <= MAX_PROMPT_LOG_TOTAL_BYTES;
        if (withinCount && (withinBytes || index === 0)) {
            retainedBytes += file.size;
        } else {
            unlinkSync(file.path);
        }
    }
}

export function beginPromptLog(
    storage: PillarStorageLayout,
    cwd: string,
    kind: LLMCallKind,
    model: string,
    request: PromptLogRequest,
    secrets: readonly string[]
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
            const directory = dirname(filepath);
            const directoryInfo = lstatSync(directory);
            if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
                throw new Error("Prompt Log 目录在请求期间变得不安全");
            }
            const serialized = redactSerializedLog(JSON.stringify(
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
            ), secrets);
            if (Buffer.byteLength(serialized, "utf8") > MAX_PROMPT_LOG_BYTES) {
                throw new Error("Prompt Log 超过 64 MiB 上限");
            }
            writeFileSync(
                temporaryPath!,
                serialized,
                {encoding: "utf8", mode: 0o600, flag: "wx"}
            );
            renameSync(temporaryPath!, filepath);
            prunePromptLogs(directory);
        } catch {
            if (temporaryPath) {
                try {
                    unlinkSync(temporaryPath);
                } catch {
                }
            }
        }
    };

    try {
        const logDir = ensurePromptLogDirectory(storage, cwd);
        const ts = timestamp.replace(/[:.]/g, "-");
        const filename = `${ts}_${randomUUID()}.json`;
        filepath = join(logDir, filename);
        temporaryPath = `${filepath}.${process.pid}.tmp`;
        write({status: "pending"});
    } catch {
        // Diagnostic persistence is best effort and must not corrupt TUI output.
    }

    return {
        finish: write,
    };
}
