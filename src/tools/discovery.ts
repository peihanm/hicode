import {MAX_LOADED_DEFERRED_TOOLS, type ToolDiscoverySnapshot} from "./discoveryState.js";
export {MAX_LOADED_DEFERRED_TOOLS, type ToolDiscoverySnapshot} from "./discoveryState.js";
import type {OpenAITool} from "../llm/types.js";
import type {ToolRegistration} from "./catalog.js";
import {schemaForTool} from "./catalog.js";
import {buildToolSearchDocument, createToolSearchIndex,} from "./toolSearch/searchIndex.js";
import {createToolSearchTool, TOOL_SEARCH_NAME,} from "./toolSearch/toolSearch.js";
import type {Tool} from "./types.js";

export interface ToolDiscovery {
    readonly searchTool?: Tool;

    isDeferred(name: string): boolean;

    isExposed(name: string): boolean;

    getVisibleSchemas(): OpenAITool[];

    settleSearch(transactionId: string, succeeded: boolean): void;

    touch(name: string): void;

    getSnapshot(): ToolDiscoverySnapshot;

    restore(snapshot?: ToolDiscoverySnapshot): void;
}

const MAX_LOADED_SCHEMA_CHARS = 128 * 1024;

interface PendingDiscovery {
    names: Map<string, number>;
}

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
    const searchDocuments = deferredRegistrations.map((registration) =>
        buildToolSearchDocument(registration.tool, registration.schema())
    );
    const searchIndex = createToolSearchIndex(searchDocuments);
    const schemaCharsByName = new Map(searchDocuments.map((document) => [
        document.name,
        JSON.stringify(document.schema).length,
    ]));
    const loadedSequences = new Map<string, number>();
    const pendingDiscoveries = new Map<string, PendingDiscovery>();
    let nextSequence = 1;

    const orderedLoadedNames = (): string[] =>
        [...loadedSequences]
            .sort(([leftName, leftSequence], [rightName, rightSequence]) =>
                leftSequence - rightSequence ||
                leftName.localeCompare(rightName, "en-US")
            )
            .map(([name]) => name);

    const trimLoadedTools = () => {
        const totalSchemaChars = () => orderedLoadedNames().reduce(
            (total, name) => total + (schemaCharsByName.get(name) ?? 0),
            0
        );
        while (
            loadedSequences.size > 1 &&
            (
                loadedSequences.size > MAX_LOADED_DEFERRED_TOOLS ||
                totalSchemaChars() > MAX_LOADED_SCHEMA_CHARS
            )
        ) {
            const oldest = orderedLoadedNames()[0];
            if (!oldest) break;
            loadedSequences.delete(oldest);
        }
    };
    const reservedNewNames = (): Set<string> => {
        const names = new Set<string>();
        for (const pending of pendingDiscoveries.values()) {
            for (const name of pending.names.keys()) {
                if (!loadedSequences.has(name)) names.add(name);
            }
        }
        return names;
    };
    const searchTool = deferredRegistrations.length > 0
        ? createToolSearchTool({
            index: searchIndex,
            discover(requestedNames, transactionId) {
                const newlyLoaded: string[] = [];
                const alreadyLoaded: string[] = [];
                const skipped: string[] = [];
                const transaction = pendingDiscoveries.get(transactionId) ??
                    {names: new Map<string, number>()};
                for (const name of requestedNames) {
                    if (!deferredByName.has(name)) continue;
                    const pendingElsewhere = [...pendingDiscoveries.entries()]
                        .some(([id, pending]) =>
                            id !== transactionId && pending.names.has(name)
                        );
                    if (loadedSequences.has(name)) {
                        alreadyLoaded.push(name);
                        transaction.names.set(name, nextSequence++);
                        continue;
                    }
                    if (pendingElsewhere) {
                        newlyLoaded.push(name);
                        transaction.names.set(name, nextSequence++);
                        continue;
                    }

                    const reserved = reservedNewNames();
                    for (const reservedName of transaction.names.keys()) {
                        if (!loadedSequences.has(reservedName)) {
                            reserved.add(reservedName);
                        }
                    }
                    const reservedChars = [...reserved].reduce(
                        (total, reservedName) =>
                            total + (schemaCharsByName.get(reservedName) ?? 0),
                        0
                    );
                    const candidateChars = schemaCharsByName.get(name) ?? 0;
                    const overCount =
                        reserved.size >= MAX_LOADED_DEFERRED_TOOLS;
                    const overChars =
                        reserved.size > 0 &&
                        reservedChars + candidateChars > MAX_LOADED_SCHEMA_CHARS;
                    if (overCount || overChars) {
                        skipped.push(name);
                        continue;
                    }

                    newlyLoaded.push(name);
                    transaction.names.set(name, nextSequence++);
                }
                if (transaction.names.size > 0) {
                    pendingDiscoveries.set(transactionId, transaction);
                }
                return {newlyLoaded, alreadyLoaded, skipped};
            },
            remainingCount() {
                const selected = new Set(loadedSequences.keys());
                for (const pending of pendingDiscoveries.values()) {
                    for (const name of pending.names.keys()) selected.add(name);
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
                    loadedSequences.has(registration.tool.name)
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
                for (const [name, sequence] of pending.names) {
                    loadedSequences.set(name, sequence);
                }
                trimLoadedTools();
            }
        },
        touch(name) {
            if (loadedSequences.has(name)) {
                loadedSequences.set(name, nextSequence++);
            }
        },
        getSnapshot() {
            return {
                version: 2,
                loadedNames: orderedLoadedNames(),
            };
        },
        restore(snapshot) {
            loadedSequences.clear();
            pendingDiscoveries.clear();
            if (
                snapshot?.version === 2 &&
                Array.isArray(snapshot.loadedNames)
            ) {
                for (const name of snapshot.loadedNames) {
                    if (typeof name === "string" && deferredByName.has(name)) {
                        loadedSequences.set(name, nextSequence++);
                    }
                }
                trimLoadedTools();
            }
            getVisibleSchemas();
        },
    };
}
