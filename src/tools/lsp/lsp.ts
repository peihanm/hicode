import {z} from "zod";
import {existsSync, statSync} from "fs";
import {pathToFileURL} from "url";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";
import {formatDiagnosticsSummary} from "../../lsp/diagnostics.js";
import {displayToolPath} from "../shared/paths.js";
import type {DocumentSymbol, Hover, Location, LocationLink, SymbolInformation} from "vscode-languageserver-protocol";
import {
    formatDefinition,
    formatDocumentSymbol,
    formatHover,
    formatReferences,
    formatWorkspaceSymbols,
} from "./formatters.js";

// LSP 工具（多语言，配置驱动）：语义级代码理解
// 根据文件后缀自动选 server（从 ~/.pillar/lsp.json + .pillar/lsp.json + 内置默认配置加载）
//
// 支持 6 个操作：goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / diagnostics
// 加新语言只需在配置文件加 server 配置，零代码

const MAX_FILE_SIZE = 10_000_000; // 10MB

const inputSchema = z.object({
    operation: z
        .enum(["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "diagnostics"])
        .describe("LSP 操作类型"),
    filePath: z
        .string()
        .describe("文件路径（绝对或相对）。workspaceSymbol 操作时此项被忽略"),
    // line/character 只在 goToDefinition / findReferences / hover 需要
    // documentSymbol 只需 filePath；workspaceSymbol 只需 query
    line: z.number().int().min(1).optional().describe("行号（1-based）。goToDefinition/findReferences/hover 必填"),
    character: z.number().int().min(1).optional().describe("列号（1-based）。goToDefinition/findReferences/hover 必填"),
    query: z.string().optional().describe("workspaceSymbol 的搜索查询"),
});

type Input = z.infer<typeof inputSchema>;

function formatNoLspServerMessage(): string {
    return [
        "没有可用的 LSP server。",
        "请安装 pyright/typescript-language-server，或在 ~/.pillar/lsp.json / .pillar/lsp.json 配置 language server。",
    ].join("\n");
}

export const lspTool: Tool<typeof inputSchema> = {
    name: "lsp",
    description: [
        "语言服务器操作（多语言）：跳转定义、查找引用、悬停信息、文档符号、工作区符号搜索、诊断查询。",
        "",
        "根据文件后缀自动选 server（配置驱动）：",
        "- .ts/.tsx/.js/.jsx → typescript-language-server",
        "- .py → pyright",
        "- 加新语言只需在 ~/.pillar/lsp.json 或 .pillar/lsp.json 配置 server",
        "",
        "比 grep 文本匹配更准确：能理解代码结构，区分定义和引用，按符号语义查找。",
    ].join("\n"),
    parameters: inputSchema,
    maxResultSizeChars: 50_000,

    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async checkPermissions(): Promise<PermissionResult> {
        return {behavior: "allow"};
    },

    async execute(input: Input, ctx: ToolContext): Promise<string> {
        const manager = ctx.lspManager;
        if (!manager) {
            return "LSP 未初始化。";
        }

        // workspaceSymbol：跨工作区搜索，不需要具体文件位置
        if (input.operation === "workspaceSymbol") {
            if (!input.query) {
                return "workspaceSymbol 操作需要 query 参数。";
            }
            // 用 filePath 选 server（哪个 backend 都行，但 workspaceSymbol 是跨工作区的）
            // 简化：尝试用 filePath 选 server，选不到就用第一个 ready 的
            let server = manager.getServerForFile(input.filePath);
            if (!server) {
                // 选任意一个 server
                const servers = manager.listServers();
                if (servers.length === 0) return formatNoLspServerMessage();
                // 找第一个能启动的
                for (const s of servers) {
                    server = manager.getServerForFile(`test${s.extensions[0]}`);
                    if (server) break;
                }
            }
            if (!server) return `不支持的文件类型: ${input.filePath}`;

            // 确保启动
            if (server.state === "stopped" || server.state === "error") {
                try {
                    await server.start(ctx.signal);
                } catch (e) {
                    return `LSP server 启动失败: ${e instanceof Error ? e.message : String(e)}`;
                }
            }

            const result = await server.sendRequest<SymbolInformation[] | null>(
                "workspace/symbol",
                {query: input.query},
                ctx.signal
            );
            return formatWorkspaceSymbols(result, input.query, manager);
        }

        // 其他操作需要文件存在
        const absPath = manager.toAbsolute(input.filePath);
        if (!existsSync(absPath)) {
            return `文件不存在: ${input.filePath}`;
        }
        const stat = statSync(absPath);
        if (stat.size > MAX_FILE_SIZE) {
            return `文件太大（${Math.ceil(stat.size / 1_000_000)}MB 超过 10MB 限制）`;
        }

        // 选 server
        const server = manager.getServerForFile(input.filePath);
        if (!server) {
            if (manager.listServers().length === 0) return formatNoLspServerMessage();
            return `不支持的文件类型: ${input.filePath}`;
        }

        // 确保启动
        if (server.state === "stopped" || server.state === "error") {
            try {
                await server.start(ctx.signal);
            } catch (e) {
                return `LSP server 启动失败: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        // didOpen（确保 server 知道文件内容）
        await manager.openFile(input.filePath, ctx.signal);

        if (input.operation === "diagnostics") {
            const diagnostics = await manager.waitForDiagnostics(
                input.filePath,
                1200,
                0,
                ctx.signal
            );
            if (diagnostics === undefined) {
                return `No diagnostics received for ${input.filePath}. LSP may still be indexing or this server may not publish diagnostics.`;
            }
            return formatDiagnosticsSummary(displayToolPath(ctx.cwd, absPath), diagnostics);
        }

        const uri = pathToFileURL(absPath).href;
        // LSP position 是 0-based，我们接口是 1-based
        // documentSymbol 不需要 position；其他操作（goToDefinition/findReferences/hover）需要
        const position = {line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1};
        const textDocument = {uri};

        // 需要位置的操作校验参数
        if (input.operation !== "documentSymbol") {
            if (input.line === undefined || input.character === undefined) {
                return `${input.operation} 操作需要 line 和 character 参数。`;
            }
        }

        switch (input.operation) {
            case "goToDefinition": {
                const result = await server.sendRequest<Location | Location[] | LocationLink | LocationLink[] | null>(
                    "textDocument/definition",
                    {textDocument, position},
                    ctx.signal
                );
                return formatDefinition(result, manager);
            }
            case "findReferences": {
                const result = await server.sendRequest<Location[] | null>(
                    "textDocument/references",
                    {textDocument, position, context: {includeDeclaration: true}},
                    ctx.signal
                );
                return formatReferences(result, manager);
            }
            case "hover": {
                const result = await server.sendRequest<Hover | null>(
                    "textDocument/hover",
                    {textDocument, position},
                    ctx.signal
                );
                return formatHover(result);
            }
            case "documentSymbol": {
                const result = await server.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
                    "textDocument/documentSymbol",
                    {textDocument},
                    ctx.signal
                );
                return formatDocumentSymbol(result, manager);
            }
            default:
                return `未知操作: ${input.operation}`;
        }
    },
};
