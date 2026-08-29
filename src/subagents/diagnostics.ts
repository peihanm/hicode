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
    return `${issue.severity.toUpperCase()} · ${issue.source} · ${basename(issue.path)}${field} · ${bounded(issue.message)}`;
}

export function formatAgentLoadWarning(
    issues: readonly AgentLoadIssue[]
): string | undefined {
    if (issues.length === 0) return undefined;
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const warningCount = issues.length - errorCount;
    const counts = [
        errorCount > 0 ? `${errorCount} 个错误` : "",
        warningCount > 0 ? `${warningCount} 个警告` : "",
    ].filter(Boolean).join("、");
    return `自定义 Agent 加载存在 ${counts}，无效定义已跳过。输入 /agents 查看详情。`;
}

export function formatAgentRegistryReport(
    registry: SubagentRegistry,
    fastModel?: string
): string {
    const definitions = registry.listDefinitions();
    const active = definitions.flatMap((definition, index) => {
        const model = formatSubagentModel(
            definition.model,
            "继承 Root",
            fastModel
        );
        const iterations = definition.maxIterations === undefined
            ? "跟随 Root"
            : String(definition.maxIterations);
        return [
            ...(index > 0 ? [""] : []),
            `  ${definition.agentType} · ${definition.source}`,
            ...wrapDetail(definition.whenToUse),
            `    模型 ${model} · 最大轮次 ${iterations}`,
            ...wrapDetail(
                `工具 (${definition.allowedTools.length}) ${definition.allowedTools.join(" · ")}`
            ),
        ];
    });
    const issues = registry.issues.length === 0
        ? ["加载问题 · 无"]
        : [
            `加载问题 · ${registry.issues.length}`,
            ...registry.issues.flatMap((issue) =>
                wrapDetail(formatAgentLoadIssue(issue), "  ")
            ),
        ];
    return [
        `Agents · ${definitions.length} 个可用`,
        ...active,
        "",
        ...issues,
    ].join("\n");
}
