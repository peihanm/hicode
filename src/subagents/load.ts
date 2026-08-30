import {basename, join} from "node:path";
import {readdir} from "node:fs/promises";
import {parse as parseYaml} from "yaml";
import {z} from "zod";
import type {AgentDefinition, AgentLoadIssue, AgentSource, LoadedCustomAgents,} from "./types.js";
import {CUSTOM_AGENT_FORBIDDEN_TOOLS} from "./custom.js";
import {
    ensureAgentDefinitionDirectory,
    readAgentDefinitionFile,
} from "./fileAccess.js";
import type {PillarStorageLayout} from "../persistence/index.js";

export const MAX_AGENT_FILES_PER_SOURCE = 64;
const MAX_ACTIVE_CUSTOM_AGENTS = 64;
const MAX_AGENT_PROMPT_CHARS = 40_000;
const MAX_AGENT_ISSUES = 50;
const MAX_AGENT_ISSUE_MESSAGE_CHARS = 240;
const MAX_AGENT_ISSUE_FIELD_CHARS = 80;
const DEFAULT_CUSTOM_AGENT_ITERATIONS = 12;

const KNOWN_FRONTMATTER_FIELDS = new Set([
    "name",
    "description",
    "tools",
    "model",
    "max_iterations",
]);

const customAgentFrontmatterSchema = z
    .object({
        name: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(
                /^[A-Za-z][A-Za-z0-9_-]*$/,
                "必须以字母开头，且只能包含字母、数字、- 和 _"
            ),
        description: z.string().trim().min(1).max(500),
        tools: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
        model: z.enum(["inherit", "fast"]).optional(),
        max_iterations: z.number().int().min(2).max(30).optional(),
    })
    .passthrough();

interface AgentDocumentInput {
    source: Exclude<AgentSource, "builtin">;
    path: string;
    raw: string;
}

export function normalizeAgentName(name: string): string {
    return name.trim().toLocaleLowerCase("en-US");
}

function issue(
    input: AgentDocumentInput,
    severity: AgentLoadIssue["severity"],
    message: string,
    field?: string
): AgentLoadIssue {
    return {
        source: input.source,
        path: input.path,
        severity,
        message: boundText(message, MAX_AGENT_ISSUE_MESSAGE_CHARS),
        ...(field ? {field: boundText(field, MAX_AGENT_ISSUE_FIELD_CHARS)} : {}),
    };
}

function boundText(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > limit
        ? `${normalized.slice(0, limit - 1)}…`
        : normalized;
}

function boundAgentLoadIssue(issue: AgentLoadIssue): AgentLoadIssue {
    return {
        ...issue,
        message: boundText(issue.message, MAX_AGENT_ISSUE_MESSAGE_CHARS),
        ...(issue.field
            ? {field: boundText(issue.field, MAX_AGENT_ISSUE_FIELD_CHARS)}
            : {}),
    };
}

function splitFrontmatter(raw: string):
    | {frontmatter: string; body: string}
    | {error: string} {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
        return {error: "缺少有效的 YAML frontmatter"};
    }
    return {
        frontmatter: match[1] ?? "",
        body: raw.slice(match[0].length),
    };
}

function yamlObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

