import {basename} from "node:path";
import stringWidth from "string-width";
import type {SubagentRegistry} from "./registry.js";
import {formatSubagentModel} from "./model.js";
import type {AgentLoadIssue} from "./types.js";

const MAX_DIAGNOSTIC_MESSAGE_CHARS = 240;
const REPORT_LINE_WIDTH = 88;
const CLOSING_PUNCTUATION = /^[、。，；：！？）》】\]})]/;

function oneLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function bounded(value: string): string {
    const line = oneLine(value);
    return line.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
        ? `${line.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS - 1)}…`
        : line;
}

function wrapDetail(value: string, prefix = "    "): string[] {
    const segments = Array.from(
        new Intl.Segmenter(undefined, {granularity: "word"})
            .segment(oneLine(value)),
        (segment) => segment.segment
    );
    const lines: string[] = [];
    let line = "";
    let width = 0;
    for (const segment of segments) {
        const segmentWidth = stringWidth(segment);
        if (line && width + segmentWidth > REPORT_LINE_WIDTH) {
            if (CLOSING_PUNCTUATION.test(segment)) {
                line += segment;
                width += segmentWidth;
                continue;
            }
            lines.push(`${prefix}${line.trimEnd()}`);
            line = segment.trimStart();
            width = stringWidth(line);
            continue;
        }
        line += segment;
        width += segmentWidth;
    }
    if (line) lines.push(`${prefix}${line.trimEnd()}`);
    return lines;
}

export function formatAgentLoadIssue(issue: AgentLoadIssue): string {
    const field = issue.field ? ` · ${issue.field}` : "";
    const origin = issue.source === "host" ? issue.id : basename(issue.path);
    return `${issue.severity.toUpperCase()} · ${issue.source} · ${origin}${field} · ${bounded(issue.message)}`;
}

export function formatAgentLoadWarning(
    issues: readonly AgentLoadIssue[]
): string | undefined {
    if (issues.length === 0) return undefined;
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const warningCount = issues.length - errorCount;
    const counts = [
        errorCount > 0 ? `${errorCount} errors` : "",
        warningCount > 0 ? `${warningCount} warnings` : "",
    ].filter(Boolean).join("、");
    return `Custom Agent loading has ${counts}; invalid definitions were skipped. Use /agents for details.`;
}

export function formatAgentRegistryReport(
    registry: SubagentRegistry,
    fastModel?: string
): string {
    const definitions = registry.listDefinitions();
    const active = definitions.flatMap((definition, index) => {
        const model = formatSubagentModel(definition, fastModel);

        return [
            ...(index > 0 ? [""] : []),
            `  ${definition.agentType} · ${definition.source}`,
            ...wrapDetail(definition.whenToUse),
            `    Model ${model}`,
            ...wrapDetail(
                definition.allowedTools ? `Tools (${definition.allowedTools.length}) ${definition.allowedTools.join(" · ")}` : "Tools inherited from the main agent"
            ),
        ];
    });
    const issues = registry.issues.length === 0
        ? ["Loading issues · none"]
        : [
            `Loading issues · ${registry.issues.length}`,
            ...registry.issues.flatMap((issue) =>
                wrapDetail(formatAgentLoadIssue(issue), "  ")
            ),
        ];
    return [
        `Agents · ${definitions.length} available`,
        ...active,
        "",
        ...issues,
    ].join("\n");
}
