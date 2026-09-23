import {createHash} from "node:crypto";
import {open, readdir, unlink,} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import {
    loadAgentSourceDirectory,
    MAX_AGENT_FILES_PER_SOURCE,
    normalizeAgentName,
    parseCustomAgentDocument,
} from "./load.js";
import {type AgentDefinitionScope, getAgentDefinitionDirectory,} from "./paths.js";
import {stringify as stringifyYaml} from "yaml";
import type {AgentDefinition} from "./types.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import {
    ensureAgentDefinitionDirectory,
    readAgentDefinitionFile,
} from "./fileAccess.js";

const AGENT_FILE_MODE = 0o600;

export interface AgentDefinitionDraft {
    name: string;
    description: string;
    tools?: readonly string[];
    readOnly?: boolean;
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

function parseStoredDefinition(
    scope: AgentDefinitionScope,
    path: string,
    raw: string
): AgentDefinition {
    const parsed = parseCustomAgentDocument({source: scope, path, raw});
    const error = parsed.issues.find((item) => item.severity === "error");
    if (!parsed.definition || error) {
        throw new Error(error?.message ?? "Invalid Agent definition");
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

export function createAgentDefinitionStore(
    storage: HiCodeStorageLayout,
    cwd: string
): AgentDefinitionStore {
    const directory = (scope: AgentDefinitionScope) =>
        getAgentDefinitionDirectory(storage, cwd, scope);

    const findDefinition = async (
        scope: AgentDefinitionScope,
        name: string
    ): Promise<AgentDefinition> => {
        const root = directory(scope);
        const loaded = await loadAgentSourceDirectory(root, scope);
        const definition = loaded.definitions.find((candidate) =>
            normalizeAgentName(candidate.agentType) === normalizeAgentName(name)
        );
        if (!definition || (definition.source !== "user" && definition.source !== "project")) {
            throw new Error(`Not found: ${scope} Agent: ${name}`);
        }
        if (!isInside(root, definition.path)) {
            throw new Error("Agent definition path is outside the managed directory");
        }
        return definition;
    };

    const readStored = async (
        scope: AgentDefinitionScope,
        name: string
    ): Promise<StoredAgentFile> => {
        const definition = await findDefinition(scope, name);
        if (definition.source !== "user" && definition.source !== "project") {
            throw new Error(`Not found: ${scope} Agent: ${name}`);
        }
        const path = definition.path;
        const raw = await readAgentDefinitionFile(path);
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
            await ensureAgentDefinitionDirectory(root, true);
            const safeName = draft.name.trim();
            // parseCustomAgentDocument validates the full protocol; block filename injection here first.
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(safeName)) {
                throw new Error("Agent name must start with a letter and contain only letters, digits, - and _");
            }
            const path = join(root, `${safeName}.md`);
            if (!isInside(root, path)) throw new Error("Invalid Agent filename");
            const {content} = validateDraft(scope, path, draft);
            await withFileLock(join(root, ".agents.lock"), async () => {
                const entries = await readdir(root, {withFileTypes: true});
                const fileCount = entries.filter((entry) =>
                    entry.isFile() && entry.name.endsWith(".md")
                ).length;
                if (fileCount >= MAX_AGENT_FILES_PER_SOURCE) {
                    throw new Error(
                        `Agent files reached the per-scope limit of ${MAX_AGENT_FILES_PER_SOURCE} items`
                    );
                }
                const loaded = await loadAgentSourceDirectory(root, scope);
                if (loaded.definitions.some((definition) =>
                    normalizeAgentName(definition.agentType) ===
                    normalizeAgentName(safeName)
                )) {
                    throw new Error(`Agent already exists in this scope: ${safeName}`);
                }
                await writeExclusive(path, content);
            });
            return readStored(scope, safeName);
        },
        async update(scope, name, expectedHash, draft) {
            const current = await readStored(scope, name);
            if (normalizeAgentName(draft.name) !== normalizeAgentName(name)) {
                throw new Error("Cannot rename an Agent while editing; create a new definition, then delete the old one");
            }
            const {content} = validateDraft(scope, current.path, draft);
            await withFileLock(join(dirname(current.path), ".agents.lock"), async () => {
                const latest = await readAgentDefinitionFile(current.path);
                if (contentHash(latest) !== expectedHash) {
                    throw new Error(
                        `Agent ${name} was modified externally; Reload before editing again`
                    );
                }
                await writeFileAtomically(current.path, content, AGENT_FILE_MODE);
            });
            return readStored(scope, name);
        },
        async remove(scope, name, expectedHash) {
            const current = await readStored(scope, name);
            await withFileLock(join(dirname(current.path), ".agents.lock"), async () => {
                const latest = await readAgentDefinitionFile(current.path);
                if (contentHash(latest) !== expectedHash) {
                    throw new Error(
                        `Agent ${name} was modified externally; Reload before retrying deletion`
                    );
                }
                await unlink(current.path);
            });
        },
    };
}

function serializeAgentDefinition(draft: AgentDefinitionDraft): string {
    const frontmatter = stringifyYaml({
        name: draft.name.trim(),
        description: draft.description.trim(),
        ...(draft.readOnly ? {read_only: true} : {}),
        ...(draft.tools ? {tools: [...new Set(draft.tools.map((tool) => tool.trim()))]} : {}),
    }, {
        lineWidth: 0,
    }).trimEnd();
    return `---\n${frontmatter}\n---\n\n${draft.systemPrompt.trim()}\n`;
}