export function parseCustomAgentDocument(input: AgentDocumentInput): {
    definition?: AgentDefinition;
    issues: AgentLoadIssue[];
} {
    const separated = splitFrontmatter(input.raw);
    if ("error" in separated) {
        return {issues: [issue(input, "error", separated.error)]};
    }

    let parsedYaml: unknown;
    try {
        parsedYaml = parseYaml(separated.frontmatter);
    } catch (error) {
        return {
            issues: [
                issue(
                    input,
                    "error",
                    `YAML 解析失败: ${error instanceof Error ? error.message : String(error)}`
                ),
            ],
        };
    }

    const rawFields = yamlObject(parsedYaml);
    if (!rawFields) {
        return {
            issues: [issue(input, "error", "frontmatter 顶层必须是对象")],
        };
    }

    const issues = Object.keys(rawFields)
        .filter((key) => !KNOWN_FRONTMATTER_FIELDS.has(key))
        .map((key) =>
            issue(input, "warning", "当前版本不支持该字段，已忽略", key)
        );
    const parsed = customAgentFrontmatterSchema.safeParse(rawFields);
    if (!parsed.success) {
        for (const problem of parsed.error.issues) {
            issues.push(
                issue(
                    input,
                    "error",
                    problem.message,
                    problem.path.join(".") || undefined
                )
            );
        }
        return {issues};
    }

    const body = separated.body.trim();
    if (!body) {
        issues.push(issue(input, "error", "Markdown 正文不能为空", "body"));
        return {issues};
    }
    if (body.length > MAX_AGENT_PROMPT_CHARS) {
        issues.push(
            issue(
                input,
                "error",
                `Markdown 正文超过 ${MAX_AGENT_PROMPT_CHARS} 字符上限`,
                "body"
            )
        );
        return {issues};
    }

    const allowedTools = [...new Set(parsed.data.tools)];
    return {
        definition: {
            agentType: parsed.data.name,
            whenToUse: parsed.data.description,
            systemPrompt: body,
            allowedTools,
            model: parsed.data.model ?? "inherit",
            maxIterations:
                parsed.data.max_iterations ?? DEFAULT_CUSTOM_AGENT_ITERATIONS,
            source: input.source,
            path: input.path,
        },
        issues,
    };
}

