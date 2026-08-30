import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {chmod, lstat, mkdir, open} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, sep} from "node:path";
import {getSessionStorageDirectory, type PillarStorageLayout} from "../persistence/index.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import type {AgentType, SubagentResult} from "./types.js";

const MAX_TRANSCRIPT_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

type SubagentTranscriptEntry =
    | {
    type: "start";
    version: 1;
    timestamp: string;
    parentSessionId: string;
    parentToolCallId: string;
    agentId: string;
    agentType: AgentType;
    agentName?: string;
    description: string;
    model: string;
    cwd: string;
    allowedTools: readonly string[];
}
    | { type: "event"; timestamp: string; event: AgentEvent }
    | {
    type: "snapshot";
    timestamp: string;
    history: Message[];
    result: SubagentResult;
};

function safeKey(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function transcriptPath(
    storage: PillarStorageLayout,
    cwd: string,
    parentSessionId: string,
    agentId: string
): string {
    return join(
        getSessionStorageDirectory(storage, cwd, parentSessionId),
        "subagents",
        `${safeKey(agentId)}.jsonl`
    );
}

async function ensurePrivateDirectory(path: string, recursive = false): Promise<void> {
    try {
        await mkdir(path, {recursive, mode: 0o700});
    } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
            throw error;
        }
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Subagent transcript 目录不安全: ${path}`);
    }
    await chmod(path, 0o700);
}

async function ensureTranscriptDirectory(
    storage: PillarStorageLayout,
    directory: string
): Promise<void> {
    const relativePath = relative(storage.pillarHome, directory);
    if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error("Subagent transcript 路径超出 Pillar storage");
    }
    await ensurePrivateDirectory(storage.pillarHome, true);
    let current = storage.pillarHome;
    for (const component of relativePath.split(sep)) {
        if (!component || component === "." || component === "..") {
            throw new Error("Subagent transcript 目录包含非法路径片段");
        }
        current = join(current, component);
        await ensurePrivateDirectory(current);
    }
}

export class SubagentTranscriptWriter {
    readonly path: string;
    private initialized = false;
    private pending: Promise<void> = Promise.resolve();

    constructor(
        private readonly storage: PillarStorageLayout,
        cwd: string,
        parentSessionId: string,
        agentId: string
    ) {
        this.path = transcriptPath(storage, cwd, parentSessionId, agentId);
    }

    append(entry: SubagentTranscriptEntry): Promise<void> {
        const write = this.pending.then(() => this.appendOne(entry));
        this.pending = write.catch(() => undefined);
        return write;
    }

    private async appendOne(entry: SubagentTranscriptEntry): Promise<void> {
        const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
        if (line.byteLength > MAX_TRANSCRIPT_ENTRY_BYTES) {
            throw new Error("Subagent transcript 单条记录超过上限");
        }
        if (!this.initialized) {
            await ensureTranscriptDirectory(this.storage, dirname(this.path));
            this.initialized = true;
        }
        const handle = await open(
            this.path,
            constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW,
            0o600
        );
        try {
            const metadata = await handle.stat();
            if (!metadata.isFile()) {
                throw new Error("Subagent transcript 必须是普通文件");
            }
            if (metadata.size + line.byteLength > MAX_TRANSCRIPT_BYTES) {
                throw new Error("Subagent transcript 已达到大小上限");
            }
            await handle.chmod(0o600);
            await handle.writeFile(line);
        } finally {
            await handle.close();
        }
    }
}
