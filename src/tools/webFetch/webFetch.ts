import {z} from "zod";
import TurndownService from "turndown";
import {matchPattern} from "../../permissions/index.js";
import type {Tool} from "../types.js";
import {fetchPublicWebUrl, parsePublicWebUrl} from "./network.js";
import {buildPersistFailureMessage} from "../../toolResults/format.js";

const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS = 100_000;

const inputSchema = z.object({
    url: z.string().trim().min(1).describe("Public HTTP(S) URL to fetch."),
    max_chars: z
        .number()
        .int()
        .min(1_000)
        .max(MAX_CHARS)
        .default(DEFAULT_MAX_CHARS)
        .describe("Body preview character limit, default 50000, maximum 100000; excess content is saved for line-based reading."),
});

export function htmlToReadableText(html: string): string {
    const converter = new TurndownService({
        headingStyle: "atx",
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        emDelimiter: "*",
    });
    converter.remove([
        "script",
        "style",
        "noscript",
        "template",
        "canvas",
    ]);
    return converter
        .turndown(
            html.replace(/<(svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        )
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/^(\s*)-\s+/gm, "$1- ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function isTextContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase();
    return normalized.startsWith("text/") ||
        normalized.includes("json") ||
        normalized.includes("xml") ||
        normalized.includes("yaml") ||
        normalized.includes("javascript") ||
        normalized === "";
}

function permissionContent(url: string): string {
    return `domain:${parsePublicWebUrl(url).hostname.toLowerCase()}`;
}

export const webFetchTool: Tool<typeof inputSchema> = {
    name: "web_fetch",
    description: "Fetch a supplied or reliably known public HTTP(S) page/document/text API using GET and convert HTML to readable text. This is not a search engine or browser. No login state, cookies, localhost/private networks or binary downloads. Interactive pages require an actually provided browser capability; do not invent one. Domain access follows runtime approval; cross-domain redirects require a separate request. Read long saved results with read_file using line-based offset/limit.",
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async checkPermissions({url}) {
        try {
            const parsed = parsePublicWebUrl(url);
            return {
                behavior: "ask",
                message: `Network access required to read public content from ${parsed.hostname} .`,
            };
        } catch (error) {
            return {
                behavior: "deny",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    },
    async preparePermissionMatcher({url}) {
        let target: string;
        try {
            target = permissionContent(url);
        } catch {
            target = `input:${url}`;
        }
        return (pattern) => matchPattern(pattern, target);
    },
    async execute({url, max_chars}, ctx, invocation) {
        const response = await fetchPublicWebUrl(url, ctx.signal);
        if (
            response.status >= 300 && response.status < 400 &&
            response.redirectUrl
        ) {
            return [
                `Cross-domain redirect was not followed automatically (HTTP ${response.status}).`,
                `Original URL: ${response.url}`,
                `Target URL: ${response.redirectUrl}`,
                "To continue, call web_fetch on the target URL to check and authorize the new domain separately.",
            ].join("\n");
        }
        if (!isTextContentType(response.contentType)) {
            return {
                content: `Unsupported response type: ${response.contentType || "unknown"}(${response.body.length} bytes)`,
                outcome: "failed",
            };
        }

        const raw = response.body.toString("utf8");
        const body = response.contentType.toLowerCase().includes("html")
            ? htmlToReadableText(raw)
            : raw.trim();
        const truncated = body.length > max_chars;
        const visibleBody = truncated ? body.slice(0, max_chars) : body;
        const header = [
            `URL: ${response.url}`,
            `HTTP: ${response.status} ${response.statusText}`.trim(),
            `Content-Type: ${response.contentType || "unknown"}`,
        ];
        const content = [
            ...header,
            "",
            visibleBody || "(empty response body)",
        ].join("\n");
        if (truncated) {
            try {
                const persisted = await ctx.toolResultStore.persistText({
                    toolCallId: invocation.toolCallId,
                    toolName: "web_fetch",
                    content: [...header, "", body].join("\n"),
                });
                return {
                    content: "",
                    displayContent: content,
                    persisted: {...persisted, preview: persisted.preview.slice(0, max_chars)},
                    outcome: response.status >= 400 ? "failed" : "ok",
                };
            } catch (error) {
                return {
                    content: buildPersistFailureMessage("web_fetch", content.slice(0, Math.min(max_chars, ctx.toolResultStore.previewChars)), error),
                    outcome: response.status >= 400 ? "failed" : "ok",
                };
            }
        }
        return response.status >= 400
            ? {content, outcome: "failed"}
            : content;
    },
};
