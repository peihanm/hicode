import {z} from "zod";
import type {Tool} from "../types.js";
import type {ToolSearchDocument, ToolSearchIndex,} from "./searchIndex.js";

export const TOOL_SEARCH_NAME = "tool_search";
const TOOL_SEARCH_DEFAULT_LIMIT = 8;
const TOOL_SEARCH_MAX_LIMIT = 10;

const toolSearchParameters = z.object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(TOOL_SEARCH_MAX_LIMIT).optional(),
}).strict();

export interface ToolSearchSelection {
    matches: readonly ToolSearchDocument[];
    missingNames: readonly string[];
}

function parseExactSelection(query: string): string[] | null {
    if (!query.toLocaleLowerCase("en-US").startsWith("select:")) return null;
    return query
        .slice(query.indexOf(":") + 1)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
}

export function selectToolSearchDocuments(
    index: ToolSearchIndex,
    query: string,
    limit = TOOL_SEARCH_DEFAULT_LIMIT
): ToolSearchSelection {
    const exactNames = parseExactSelection(query);
    if (exactNames) {
        const byName = new Map(
            index.documents.map((document) => [document.normalizedName, document])
        );
        const matches: ToolSearchDocument[] = [];
        const missingNames: string[] = [];
        const seen = new Set<string>();
        for (const requested of exactNames.slice(0, TOOL_SEARCH_MAX_LIMIT)) {
            const normalized = requested
                .normalize("NFKC")
                .toLocaleLowerCase("en-US");
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            const document = byName.get(normalized);
            if (document) matches.push(document);
            else missingNames.push(requested);
        }
        return {matches, missingNames};
    }
    return {
        matches: index.search(query, limit).map((match) => match.document),
        missingNames: [],
    };
}

function sourceSummary(documents: readonly ToolSearchDocument[]): string {
    const sources = new Map<string, string | undefined>();
    for (const document of documents) {
        if (!document.source?.name) continue;
        const current = sources.get(document.source.name);
        if (current === undefined || !current) {
            sources.set(document.source.name, document.source.description);
        }
    }
    if (sources.size === 0) return "Deferred tools registered in this runtime.";
    const entries = [...sources]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 20);
    const lines: string[] = [];
    for (const [name, description] of entries) {
        const line = description ? `- ${name}: ${description}` : `- ${name}`;
        if ([...lines, line].join("\n").length > 3_900) break;
        lines.push(line);
    }
    const omitted = sources.size - lines.length;
    if (omitted > 0) lines.push(`- … ${omitted} more source(s)`);
    return lines.join("\n").slice(0, 4_000);
}

export function createToolSearchTool(input: {
    index: ToolSearchIndex;
    discover(
        names: readonly string[],
        transactionId: string
    ): {newlyLoaded: string[]; alreadyLoaded: string[]};
    remainingCount(): number;
}): Tool<typeof toolSearchParameters> {
    const sources = sourceSummary(input.index.documents);
    return {
        name: TOOL_SEARCH_NAME,
        description: [
            "Search deferred tool metadata and load matching tools for the next model request.",
            "Use query=\"select:tool_a,tool_b\" for exact names, or natural-language keywords for BM25 search.",
            "A matched tool becomes callable only after this tool result is returned and the model receives the next request.",
            "Available sources:",
            sources,
        ].join("\n"),
        parameters: toolSearchParameters,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        maxResultSizeChars: Infinity,
        async execute({query, limit}, _ctx, invocation) {
            const selection = selectToolSearchDocuments(
                input.index,
                query,
                limit ?? TOOL_SEARCH_DEFAULT_LIMIT
            );
            const discovered = input.discover(
                selection.matches.map((document) => document.name),
                invocation.toolCallId
            );
            const lines = [
                `Loaded ${discovered.newlyLoaded.length} deferred tool(s); ${input.remainingCount()} remaining.`,
            ];
            for (const document of selection.matches) {
                const status = discovered.alreadyLoaded.includes(document.name)
                    ? "already loaded"
                    : "available next request";
                lines.push(`- ${document.name} — ${status}: ${document.description}`);
            }
            if (selection.missingNames.length > 0) {
                lines.push(`Not found: ${selection.missingNames.join(", ")}`);
            }
            if (selection.matches.length === 0) {
                lines.push("No matching deferred tools. Try one shorter capability or source keyword.");
                return {content: lines.join("\n"), outcome: "failed"};
            }
            return lines.join("\n");
        },
    };
}
