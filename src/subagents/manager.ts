import {CUSTOM_AGENT_FORBIDDEN_TOOLS} from "./custom.js";
import type {AgentCatalogUpdate, SubagentCatalog} from "./catalog.js";
import type {AgentDefinitionDraft, AgentDefinitionStore, StoredAgentFile,} from "./store.js";
import type {AgentDefinitionScope} from "./paths.js";

export interface AgentDefinitionManager {
    read(scope: AgentDefinitionScope, name: string): Promise<StoredAgentFile>;

    create(
        scope: AgentDefinitionScope,
        draft: AgentDefinitionDraft
    ): Promise<{file: StoredAgentFile; update: AgentCatalogUpdate}>;

    update(
        scope: AgentDefinitionScope,
        name: string,
        expectedHash: string,
        draft: AgentDefinitionDraft
    ): Promise<{file: StoredAgentFile; update: AgentCatalogUpdate}>;

    remove(
        scope: AgentDefinitionScope,
        name: string,
        expectedHash: string
    ): Promise<AgentCatalogUpdate>;

    reload(): Promise<AgentCatalogUpdate>;

    listTools(): readonly string[];
}

function validateTools(
    draft: AgentDefinitionDraft,
    availableTools: ReadonlySet<string>
): void {
    const forbidden = (draft.tools ?? []).filter((tool) =>
        CUSTOM_AGENT_FORBIDDEN_TOOLS.has(tool)
    );
    if (forbidden.length > 0) {
        throw new Error(`Agent cannot use control-plane tools: ${forbidden.join(", ")}`);
    }
    const unknown = (draft.tools ?? []).filter((tool) => !availableTools.has(tool));
    if (unknown.length > 0) {
        throw new Error(`Tool does not exist in this Runtime: ${unknown.join(", ")}`);
    }
}

export function createAgentDefinitionManager({
    store,
    catalog,
    getAvailableToolNames,
}: {
    store: AgentDefinitionStore;
    catalog: SubagentCatalog;
    getAvailableToolNames(): readonly string[];
}): AgentDefinitionManager {
    return {
        listTools: () => getAvailableToolNames().filter(name => !CUSTOM_AGENT_FORBIDDEN_TOOLS.has(name)),
        read: (scope, name) => store.read(scope, name),
        async create(scope, draft) {
            validateTools(draft, new Set(getAvailableToolNames()));
            const builtin = catalog.get(draft.name);
            if (builtin?.definition.source === "builtin") {
                throw new Error(`Custom Agents cannot override built-in type ${builtin.definition.agentType}`);
            }
            const file = await store.create(scope, draft);
            const update = await catalog.reload();
            return {file, update};
        },
        async update(scope, name, expectedHash, draft) {
            validateTools(draft, new Set(getAvailableToolNames()));
            const file = await store.update(scope, name, expectedHash, draft);
            const update = await catalog.reload();
            return {file, update};
        },
        async remove(scope, name, expectedHash) {
            await store.remove(scope, name, expectedHash);
            return catalog.reload();
        },
        reload: () => catalog.reload(),
    };
}
