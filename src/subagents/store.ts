import {createHash} from "node:crypto";
import {lstat, mkdir, open, readdir, readFile, unlink,} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import {
    loadAgentSourceDirectory,
    MAX_AGENT_FILES_PER_SOURCE,
    normalizeAgentName,
    parseCustomAgentDocument,
} from "./load.js";
import {type AgentDefinitionScope, getAgentDefinitionDirectory,} from "./paths.js";
import {serializeAgentDefinition} from "./serialize.js";
import type {AgentDefinition} from "./types.js";

const AGENT_FILE_MODE = 0o600;

export interface AgentDefinitionDraft {
    name: string;
    description: string;
    tools: readonly string[];
    model: "inherit" | string;
    maxIterations: number;
    systemPrompt: string;
}

export interface StoredAgentFile {
    scope: AgentDefinitionScope;
    path: string;
    contentHash: string;
    definition: AgentDefinition;
}

export interface AgentDefinitionStore {
    read(scope: AgentDefinitionScope, name: string): Promise<StoredAgentFile>;

    create(
        scope: AgentDefinitionScope,
        draft: AgentDefinitionDraft
    ): Promise<StoredAgentFile>;

    update(
        scope: AgentDefinitionScope,
        name: string,
        expectedHash: string,
        draft: AgentDefinitionDraft
    ): Promise<StoredAgentFile>;

    remove(
        scope: AgentDefinitionScope,
        name: string,
        expectedHash: string
    ): Promise<void>;
}

function contentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

function isInside(directory: string, path: string): boolean {
    const value = relative(resolve(directory), resolve(path));
    return value === "" || (
        value !== ".." &&
        !value.startsWith(`..${sep}`) &&
        !isAbsolute(value)
    );
}

async function ensureSafeDirectory(directory: string): Promise<void> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Agent 目录必须是真实目录，不能是 symlink");
    }
}

async function ensureSafeFile(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("Agent 定义必须是普通文件，不能是 symlink");
    }
}

function parseStoredDefinition(
    scope: AgentDefinitionScope,
    path: string,
    raw: string
): AgentDefinition {
    const parsed = parseCustomAgentDocument({source: scope, path, raw});
    const error = parsed.issues.find((item) => item.severity === "error");
    if (!parsed.definition || error) {
        throw new Error(error?.message ?? "Agent 定义无效");
    }
    return parsed.definition;
}

function validateDraft(
    scope: AgentDefinitionScope,
    path: string,
    draft: AgentDefinitionDraft
): {content: string; definition: AgentDefinition} {
    const content = serializeAgentDefinition(draft);
    return {
        content,
        definition: parseStoredDefinition(scope, path, content),
    };
}

async function writeExclusive(path: string, content: string): Promise<void> {
    const handle = await open(path, "wx", AGENT_FILE_MODE);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export function createAgentDefinitionStore(cwd: string): AgentDefinitionStore {
    const directory = (scope: AgentDefinitionScope) =>
        getAgentDefinitionDirectory(cwd, scope);

    const findDefinition = async (
        scope: AgentDefinitionScope,
        name: string
    ): Promise<AgentDefinition> => {
        const root = directory(scope);
        const loaded = await loadAgentSourceDirectory(root, scope);
        const definition = loaded.definitions.find((candidate) =>
            normalizeAgentName(candidate.agentType) === normalizeAgentName(name)
        );
        if (!definition?.path) {
            throw new Error(`找不到 ${scope} Agent: ${name}`);
        }
        if (!isInside(root, definition.path)) {
            throw new Error("Agent 定义路径超出受管目录");
        }
        return definition;
    };

    const readStored = async (
        scope: AgentDefinitionScope,
        name: string
    ): Promise<StoredAgentFile> => {
        const definition = await findDefinition(scope, name);
        const path = definition.path!;
        await ensureSafeFile(path);
        const raw = await readFile(path, "utf8");
        return {
            scope,
            path,
            contentHash: contentHash(raw),
            definition: parseStoredDefinition(scope, path, raw),
        };
    };

    return {
        read: readStored,
        async create(scope, draft) {
            const root = directory(scope);
            await ensureSafeDirectory(root);
            const safeName = draft.name.trim();
            // parseCustomAgentDocument 负责完整协议校验；这里先阻断文件名注入。
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(safeName)) {
                throw new Error("Agent 名称必须以字母开头，且只能包含字母、数字、- 和 _");
            }
            const path = join(root, `${safeName}.md`);
            if (!isInside(root, path)) throw new Error("Agent 文件名无效");
            const {content} = validateDraft(scope, path, draft);
            await withFileLock(join(root, ".agents.lock"), async () => {
                const entries = await readdir(root, {withFileTypes: true});
                const fileCount = entries.filter((entry) =>
                    entry.isFile() && entry.name.endsWith(".md")
                ).length;
                if (fileCount >= MAX_AGENT_FILES_PER_SOURCE) {
                    throw new Error(
                        `Agent 文件已达到每个作用域 ${MAX_AGENT_FILES_PER_SOURCE} 个的上限`
                    );
                }
                const loaded = await loadAgentSourceDirectory(root, scope);
                if (loaded.definitions.some((definition) =>
                    normalizeAgentName(definition.agentType) ===
                    normalizeAgentName(safeName)
                )) {
                    throw new Error(`同一作用域已存在 Agent: ${safeName}`);
                }
                await writeExclusive(path, content);
            });
            return readStored(scope, safeName);
        },
        async update(scope, name, expectedHash, draft) {
            const current = await readStored(scope, name);
            if (normalizeAgentName(draft.name) !== normalizeAgentName(name)) {
                throw new Error("编辑时不能重命名 Agent；请新建定义后删除旧定义");
            }
            const {content} = validateDraft(scope, current.path, draft);
            await withFileLock(join(dirname(current.path), ".agents.lock"), async () => {
                await ensureSafeFile(current.path);
                const latest = await readFile(current.path, "utf8");
                if (contentHash(latest) !== expectedHash) {
                    throw new Error(
                        `Agent ${name} 已被外部修改；请 Reload 后重新编辑`
                    );
                }
                await writeFileAtomically(current.path, content, AGENT_FILE_MODE);
            });
            return readStored(scope, name);
        },
        async remove(scope, name, expectedHash) {
            const current = await readStored(scope, name);
            await withFileLock(join(dirname(current.path), ".agents.lock"), async () => {
                await ensureSafeFile(current.path);
                const latest = await readFile(current.path, "utf8");
                if (contentHash(latest) !== expectedHash) {
                    throw new Error(
                        `Agent ${name} 已被外部修改；请 Reload 后重试删除`
                    );
                }
                await unlink(current.path);
            });
        },
    };
}
