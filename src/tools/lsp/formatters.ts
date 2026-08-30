// LSP 结果格式化：把 LSP 标准返回类型转成 LLM 易读的字符串
// 参考 claude-code src/tools/LSPTool/formatters.ts（592 行）
// 我们简化版 ~150 行：只处理我们要的 5 个操作

import {relative} from "path";
import type {DocumentSymbol, Hover, Location, LocationLink, SymbolInformation,} from "vscode-languageserver-protocol";
import type {LspPathResolver} from "../../lsp/types.js";

const MAX_LOCATIONS = 500;
const MAX_SYMBOLS = 500;
const MAX_SYMBOL_DEPTH = 16;
const MAX_TEXT_CHARS = 32 * 1024;
const MAX_LABEL_CHARS = 512;

// LSP SymbolKind 枚举 → 可读字符串
// 参考 https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
function symbolKindToString(kind: number): string {
    const kinds: Record<number, string> = {
        1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
        6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
        11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
        15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
        20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
        25: "Operator", 26: "TypeParameter",
    };
    return kinds[kind] || "Unknown";
}

// 把 URI 转相对路径
function formatUri(uri: string, manager: LspPathResolver): string {
    let p = uri.slice(0, 32_768).replace(/^file:\/\//, "");
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    try {
        p = decodeURIComponent(p);
    } catch {
    }
    // 用一个已知文件做相对路径基准：manager.toAbsolute(".") 返回 cwd 绝对路径
    const cwd = manager.toAbsolute(".");
    const rel = relative(cwd, p).replaceAll("\\", "/");
    if (rel.length < p.length && !rel.startsWith("../../")) return rel;
    return p.replaceAll("\\", "/");
}

// 从 Location 提取 "path:line:col" 格式
function formatLocation(loc: Location, manager: LspPathResolver): string {
    const path = formatUri(loc.uri, manager);
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return `${path}:${line}:${col}`;
}

// goToDefinition / goToImplementation 格式化
// LSP 返回 Location | Location[] | LocationLink[] | LocationLink | null
// LocationLink 有 targetUri / targetRange / targetSelectionRange，需要转成 Location 处理
function locationLinkToLocation(link: LocationLink): Location {
    return {
        uri: link.targetUri,
        range: link.targetSelectionRange ?? link.targetRange,
    };
}

export function formatDefinition(
    result: Location | Location[] | LocationLink | LocationLink[] | null,
    manager: LspPathResolver
): string {
    if (!result) return "No definition found. 可能不在符号上，或定义在外部库。";

    // 统一成 Location[]
    let locs: Location[];
    if (Array.isArray(result)) {
        locs = result.slice(0, MAX_LOCATIONS).map((r) =>
            "targetUri" in r ? locationLinkToLocation(r) : r
        );
    } else if ("targetUri" in result) {
        locs = [locationLinkToLocation(result)];
    } else {
        locs = [result];
    }

    if (locs.length === 0) return "No definition found.";

    if (locs.length === 1) {
        return `Defined in ${formatLocation(locs[0]!, manager)}`;
    }
    const list = locs.map((l) => `  ${formatLocation(l, manager)}`).join("\n");
    return `Found ${locs.length} definitions:\n${list}`;
}

// findReferences 格式化
// LSP 返回 Location[] | null
export function formatReferences(
    result: Location[] | null,
    manager: LspPathResolver
): string {
    if (!result || result.length === 0) {
        return "No references found. 可能符号无引用，或 LSP 未完成索引。";
    }

    // 按文件分组
    const byFile = new Map<string, { line: number; col: number }[]>();
    for (const loc of result.slice(0, MAX_LOCATIONS)) {
        const path = formatUri(loc.uri, manager);
        const arr = byFile.get(path) ?? [];
        arr.push({line: loc.range.start.line + 1, col: loc.range.start.character + 1});
        byFile.set(path, arr);
    }

    const out: string[] = [`Found ${result.length} references across ${byFile.size} files:`];
    for (const [path, refs] of byFile) {
        out.push(`\n${path}:`);
        for (const r of refs) out.push(`  Line ${r.line}:${r.col}`);
    }
    return out.join("\n");
}

// hover 格式化
// LSP 返回 Hover | null
export function formatHover(result: Hover | null): string {
    if (!result) return "No hover information available. 可能不在符号上。";

    let content = "";
    const c = result.contents;
    if (typeof c === "string") {
        content = c.slice(0, MAX_TEXT_CHARS);
    } else if (Array.isArray(c)) {
        content = c
            .slice(0, 64)
            .map((item) => typeof item === "string" ? item : item.value)
            .join("\n\n")
            .slice(0, MAX_TEXT_CHARS);
    } else if ("value" in c) {
        content = c.value.slice(0, MAX_TEXT_CHARS);
    }

    if (result.range) {
        const line = result.range.start.line + 1;
        const col = result.range.start.character + 1;
        return `Hover at ${line}:${col}:\n\n${content}`;
    }
    return content;
}

// documentSymbol 格式化（树形递归）
// LSP 返回 DocumentSymbol[] | SymbolInformation[] | null
export function formatDocumentSymbol(
    result: DocumentSymbol[] | SymbolInformation[] | null,
    manager: LspPathResolver
): string {
    if (!result || result.length === 0) return "No symbols found in document.";

    const lines: string[] = ["Document symbols:"];

    // 判断是 DocumentSymbol（树形）还是 SymbolInformation（扁平）
    const isHierarchical = result.length > 0 && "range" in result[0]! && !("location" in result[0]!);

    if (isHierarchical) {
        let count = 0;
        const walk = (sym: DocumentSymbol, indent: number) => {
            if (count >= MAX_SYMBOLS || indent > MAX_SYMBOL_DEPTH) return;
            count += 1;
            const prefix = "  ".repeat(indent);
            const kind = symbolKindToString(sym.kind);
            const line = sym.range.start.line + 1;
            lines.push(
                `${prefix}${sym.name.slice(0, MAX_LABEL_CHARS)} (${kind}) - Line ${line}`
            );
            sym.children?.forEach((c) => walk(c, indent + 1));
        };
        (result as DocumentSymbol[]).slice(0, MAX_SYMBOLS)
            .forEach((s) => walk(s, 0));
    } else {
        // SymbolInformation（扁平）
        for (const sym of (result as SymbolInformation[]).slice(0, MAX_SYMBOLS)) {
            const kind = symbolKindToString(sym.kind);
            const loc = formatLocation(sym.location, manager);
            const container = sym.containerName
                ? ` in ${sym.containerName.slice(0, MAX_LABEL_CHARS)}`
                : "";
            lines.push(`  ${sym.name.slice(0, MAX_LABEL_CHARS)} (${kind}) - ${loc}${container}`);
        }
    }

    return lines.join("\n");
}

// workspaceSymbol 格式化
// LSP 返回 SymbolInformation[] | null
export function formatWorkspaceSymbols(
    result: SymbolInformation[] | null,
    query: string,
    manager: LspPathResolver
): string {
    if (!result || result.length === 0) {
        return `No symbols found for query "${query}".`;
    }

    const byFile = new Map<string, { name: string; kind: string; line: number; container: string }[]>();
    for (const sym of result.slice(0, MAX_SYMBOLS)) {
        const path = formatUri(sym.location.uri, manager);
        const arr = byFile.get(path) ?? [];
        arr.push({
            name: sym.name.slice(0, MAX_LABEL_CHARS),
            kind: symbolKindToString(sym.kind),
            line: sym.location.range.start.line + 1,
            container: sym.containerName?.slice(0, MAX_LABEL_CHARS) || "",
        });
        byFile.set(path, arr);
    }

    const out: string[] = [
        `Found ${result.length} symbols for "${query}" across ${byFile.size} files:`,
    ];
    for (const [path, symbols] of byFile) {
        out.push(`\n${path}:`);
        for (const s of symbols) {
            out.push(`  ${s.name} (${s.kind}) - Line ${s.line}${s.container ? ` in ${s.container}` : ""}`);
        }
    }
    return out.join("\n");
}