export async function loadAgentSourceDirectory(
    directory: string,
    source: Exclude<AgentSource, "builtin">
): Promise<{definitions: AgentDefinition[]; issues: AgentLoadIssue[]}> {
    try {
        if (!await ensureAgentDefinitionDirectory(directory)) {
            return {definitions: [], issues: []};
        }
    } catch (error) {
        return {
            definitions: [],
            issues: [{
                source,
                path: directory,
                severity: "error",
                message: error instanceof Error ? error.message : String(error),
            }],
        };
    }
    let entries;
    try {
        entries = await readdir(directory, {withFileTypes: true});
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return {definitions: [], issues: []};
        }
        return {
            definitions: [],
            issues: [{
                source,
                path: directory,
                severity: "error",
                message: `目录读取失败: ${error instanceof Error ? error.message : String(error)}`,
            }],
        };
    }

    const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
    const issues: AgentLoadIssue[] = [];
    if (candidates.length > MAX_AGENT_FILES_PER_SOURCE) {
        issues.push({
            source,
            path: directory,
            severity: "error",
            message: `Agent 文件超过 ${MAX_AGENT_FILES_PER_SOURCE} 个，只检查前 ${MAX_AGENT_FILES_PER_SOURCE} 个`,
        });
    }

    const definitions: AgentDefinition[] = [];
    const seen = new Set<string>();
    for (const entry of candidates.slice(0, MAX_AGENT_FILES_PER_SOURCE)) {
        const path = join(directory, entry.name);
        let raw: string;
        try {
            raw = await readAgentDefinitionFile(path);
        } catch (error) {
            issues.push({
                source,
                path,
                severity: "error",
                message: `文件读取失败: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
        }
        const parsed = parseCustomAgentDocument({source, path, raw});
        issues.push(...parsed.issues);
        if (!parsed.definition) continue;

        const key = normalizeAgentName(parsed.definition.agentType);
        if (seen.has(key)) {
            issues.push({
                source,
                path,
                severity: "error",
                field: "name",
                message: `同一来源存在重复 Agent 名称: ${parsed.definition.agentType}`,
            });
            continue;
        }
        seen.add(key);
        definitions.push(parsed.definition);
    }
    return {definitions, issues};
}

function mergeCustomAgentSources(
    userDefinitions: readonly AgentDefinition[],
    projectDefinitions: readonly AgentDefinition[],
    existingIssues: readonly AgentLoadIssue[] = []
): LoadedCustomAgents {
    const merged = new Map<string, AgentDefinition>();
    const issues = [...existingIssues];
    for (const definition of userDefinitions) {
        merged.set(normalizeAgentName(definition.agentType), definition);
    }
    for (const definition of projectDefinitions) {
        const key = normalizeAgentName(definition.agentType);
        const replaced = merged.get(key);
        if (replaced) {
            issues.push({
                source: "project",
                path: definition.path ?? "<project agent>",
                severity: "warning",
                field: "name",
                message: `项目 Agent ${definition.agentType} 覆盖用户定义 ${replaced.path ? basename(replaced.path) : replaced.agentType}`,
            });
        }
        merged.set(key, definition);
    }

    let definitions = [...merged.values()];
    if (definitions.length > MAX_ACTIVE_CUSTOM_AGENTS) {
        definitions = definitions
            .sort((left, right) => {
                const priority = Number(right.source === "project") - Number(left.source === "project");
                return priority || left.agentType.localeCompare(right.agentType, "en");
            })
            .slice(0, MAX_ACTIVE_CUSTOM_AGENTS);
        issues.push({
            source: "project",
            path: "<agent registry>",
            severity: "error",
            message: `生效的自定义 Agent 超过 ${MAX_ACTIVE_CUSTOM_AGENTS} 个，其余定义已忽略`,
        });
    }
    definitions.sort((left, right) =>
        left.agentType.localeCompare(right.agentType, "en")
    );
    return {
        definitions,
        issues: boundAgentLoadIssues(issues),
    };
}

export function boundAgentLoadIssues(
    issues: readonly AgentLoadIssue[]
): AgentLoadIssue[] {
    const bounded = issues.map(boundAgentLoadIssue);
    if (bounded.length <= MAX_AGENT_ISSUES) return bounded;
    const kept = bounded.slice(0, MAX_AGENT_ISSUES - 1);
    kept.push({
        source: "project",
        path: "<agent loader>",
        severity: "warning",
        message: `其余 ${issues.length - kept.length} 条 Agent 加载问题已省略`,
    });
    return kept;
}

export function validateCustomAgentTools(
    loaded: LoadedCustomAgents,
    availableToolNames: readonly string[]
): LoadedCustomAgents {
    const available = new Set(availableToolNames);
    const definitions: AgentDefinition[] = [];
    const issues = [...loaded.issues];
    for (const definition of loaded.definitions) {
        const forbidden = definition.allowedTools.filter((name) =>
            CUSTOM_AGENT_FORBIDDEN_TOOLS.has(name)
        );
        const unknown = definition.allowedTools.filter(
            (name) => !available.has(name)
        );
        if (forbidden.length > 0 || unknown.length > 0) {
            if (forbidden.length > 0) {
                issues.push({
                    source: definition.source === "project" ? "project" : "user",
                    path: definition.path ?? "<custom agent>",
                    severity: "error",
                    field: "tools",
                    message: `自定义 Agent 禁止使用工具: ${forbidden.join(", ")}`,
                });
            }
            if (unknown.length > 0) {
                issues.push({
                    source: definition.source === "project" ? "project" : "user",
                    path: definition.path ?? "<custom agent>",
                    severity: "error",
                    field: "tools",
                    message: `当前 Runtime 不存在工具: ${unknown.join(", ")}`,
                });
            }
            continue;
        }
        definitions.push(definition);
    }
    return {
        definitions,
        issues: boundAgentLoadIssues(issues),
    };
}

export async function loadCustomAgentDefinitions(
    storage: PillarStorageLayout,
    cwd: string
): Promise<LoadedCustomAgents> {
    const [user, project] = await Promise.all([
        loadAgentSourceDirectory(join(storage.pillarHome, "agents"), "user"),
        loadAgentSourceDirectory(join(cwd, ".pillar", "agents"), "project"),
    ]);
    return mergeCustomAgentSources(
        user.definitions,
        project.definitions,
        [...user.issues, ...project.issues]
    );
}
