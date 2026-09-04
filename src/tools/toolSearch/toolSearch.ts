import {z} from "zod";
import type {Tool} from "../types.js";
import type {ToolSearchDocument, ToolSearchIndex,} from "./searchIndex.js";

export const TOOL_SEARCH_NAME = "tool_search";
const TOOL_SEARCH_DEFAULT_LIMIT = 8;
const TOOL_SEARCH_MAX_LIMIT = 10;
const TOOL_SEARCH_MANIFEST_MAX_CHARS = 16_000;
const TOOL_SEARCH_SOURCE_DESCRIPTION_MAX_CHARS = 240;

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

function oneLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function deferredToolManifest(
    documents: readonly ToolSearchDocument[]
): string {
    const sources = new Map<
        string,
        {description?: string; documents: ToolSearchDocument[]}
    >();
    for (const document of documents) {
        const sourceName = oneLine(document.source?.name || "other");
        const current = sources.get(sourceName);
        if (current) {
            current.documents.push(document);
            if (!current.description && document.source?.description) {
                current.description = oneLine(document.source.description)
                    .slice(0, TOOL_SEARCH_SOURCE_DESCRIPTION_MAX_CHARS);
            }
        } else {
            const description = document.source?.description
                ? oneLine(document.source.description)
                    .slice(0, TOOL_SEARCH_SOURCE_DESCRIPTION_MAX_CHARS)
                : undefined;
            sources.set(sourceName, {
                ...(description ? {description} : {}),
                documents: [document],
            });
        }
    }
    if (sources.size === 0) return "- none";

    const entries = [...sources].sort(([left], [right]) =>
        left.localeCompare(right, "en-US")
    );
    const perSourceBudget = Math.max(
        256,
        Math.floor(TOOL_SEARCH_MANIFEST_MAX_CHARS / entries.length)
    );
    const lines: string[] = [];
    for (const [name, source] of entries) {
        const documentsForSource = [...source.documents].sort((left, right) =>
            left.normalizedName.localeCompare(right.normalizedName, "en-US")
        );
        const countLabel = documentsForSource.length === 1 ? "tool" : "tools";
        const prefix = `- ${name} (${documentsForSource.length} ${countLabel})` +
            (source.description ? `: ${source.description}` : "");
        const visibleNames: string[] = [];
        for (const document of documentsForSource) {
            const candidate = `${prefix}\n  ${[
                ...visibleNames,
                document.name,
            ].join(", ")}`;
            const totalCandidate = [...lines, candidate].join("\n");
            if (
                candidate.length > perSourceBudget ||
                totalCandidate.length > TOOL_SEARCH_MANIFEST_MAX_CHARS
            ) break;
            visibleNames.push(document.name);
        }
        const omitted = documentsForSource.length - visibleNames.length;
        const names = visibleNames.length > 0
            ? `\n  ${visibleNames.join(", ")}${omitted > 0
                ? `, … ${omitted} more`
                : ""}`
            : `\n  … ${omitted} registered ${omitted === 1 ? "tool" : "tools"}`;
        const line = `${prefix}${names}`;
        if ([...lines, line].join("\n").length > TOOL_SEARCH_MANIFEST_MAX_CHARS) {
            break;
        }
        lines.push(line);
    }
    const omittedSources = entries.length - lines.length;
    if (omittedSources > 0) {
        const suffix = `- … ${omittedSources} more registered ${omittedSources === 1
            ? "source"
            : "sources"}`;
        if ([...lines, suffix].join("\n").length <= TOOL_SEARCH_MANIFEST_MAX_CHARS) {
            lines.push(suffix);
        }
    }
    return lines.join("\n");
}

export function createToolSearchTool(input: {
    index: ToolSearchIndex;
    discover(
        names: readonly string[],
        transactionId: string
    ): {
        newlyLoaded: string[];
        alreadyLoaded: string[];
        skipped: string[];
    };
    remainingCount(): number;
}): Tool<typeof toolSearchParameters> {
    const manifest = deferredToolManifest(input.index.documents);
    return {
        name: TOOL_SEARCH_NAME,
        description: [
            "Search the registered deferred tools below and load matching schemas for the next model request.",
            "This tool cannot install tools or discover capabilities outside this exact runtime catalog. Do not guess unlisted sources or tool names.",
            "Use query=\"select:tool_a,tool_b\" for exact names, or natural-language keywords for BM25 search.",
            "A matched tool becomes callable only after this tool result is returned and the model receives the next request.",
            "If no tool matches, treat that capability as unavailable; do not retry with invented names.",
            "Registered deferred tools (exact names):",
            manifest,
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
                const status = discovered.skipped.includes(document.name)
                    ? "not loaded: working-set budget reached"
                    : discovered.alreadyLoaded.includes(document.name)
                        ? "already loaded"
                        : "available next request";
                lines.push(`- ${document.name} — ${status}: ${document.description}`);
            }
            if (selection.missingNames.length > 0) {
                lines.push(`Not found: ${selection.missingNames.join(", ")}`);
            }
            if (selection.matches.length === 0) {
                lines.push(
                    "No registered deferred tool matched. Tool search cannot install tools or access capabilities outside the catalog."
                );
            }
            return lines.join("\n");
        },
    };
}
