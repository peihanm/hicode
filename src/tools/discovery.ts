import type {OpenAITool} from "../llm/types.js";
import type {ToolRegistration} from "./catalog.js";
import {schemaForTool} from "./catalog.js";
import {buildToolSearchDocument, createToolSearchIndex,} from "./toolSearch/searchIndex.js";
import {createToolSearchTool, TOOL_SEARCH_NAME,} from "./toolSearch/toolSearch.js";
import type {Tool} from "./types.js";

export interface ToolDiscoverySnapshot {
    version: 1;
    discoveredNames: string[];
}

export interface ToolDiscovery {
    readonly searchTool?: Tool;

    isDeferred(name: string): boolean;

    isExposed(name: string): boolean;

    getVisibleSchemas(): OpenAITool[];

    settleSearch(transactionId: string, succeeded: boolean): void;

    getSnapshot(): ToolDiscoverySnapshot;

    restore(snapshot?: ToolDiscoverySnapshot): void;
}

const MAX_PERSISTED_DISCOVERED_TOOLS = 4_096;

export function createToolDiscovery(
    registrations: readonly ToolRegistration[]
): ToolDiscovery {
    const directRegistrations = registrations.filter(
        (registration) => registration.exposure === "direct"
    );
    const deferredRegistrations = registrations.filter(
        (registration) => registration.exposure === "deferred"
    );
    const deferredByName = new Map(
        deferredRegistrations.map((registration) => [
            registration.tool.name,
            registration,
        ])
    );
    const discoveredNames = new Set<string>();
    const pendingDiscoveries = new Map<string, Set<string>>();
    const searchIndex = createToolSearchIndex(
        deferredRegistrations.map((registration) =>
            buildToolSearchDocument(registration.tool, registration.schema())
        )
    );
    const searchTool = deferredRegistrations.length > 0
        ? createToolSearchTool({
            index: searchIndex,
            discover(requestedNames, transactionId) {
                const newlyLoaded: string[] = [];
                const alreadyLoaded: string[] = [];
                const transaction = pendingDiscoveries.get(transactionId) ??
                    new Set<string>();
                for (const name of requestedNames) {
                    if (!deferredByName.has(name)) continue;
                    const pendingElsewhere = [...pendingDiscoveries.entries()]
                        .some(([id, names]) =>
                            id !== transactionId && names.has(name)
                        );
                    if (discoveredNames.has(name) || pendingElsewhere) {
                        alreadyLoaded.push(name);
                    } else {
                        newlyLoaded.push(name);
                    }
                    if (!discoveredNames.has(name)) transaction.add(name);
                }
                if (transaction.size > 0) {
                    pendingDiscoveries.set(transactionId, transaction);
                }
                return {newlyLoaded, alreadyLoaded};
            },
            remainingCount() {
                const selected = new Set(discoveredNames);
                for (const names of pendingDiscoveries.values()) {
                    for (const name of names) selected.add(name);
                }
                return deferredRegistrations.length - selected.size;
            },
        })
        : undefined;
    const searchSchema = searchTool ? schemaForTool(searchTool) : undefined;
    let exposedNames = new Set<string>([
        ...directRegistrations.map((registration) => registration.tool.name),
        ...(searchTool ? [TOOL_SEARCH_NAME] : []),
    ]);

    const getVisibleSchemas = (): OpenAITool[] => {
        const visible = [
            ...directRegistrations.map((registration) => registration.schema()),
            ...(searchSchema ? [searchSchema] : []),
            ...deferredRegistrations
                .filter((registration) =>
                    discoveredNames.has(registration.tool.name)
                )
                .map((registration) => registration.schema()),
        ];
        exposedNames = new Set(visible.map((schema) => schema.function.name));
        return visible;
    };

    return {
        searchTool,
        isDeferred(name) {
            return deferredByName.has(name);
        },
        isExposed(name) {
            return exposedNames.has(name);
        },
        getVisibleSchemas,
        settleSearch(transactionId, succeeded) {
            const pending = pendingDiscoveries.get(transactionId);
            pendingDiscoveries.delete(transactionId);
            if (succeeded && pending) {
                for (const name of pending) discoveredNames.add(name);
            }
        },
        getSnapshot() {
            return {
                version: 1,
                discoveredNames: deferredRegistrations
                    .map((registration) => registration.tool.name)
                    .filter((name) => discoveredNames.has(name))
                    .slice(0, MAX_PERSISTED_DISCOVERED_TOOLS),
            };
        },
        restore(snapshot) {
            discoveredNames.clear();
            pendingDiscoveries.clear();
            if (
                snapshot?.version === 1 &&
                Array.isArray(snapshot.discoveredNames)
            ) {
                for (const name of snapshot.discoveredNames.slice(
                    0,
                    MAX_PERSISTED_DISCOVERED_TOOLS
                )) {
                    if (typeof name === "string" && deferredByName.has(name)) {
                        discoveredNames.add(name);
                    }
                }
            }
            getVisibleSchemas();
        },
    };
}
