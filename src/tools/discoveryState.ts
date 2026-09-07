export const MAX_LOADED_DEFERRED_TOOLS = 24;

export interface ToolDiscoverySnapshot {
    version: 2;
    /** Oldest to newest, so restore preserves the eviction order. */
    loadedNames: string[];
}
