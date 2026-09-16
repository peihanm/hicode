import {useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import type {
    AgentAuthoringRuntime,
    AgentDefinition,
    AgentDefinitionDraft,
    AgentDefinitionManager,
    AgentDefinitionScope,
    StoredAgentFile,
    SubagentCatalog,
} from "../../subagents/index.js";
import {formatSubagentModel} from "../../subagents/index.js";
import {MultilineTextInput} from "../input/MultilineTextInput.js";
import {COLORS} from "../theme.js";
import {DialogIndicator, DialogItem} from "../dialogs/DialogFrame.js";
import {useTerminalWidth} from "../terminalSize.js";

type Stage =
    | "list"
    | "detail"
    | "issues"
    | "scope"
    | "method"
    | "generate"
    | "edit"
    | "delete"
    | "generating"
    | "busy"
    | "error";

interface DialogItem {
    label: string;
    value: string;
}

const EMPTY_DRAFT: AgentDefinitionDraft = {
    name: "",
    description: "",
    tools: ["list_files", "read_file", "grep"],
    model: "inherit",
    maxIterations: 12,
    systemPrompt: "",
};

const EDIT_FIELDS = [
    "name",
    "description",
    "tools",
    "model",
    "maxIterations",
    "systemPrompt",
] as const;

type EditField = typeof EDIT_FIELDS[number];

function sourceLabel(definition: AgentDefinition): string {
    if (definition.source === "builtin") return "Built-in · read-only";
    if (definition.source === "host") return "Host · read-only";
    return definition.source === "project" ? "Project" : "Personal";
}

function draftFromStored(file: StoredAgentFile): AgentDefinitionDraft {
    return {
        name: file.definition.agentType,
        description: file.definition.whenToUse,
        tools: file.definition.allowedTools,
        model: file.definition.model,
        maxIterations: file.definition.maxIterations ?? 12,
        systemPrompt: file.definition.systemPrompt,
    };
}

function fieldLabel(field: EditField): string {
    return {
        name: "Name",
        description: "Usage instructions",
        tools: "Tools (comma-separated)",
        model: "Model (inherit or fast)",
        maxIterations: "Maximum turns (2–30)",
        systemPrompt: "System Prompt (Shift+Enter for newline)",
    }[field];
}

function updateField(
    draft: AgentDefinitionDraft,
    field: EditField,
    value: string
): AgentDefinitionDraft {
    if (field === "tools") {
        return {
            ...draft,
            tools: value.split(",").map((item) => item.trim()).filter(Boolean),
        };
    }
    if (field === "maxIterations") {
        return {...draft, maxIterations: Number(value)};
    }
    if (field === "name") return {...draft, name: value};
    if (field === "description") return {...draft, description: value};
    if (field === "model") return {...draft, model: value || "inherit"};
    return {...draft, systemPrompt: value};
}

function fieldValue(draft: AgentDefinitionDraft, field: EditField): string {
    if (field === "tools") return draft.tools.join(", ");
    if (field === "maxIterations") return String(draft.maxIterations);
    if (field === "name") return draft.name;
    if (field === "description") return draft.description;
    if (field === "model") return draft.model;
    return draft.systemPrompt;
}

export function AgentsDialog({
    manager,
    authoring,
    catalog,
    fastModel,
    onClose,
}: {
    manager: AgentDefinitionManager;
    authoring: AgentAuthoringRuntime;
    catalog: SubagentCatalog;
    fastModel: string;
    onClose(): void;
}) {
    const width = Math.min(100, useTerminalWidth());
    const [stage, setStage] = useState<Stage>("list");
    const [selected, setSelected] = useState<AgentDefinition>();
    const [scope, setScope] = useState<AgentDefinitionScope>("project");
    const [stored, setStored] = useState<StoredAgentFile>();
    const [draft, setDraft] = useState<AgentDefinitionDraft>(EMPTY_DRAFT);
    const [fieldIndex, setFieldIndex] = useState(0);
    const [generateInput, setGenerateInput] = useState("");
    const [notice, setNotice] = useState<string>();
    const [error, setError] = useState<string>();
    const [errorReturnStage, setErrorReturnStage] = useState<
        "list" | "detail" | "generate" | "edit"
    >("list");
    const generationControllerRef = useRef<AbortController>();

    useEffect(() => () => {
        generationControllerRef.current?.abort("shutdown");
    }, []);

    const definitions = catalog.listDefinitions();
    const listItems = useMemo<DialogItem[]>(() => [
        ...definitions.map((definition) => ({
            label: `${definition.agentType}  ·  ${sourceLabel(definition)}`,
            value: `agent:${definition.agentType}`,
        })),
        ...(catalog.issues.length > 0
            ? [{label: `⚠ Loading issues (${catalog.issues.length})`, value: "issues"}]
            : []),
        {label: "＋ Create Agent", value: "create"},
        {label: "↻ Reload Agent files", value: "reload"},
        {label: "Close", value: "close"},
    ], [definitions, catalog.revision, catalog.issues.length]);

    useInput((_input, key) => {
        if (stage === "edit" && key.shift && key.tab) {
            setFieldIndex((index) => Math.max(0, index - 1));
            return;
        }
        if (!key.escape || stage === "busy") return;
        if (stage === "generating") {
            generationControllerRef.current?.abort("user-cancel");
            generationControllerRef.current = undefined;
            setStage("generate");
            return;
        }
        if (stage === "error") {
            setError(undefined);
            setStage(errorReturnStage);
            return;
        }
        if (stage === "list") onClose();
        else {
            setError(undefined);
            setStage("list");
        }
    });

    const fail = (
        reason: unknown,
        returnStage: "list" | "detail" | "generate" | "edit" = "list"
    ) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setErrorReturnStage(returnStage);
        setStage("error");
    };

    const reload = async () => {
        setStage("busy");
        try {
            const result = await manager.reload();
            setNotice(
                `Reload revision ${result.revision} · added ${result.added.length} · updated ${result.updated.length} · removed ${result.removed.length} · issues ${result.issues.length}`
            );
            setStage("list");
        } catch (reason) {
            fail(reason);
        }
    };

    const openDetail = async (definition: AgentDefinition) => {
        setSelected(definition);
        setStored(undefined);
        setStage("busy");
        if (definition.source === "builtin" || definition.source === "host") {
            setStage("detail");
            return;
        }
        try {
            const file = await manager.read(definition.source, definition.agentType);
            setStored(file);
            setStage("detail");
        } catch (reason) {
            fail(reason);
        }
    };

    const beginEditor = (next: AgentDefinitionDraft, file?: StoredAgentFile) => {
        setDraft(next);
        setStored(file);
        setFieldIndex(file ? 1 : 0);
        setStage("edit");
    };

    const save = async (finalDraft: AgentDefinitionDraft) => {
        setDraft(finalDraft);
        setStage("busy");
        try {
            const result = stored
                ? await manager.update(
                    stored.scope,
                    stored.definition.agentType,
                    stored.contentHash,
                    finalDraft
                )
                : await manager.create(scope, finalDraft);
            setNotice(
                `${stored ? "Updated" : "Created"} ${result.file.definition.agentType} · revision ${result.update.revision}`
            );
            setSelected(undefined);
            setStored(undefined);
            setStage("list");
        } catch (reason) {
            fail(reason, "edit");
        }
    };

    const deleteSelected = async () => {
        if (!stored) return;
        setStage("busy");
        try {
            const result = await manager.remove(
                stored.scope,
                stored.definition.agentType,
                stored.contentHash
            );
            setNotice(`Deleted ${stored.definition.agentType} · revision ${result.revision}`);
            setSelected(undefined);
            setStored(undefined);
            setStage("list");
        } catch (reason) {
            fail(reason, "detail");
        }
    };

    const field = EDIT_FIELDS[fieldIndex]!;
    const currentValue = fieldValue(draft, field);
    const submitField = (value: string) => {
        const next = updateField(draft, field, value);
        setDraft(next);
        if (fieldIndex === EDIT_FIELDS.length - 1) void save(next);
        else setFieldIndex((index) => index + 1);
    };

    return (
        <Box marginTop={1} flexDirection="column">
            <Box
                width={width}
                flexDirection="column"
                borderStyle="round"
                borderColor={COLORS.border}
                paddingX={1}
            >
                <Box>
                    <Text bold color={COLORS.accent}>◆ Agents</Text>
                    <Text color={COLORS.dim}>  Create and manage subagents</Text>
                </Box>

                {notice && stage === "list" && (
                    <Text color={COLORS.status}>{notice}</Text>
                )}

                {stage === "list" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text color={COLORS.dim}>
                            Current revision {catalog.revision} · {definitions.length} available · {catalog.issues.length} loading issues
                        </Text>
                        <SelectInput
                            items={listItems}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                            onSelect={(item: DialogItem) => {
                                if (item.value === "close") return onClose();
                                if (item.value === "create") {
                                    setStage("scope");
                                    return;
                                }
                                if (item.value === "reload") {
                                    void reload();
                                    return;
                                }
                                if (item.value === "issues") {
                                    setStage("issues");
                                    return;
                                }
                                const definition = definitions.find((candidate) =>
                                    item.value === `agent:${candidate.agentType}`
                                );
                                if (definition) void openDetail(definition);
                            }}
                        />
                    </Box>
                )}

                {stage === "issues" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text bold>Agent loading issues</Text>
                        {catalog.issues.map((issue, index) => (
                            <Box
                                key={`${issue.source === "host" ? issue.id : issue.path}:${issue.field ?? ""}:${index}`}
                                flexDirection="column"
                            >
                                <Text
                                    color={issue.severity === "error"
                                        ? COLORS.error
                                        : COLORS.warning}
                                >
                                    {issue.severity.toUpperCase()} · {issue.source} · {issue.source === "host" ? issue.id : issue.path}
                                    {issue.field ? ` · ${issue.field}` : ""}
                                </Text>
                                <Text color={COLORS.dim}>{issue.message}</Text>
                            </Box>
                        ))}
                        <SelectInput
                            items={[{label: "Back", value: "back"}]}
                            onSelect={() => setStage("list")}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                        />
                    </Box>
                )}

                {stage === "scope" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text bold>Choose save scope</Text>
                        <SelectInput
                            items={[
                                {label: "Project · .hicode/agents in this project", value: "project"},
                                {label: "Personal · ~/.hicode/agents", value: "user"},
                            ]}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                            onSelect={(item: DialogItem) => {
                                setScope(item.value as AgentDefinitionScope);
                                setStage("method");
                            }}
                        />
                    </Box>
                )}

                {stage === "method" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text bold>Creation method</Text>
                        <SelectInput
                            items={[
                                {label: "Generate with HiCode · create a candidate from a description", value: "generate"},
                                {label: "Manual · enter the definition yourself", value: "manual"},
                            ]}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                            onSelect={(item: DialogItem) => {
                                if (item.value === "generate") setStage("generate");
                                else beginEditor(EMPTY_DRAFT);
                            }}
                        />
                    </Box>
                )}

                {stage === "generate" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text bold>Describe the Agent you need</Text>
                        <Text color={COLORS.dim}>
                            Generated candidates open in the editor; they are not saved or authorized automatically.
                        </Text>
                        <MultilineTextInput
                            value={generateInput}
                            onChange={setGenerateInput}
                            onSubmit={(value) => {
                                const controller = new AbortController();
                                generationControllerRef.current = controller;
                                setStage("generating");
                                void authoring.generate(value, controller.signal).then((candidate) => {
                                    generationControllerRef.current = undefined;
                                    if (controller.signal.aborted) return;
                                    beginEditor(candidate);
                                }).catch((reason) => {
                                    generationControllerRef.current = undefined;
                                    if (controller.signal.aborted) {
                                        setStage("generate");
                                    } else fail(reason, "generate");
                                });
                            }}
                            width={width - 4}
                            maxRows={6}
                        />
                    </Box>
                )}

                {stage === "edit" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text bold>{stored ? "Edit" : "Create"} Agent · {fieldLabel(field)}</Text>
                        <Text color={COLORS.dim}>
                            Step {fieldIndex + 1}/{EDIT_FIELDS.length} · Enter next · Shift+Tab previous · Esc cancel
                        </Text>
                        {field === "systemPrompt" ? (
                            <MultilineTextInput
                                value={currentValue}
                                onChange={(value) => setDraft(updateField(draft, field, value))}
                                onSubmit={submitField}
                                width={width - 4}
                                maxRows={10}
                            />
                        ) : (
                            <Box>
                                <Text color={COLORS.accent}>❯ </Text>
                                <TextInput
                                    value={currentValue}
                                    onChange={(value) => setDraft(updateField(draft, field, value))}
                                    onSubmit={submitField}
                                />
                            </Box>
                        )}
                    </Box>
                )}

                {stage === "detail" && selected && (
                    <Box marginTop={1} flexDirection="column">
                        <Text bold>{selected.agentType} · {sourceLabel(selected)}</Text>
                        <Text>{selected.whenToUse}</Text>
                        <Text color={COLORS.dim}>
                            Model {formatSubagentModel(selected.model, "Inherit Root", fastModel)} · maximum turns {selected.maxIterations ?? "Follow Root"}
                        </Text>
                        <Text color={COLORS.dim}>Tools · {selected.allowedTools.join(", ")}</Text>
                        <SelectInput
                            items={selected.source === "builtin" || selected.source === "host"
                                ? [{label: "Back", value: "back"}]
                                : [
                                    {label: "Edit", value: "edit"},
                                    {label: "Delete", value: "delete"},
                                    {label: "Back", value: "back"},
                                ]}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                            onSelect={(item: DialogItem) => {
                                if (item.value === "edit" && stored) {
                                    beginEditor(draftFromStored(stored), stored);
                                } else if (item.value === "delete") {
                                    setStage("delete");
                                } else setStage("list");
                            }}
                        />
                    </Box>
                )}

                {stage === "delete" && selected && (
                    <Box marginTop={1} flexDirection="column">
                        <Text color={COLORS.warning}>
                            Confirm deletion of {selected.agentType}? This deletes the corresponding Markdown file.
                        </Text>
                        <SelectInput
                            items={[
                                {label: "Cancel", value: "cancel"},
                                {label: "Confirm deletion", value: "delete"},
                            ]}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                            onSelect={(item: DialogItem) => {
                                if (item.value === "delete") void deleteSelected();
                                else setStage("detail");
                            }}
                        />
                    </Box>
                )}

                {stage === "busy" && (
                    <Box marginTop={1}><Text color={COLORS.dim}>Processing…</Text></Box>
                )}

                {stage === "generating" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text color={COLORS.dim}>Generating Agent candidate…</Text>
                        <Text color={COLORS.dim}>Esc cancel generation</Text>
                    </Box>
                )}

                {stage === "error" && (
                    <Box marginTop={1} flexDirection="column">
                        <Text color={COLORS.error}>Operation failed: {error}</Text>
                        <SelectInput
                            items={[{
                                label: errorReturnStage === "edit"
                                    ? "Back to editing"
                                    : errorReturnStage === "generate"
                                        ? "Back to generation input"
                                        : errorReturnStage === "detail"
                                            ? "Back to Agent details"
                                            : "Back to Agent list",
                                value: "back",
                            }]}
                            indicatorComponent={DialogIndicator}
                            itemComponent={DialogItem}
                            onSelect={() => {
                                setError(undefined);
                                setStage(errorReturnStage);
                            }}
                        />
                    </Box>
                )}
            </Box>
            <Text color={COLORS.dim}>Esc back or close</Text>
        </Box>
    );
}
