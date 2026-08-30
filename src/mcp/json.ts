const MAX_STABLE_JSON_CHARS = 16 * 1024 * 1024;
const MAX_STABLE_JSON_DEPTH = 32;
const MAX_STABLE_JSON_NODES = 100_000;

/** Deterministic JSON for bounded protocol values. */
export function stableJson(value: unknown): string {
    const active = new WeakSet<object>();
    let nodes = 0;
    let chars = 0;

    const serialize = (item: unknown, depth: number): string => {
        nodes += 1;
        if (nodes > MAX_STABLE_JSON_NODES || depth > MAX_STABLE_JSON_DEPTH) {
            throw new Error("MCP JSON 超过结构上限");
        }
        let result: string;
        if (Array.isArray(item)) {
            if (active.has(item)) throw new Error("MCP JSON 包含循环引用");
            active.add(item);
            result = `[${item.map((value) => serialize(value, depth + 1)).join(",")}]`;
            active.delete(item);
        } else if (item && typeof item === "object") {
            if (active.has(item)) throw new Error("MCP JSON 包含循环引用");
            active.add(item);
            result = `{${Object.entries(item as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) =>
                    `${JSON.stringify(key)}:${serialize(value, depth + 1)}`
                )
                .join(",")}}`;
            active.delete(item);
        } else {
            const encoded = JSON.stringify(item);
            result = encoded === undefined ? "null" : encoded;
        }
        chars += result.length;
        if (chars > MAX_STABLE_JSON_CHARS) {
            throw new Error("MCP JSON 超过字符上限");
        }
        return result;
    };

    return serialize(value, 0);
}
