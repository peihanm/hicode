import {z} from "zod";
import TurndownService from "turndown";
import {matchPattern} from "../../permissions/index.js";
import type {Tool} from "../types.js";
import {fetchPublicWebUrl, parsePublicWebUrl} from "./network.js";

const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS = 100_000;

const inputSchema = z.object({
    url: z.string().trim().min(1).describe("要读取的公共 http(s) URL"),
    max_chars: z
        .number()
        .int()
        .min(1_000)
        .max(MAX_CHARS)
        .default(DEFAULT_MAX_CHARS)
        .describe(`最多返回的正文字符数，默认 ${DEFAULT_MAX_CHARS}，最大 ${MAX_CHARS}`),
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
    description: [
        "读取用户提供或已知的公共网页、文档或文本 API，并把 HTML 转成紧凑可读文本。",
        "仅执行 GET；不支持登录态、Cookie、localhost、私网地址或二进制下载。交互式页面和本地 UI 请使用浏览器工具。",
        "首次访问每个域名需要权限确认；跨域重定向不会自动跟随，必须对新域名重新调用。",
    ].join("\n"),
    searchHint: "fetch read public URL website documentation HTTP GET 网页 文档 链接",
    searchSource: {name: "builtin", description: "Pillar 内置按需工具"},
    exposure: "deferred",
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async checkPermissions({url}) {
        try {
            const parsed = parsePublicWebUrl(url);
            return {
                behavior: "ask",
                message: `需要联网读取 ${parsed.hostname} 的公开内容`,
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
    async execute({url, max_chars}, ctx) {
        const response = await fetchPublicWebUrl(url, ctx.signal);
        if (
            response.status >= 300 && response.status < 400 &&
            response.redirectUrl
        ) {
            return [
                `跨域重定向未自动跟随（HTTP ${response.status}）。`,
                `原 URL: ${response.url}`,
                `目标 URL: ${response.redirectUrl}`,
                "如需继续，请对目标 URL 再调用 web_fetch，以单独检查并授权新域名。",
            ].join("\n");
        }
        if (!isTextContentType(response.contentType)) {
            return {
                content: `不支持的响应类型: ${response.contentType || "unknown"}（${response.body.length} bytes）`,
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
            visibleBody || "（响应正文为空）",
            ...(truncated
                ? [`\n（正文已截断为 ${max_chars} 个字符，原始正文 ${body.length} 个字符。）`]
                : []),
        ].join("\n");
        return response.status >= 400
            ? {content, outcome: "failed"}
            : content;
    },
};
