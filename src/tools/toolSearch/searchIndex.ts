import type {OpenAITool} from "../../llm/types.js";
import type {Tool} from "../types.js";

const MAX_SEARCH_TEXT_CHARS = 16_384;
const MAX_RESULT_DESCRIPTION_CHARS = 1_000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface ToolSearchDocument {
    name: string;
    normalizedName: string;
    description: string;
    source?: {name: string; description?: string};
    schema: OpenAITool;
    tokens: readonly string[];
}

interface ToolSearchMatch {
    document: ToolSearchDocument;
    score: number;
}

export interface ToolSearchIndex {
    readonly documents: readonly ToolSearchDocument[];
    search(query: string, limit: number): ToolSearchMatch[];
}

function identifierText(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_:/.-]+/g, " ");
}

/** Unicode-aware tokenizer with bounded Han bigrams for Chinese tool metadata. */
export function tokenizeToolSearchText(value: string): string[] {
    const normalized = identifierText(value.normalize("NFKC"));
    const segments = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
    const tokens: string[] = [];
    for (const segment of segments) {
        const lower = segment.toLocaleLowerCase("en-US");
        if (/^\p{Script=Han}+$/u.test(segment)) {
            tokens.push(lower);
            const chars = [...lower];
            if (chars.length === 1) {
                tokens.push(chars[0]!);
            } else {
                for (let index = 0; index < chars.length - 1; index++) {
                    tokens.push(`${chars[index]}${chars[index + 1]}`);
                }
            }
        } else {
            tokens.push(lower);
        }
    }
    return tokens;
}

function collectSchemaSearchText(
    value: unknown,
    output: string[],
    depth = 0
): void {
    if (!value || typeof value !== "object" || depth > 10) return;
    const schema = value as Record<string, unknown>;
    if (typeof schema.description === "string") {
        output.push(schema.description);
    }
    if (schema.properties && typeof schema.properties === "object") {
        for (const [name, child] of Object.entries(
            schema.properties as Record<string, unknown>
        )) {
            output.push(name);
            collectSchemaSearchText(child, output, depth + 1);
        }
    }
    if (schema.items) collectSchemaSearchText(schema.items, output, depth + 1);
    if (Array.isArray(schema.anyOf)) {
        for (const child of schema.anyOf) {
            collectSchemaSearchText(child, output, depth + 1);
        }
    }
    if (Array.isArray(schema.oneOf)) {
        for (const child of schema.oneOf) {
            collectSchemaSearchText(child, output, depth + 1);
        }
    }
    if (Array.isArray(schema.allOf)) {
        for (const child of schema.allOf) {
            collectSchemaSearchText(child, output, depth + 1);
        }
    }
}

export function buildToolSearchDocument(
    tool: Tool<any>,
    schema: OpenAITool
): ToolSearchDocument {
    const schemaParts: string[] = [];
    collectSchemaSearchText(schema.function.parameters, schemaParts);
    const source = tool.searchSource
        ? {
            name: tool.searchSource.name.trim(),
            ...(tool.searchSource.description?.trim()
                ? {description: tool.searchSource.description.trim()}
                : {}),
        }
        : undefined;
    const parts = [
        tool.name,
        identifierText(tool.name),
        tool.name,
        tool.description,
        tool.searchHint ?? "",
        source?.name ?? "",
        source?.description ?? "",
        ...schemaParts,
    ];
    const searchText = parts.join(" ").slice(0, MAX_SEARCH_TEXT_CHARS);
    return {
        name: tool.name,
        normalizedName: tool.name.normalize("NFKC").toLocaleLowerCase("en-US"),
        description: tool.description
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_RESULT_DESCRIPTION_CHARS),
        ...(source?.name ? {source} : {}),
        schema,
        tokens: tokenizeToolSearchText(searchText),
    };
}

export function createToolSearchIndex(
    documents: readonly ToolSearchDocument[]
): ToolSearchIndex {
    const termFrequencies = documents.map((document) => {
        const frequencies = new Map<string, number>();
        for (const token of document.tokens) {
            frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
        }
        return frequencies;
    });
    const documentFrequencies = new Map<string, number>();
    for (const frequencies of termFrequencies) {
        for (const token of frequencies.keys()) {
            documentFrequencies.set(
                token,
                (documentFrequencies.get(token) ?? 0) + 1
            );
        }
    }
    const averageLength = documents.length === 0
        ? 0
        : documents.reduce((total, document) => total + document.tokens.length, 0) /
        documents.length;

    return {
        documents,
        search(query, limit) {
            if (documents.length === 0 || limit <= 0) return [];
            const queryTokens = [...new Set(tokenizeToolSearchText(query))];
            if (queryTokens.length === 0) return [];
            const matches: ToolSearchMatch[] = [];
            for (let index = 0; index < documents.length; index++) {
                const document = documents[index]!;
                const frequencies = termFrequencies[index]!;
                let score = 0;
                for (const token of queryTokens) {
                    const frequency = frequencies.get(token) ?? 0;
                    if (frequency === 0) continue;
                    const containingDocuments = documentFrequencies.get(token) ?? 0;
                    const inverseDocumentFrequency = Math.log(
                        1 +
                        (documents.length - containingDocuments + 0.5) /
                        (containingDocuments + 0.5)
                    );
                    const lengthRatio = averageLength > 0
                        ? document.tokens.length / averageLength
                        : 1;
                    score += inverseDocumentFrequency *
                        (frequency * (BM25_K1 + 1)) /
                        (frequency + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio));
                }
                if (score > 0) matches.push({document, score});
            }
            return matches
                .sort((left, right) =>
                    right.score - left.score ||
                    left.document.normalizedName.localeCompare(
                        right.document.normalizedName
                    )
                )
                .slice(0, limit);
        },
    };
}
