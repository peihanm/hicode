import {basename, join} from "node:path";
import {readdir} from "node:fs/promises";
import {parse as parseYaml} from "yaml";
import {z} from "zod";
import type {AgentDefinition, AgentFileSource, AgentLoadIssue, AgentSource, LoadedCustomAgents,} from "./types.js";
import {CUSTOM_AGENT_FORBIDDEN_TOOLS} from "./custom.js";
import {
    ensureAgentDefinitionDirectory,
    readAgentDefinitionFile,
} from "./fileAccess.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import type {HostAgentContribution} from "../runtime/rootContributions.js";

export const MAX_AGENT_FILES_PER_SOURCE = 64;
const MAX_ACTIVE_CUSTOM_AGENTS = 64;
const MAX_AGENT_PROMPT_CHARS = 40_000;
const MAX_AGENT_ISSUES = 50;
const MAX_AGENT_ISSUE_MESSAGE_CHARS = 240;
const MAX_AGENT_ISSUE_FIELD_CHARS = 80;

const KNOWN_FRONTMATTER_FIELDS = new Set([
    "name",
    "description",
    "tools",
    "read_only",
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
                "Must start with a letter and contain only letters, digits, - and _"
            ),
        description: z.string().trim().min(1).max(500),
        read_only: z.boolean().optional(),
        tools: z.array(z.string().trim().min(1).max(128)).min(1).max(128).optional(),
    })
    .passthrough();

interface AgentDocumentInput {
    source: AgentFileSource;
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

function issueForDefinition(
    definition: Exclude<AgentDefinition, {source: "builtin"}>,
    severity: AgentLoadIssue["severity"],
    message: string,
    field?: string
): AgentLoadIssue {
    const details = {
        severity,
        message,
        ...(field ? {field} : {}),
    };
    return definition.source === "host"
        ? {...details, source: "host", id: definition.id}
        : {...details, source: definition.source, path: definition.path};
}

function splitFrontmatter(raw: string):
    | {frontmatter: string; body: string}
    | {error: string} {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
        return {error: "Valid YAML frontmatter is required"};
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
                    `YAML parse failed: ${error instanceof Error ? error.message : String(error)}`
                ),
            ],
        };
    }

    const rawFields = yamlObject(parsedYaml);
    if (!rawFields) {
        return {
            issues: [issue(input, "error", "Frontmatter must be an object")],
        };
    }

    const issues = Object.keys(rawFields)
        .filter((key) => !KNOWN_FRONTMATTER_FIELDS.has(key))
        .map((key) =>
            issue(input, "warning", "This field is not supported in the current version and was ignored", key)
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
        issues.push(issue(input, "error", "Markdown body must not be empty", "body"));
        return {issues};
    }
    if (body.length > MAX_AGENT_PROMPT_CHARS) {
        issues.push(
            issue(
                input,
                "error",
                `Markdown body exceeds the ${MAX_AGENT_PROMPT_CHARS} character limit`,
                "body"
            )
        );
        return {issues};
    }

    const allowedTools = parsed.data.tools ? [...new Set(parsed.data.tools)] : undefined;
    return {
        definition: {
            agentType: parsed.data.name,
            whenToUse: parsed.data.description,
            systemPrompt: body,
            allowedTools,
            readOnly: parsed.data.read_only,
            source: input.source,
            path: input.path,
        },
        issues,
    };
}

export async function loadAgentSourceDirectory(
    directory: string,
    source: AgentFileSource
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
                message: `Failed to read directory: ${error instanceof Error ? error.message : String(error)}`,
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
            message: `Agent files exceed ${MAX_AGENT_FILES_PER_SOURCE} ; only inspecting the first ${MAX_AGENT_FILES_PER_SOURCE} items`,
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
                message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
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
                message: `Duplicate Agent name in the same source: ${parsed.definition.agentType}`,
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
    hostDefinitions: readonly AgentDefinition[] = [],
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
                path: definition.source === "project"
                    ? definition.path
                    : "<project agent>",
                severity: "warning",
                field: "name",
                message: `Project Agent ${definition.agentType} overrides user definition ${replaced.source === "user" || replaced.source === "project" ? basename(replaced.path) : replaced.agentType}`,
            });
        }
        merged.set(key, definition);
    }
    for (const definition of hostDefinitions) {
        const key = normalizeAgentName(definition.agentType);
        const replaced = merged.get(key);
        if (replaced && definition.source === "host") {
            issues.push({
                source: "host",
                id: definition.id,
                severity: "warning",
                field: "name",
                message: `Host Agent ${definition.agentType} overrides ${replaced.source} definition`,
            });
        }
        merged.set(key, definition);
    }

    let definitions = [...merged.values()];
    if (definitions.length > MAX_ACTIVE_CUSTOM_AGENTS) {
        definitions = definitions
            .sort((left, right) => {
                const rank = (source: AgentSource) =>
                    source === "host" ? 3 : source === "project" ? 2 : 1;
                const priority = rank(right.source) - rank(left.source);
                return priority || left.agentType.localeCompare(right.agentType, "en");
            })
            .slice(0, MAX_ACTIVE_CUSTOM_AGENTS);
        issues.push({
            source: "project",
            path: "<agent registry>",
            severity: "error",
            message: `Effective custom Agents exceed ${MAX_ACTIVE_CUSTOM_AGENTS} ; remaining definitions were ignored`,
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
        message: `Remaining ${issues.length - kept.length} Agent loading issues omitted`,
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
        if (definition.source === "builtin") {
            throw new Error("LoadedCustomAgents must not include built-in definitions");
        }
        const forbidden = (definition.allowedTools ?? []).filter((name) =>
            CUSTOM_AGENT_FORBIDDEN_TOOLS.has(name)
        );
        const unknown = (definition.allowedTools ?? []).filter(
            (name) => !available.has(name)
        );
        if (forbidden.length > 0 || unknown.length > 0) {
            if (forbidden.length > 0) {
                issues.push(issueForDefinition(
                    definition,
                    "error",
                    `Custom Agent cannot use tools: ${forbidden.join(", ")}`,
                    "tools"
                ));
            }
            if (unknown.length > 0) {
                issues.push(issueForDefinition(
                    definition,
                    "error",
                    `Tool does not exist in this Runtime: ${unknown.join(", ")}`,
                    "tools"
                ));
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
    storage: HiCodeStorageLayout,
    cwd: string,
    sources: readonly AgentFileSource[] = ["user", "project"],
    hostAgents: readonly HostAgentContribution[] = []
): Promise<LoadedCustomAgents> {
    const [user, project] = await Promise.all([
        sources.includes("user")
            ? loadAgentSourceDirectory(join(storage.hicodeHome, "agents"), "user")
            : {definitions: [], issues: []},
        sources.includes("project")
            ? loadAgentSourceDirectory(join(cwd, ".hicode", "agents"), "project")
            : {definitions: [], issues: []},
    ]);
    return mergeCustomAgentSources(
        user.definitions,
        project.definitions,
        hostAgents.map((agent) => ({
            agentType: agent.name,
            whenToUse: agent.description,
            systemPrompt: agent.systemPrompt,
            allowedTools: agent.tools ? [...new Set(agent.tools)] : undefined,
            readOnly: agent.readOnly,
            source: "host" as const,
            id: agent.name,
        })),
        [...user.issues, ...project.issues]
    );
}
