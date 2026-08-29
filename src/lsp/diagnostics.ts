import type {Diagnostic} from "vscode-languageserver-protocol";

const MAX_DIAGNOSTICS = 20;

function severityToString(severity: Diagnostic["severity"]): string {
    switch (severity) {
        case 1:
            return "error";
        case 2:
            return "warning";
        case 3:
            return "info";
        case 4:
            return "hint";
        default:
            return "diagnostic";
    }
}

function oneLine(message: Diagnostic["message"]): string {
    const text =
        typeof message === "string" ? message : message?.value ?? String(message);
    return text.replace(/\s+/g, " ").trim();
}

export function formatDiagnosticsSummary(
    filePath: string,
    diagnostics: Diagnostic[]
): string {
    if (diagnostics.length === 0) {
        return `LSP diagnostics for ${filePath}: no issues.`;
    }

    const shown = diagnostics.slice(0, MAX_DIAGNOSTICS);
    const lines = [
        `LSP diagnostics for ${filePath} (${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}):`,
    ];

    for (const diagnostic of shown) {
        const line = diagnostic.range.start.line + 1;
        const column = diagnostic.range.start.character + 1;
        const severity = severityToString(diagnostic.severity);
        const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
        const code =
            diagnostic.code !== undefined && diagnostic.code !== null
                ? ` ${String(diagnostic.code)}`
                : "";
        lines.push(
            `  ${severity}${source}${code} ${filePath}:${line}:${column} - ${oneLine(diagnostic.message)}`
        );
    }

    if (diagnostics.length > shown.length) {
        lines.push(`  ... ${diagnostics.length - shown.length} more diagnostics omitted.`);
    }

    return lines.join("\n");
}
