import {Box, Static, Text} from "ink";
import type {UIThread} from "./types.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {Welcome} from "../bootstrap/Welcome.js";
import {FileChangeGroup} from "../fileChanges/FileChangeGroup.js";
import {TerminalMarkdown} from "./TerminalMarkdown.js";
import {useTerminalWidth} from "../terminalSize.js";
import {
    describeToolCall,
    isBackgroundAgentCall,
    summarizePhaseToolCall,
    summarizeToolResult,
} from "../../tools/presentation.js";
import {documentRead} from "./documentRead.js";
import {
    type ConversationItem,
    layoutUserMessageRows,
    type PhaseGroup,
    projectDefaultThreads,
    type ToolCallThread,
} from "./projection.js";

const MAX_USER_DISPLAY_CHARS = 100_000;
const MAX_ASSISTANT_DISPLAY_CHARS = 200_000;
const MAX_SUBAGENT_REPORT_DISPLAY_CHARS = 20_000;
function agentIdentity(thread: ToolCallThread): {
    name: string; background: boolean; description?: string; delivery?: "started" | "continued" | "queued";
} | undefined {
    if (thread.name !== "agent" && thread.name !== "agent_followup") return undefined;
    const receipt = thread.outcome === "ok" && thread.uiData?.type === "agent_receipt" ? thread.uiData.receipt : undefined;
    let parsed: Record<string, unknown> = {};
    try {const value: unknown = JSON.parse(thread.args); if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;} catch {}
    const name = receipt?.name ?? thread.subagentName ?? (thread.name === "agent"
        ? typeof parsed.name === "string" ? parsed.name : thread.subagentType ?? (typeof parsed.subagent_type === "string" ? parsed.subagent_type : "Worker")
        : "");
    let description = receipt?.description ?? (typeof parsed.description === "string" ? parsed.description : undefined);
    description = description?.replace(/\s+/g, " ").trim();
    for (const separator of [":", "："]) {
        if (name && description?.startsWith(name + separator)) description = description.slice(name.length + separator.length).trimStart();
    }
    return {name, description,
        background: thread.name === "agent_followup" || isBackgroundAgentCall(thread.name, thread.args),
        delivery: receipt?.delivery,
    };
}

function transcriptResultLines(result: string): string[] {
    const lines = result.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length <= 100 && result.length <= 20_000) return lines;
    const visible: string[] = [];
    let characters = 0;
    for (const line of lines) {
        if (visible.length >= 100 || characters + line.length > 20_000) break;
        visible.push(line);
        characters += line.length;
    }
    visible.push(
        `… result truncated in TUI (${lines.length - visible.length} more lines; use saved result or Session transcript)`
    );
    return visible;
}

function ResultLine({
                        line,
                        marker = "⎿",
                        color = COLORS.toolResult,
                    }: {
    line: string;
    marker?: string;
    color?: string;
}) {
    return (
        <Box>
            <Box width={2} flexShrink={0}>
                <Text color={COLORS.dim}>{marker}</Text>
            </Box>
            <Box flexGrow={1}>
                <Text color={color}>{line || " "}</Text>
            </Box>
        </Box>
    );
}

function ToolResultLines({
                             thread,
                             transcript,
                             terminalWidth,
                         }: {
    thread: ToolCallThread;
    transcript: boolean;
    terminalWidth: number;
}) {
    if (!thread.result) return null;
    const document = transcript ? documentRead(thread) : undefined;
    if (document) {
        return <Box marginLeft={2} flexDirection="column">
            <TerminalMarkdown value={transcriptResultLines(document.body).join("\n")} width={Math.max(1, terminalWidth - 2)}/>
            {thread.persisted && <Text color={COLORS.dim}>{`saved as ${thread.persisted.resultId}${thread.persisted.complete ? "" : " (partial)"}`}</Text>}
        </Box>;
    }
    const agent = agentIdentity(thread);
    if (!transcript && agent?.background && thread.outcome === "ok") {
        const status = agent.delivery === "queued" ? "Queued" : agent.delivery === "continued" ? "Continued"
            : thread.name === "agent" ? "Started" : "Assignment accepted";
        return <Box marginLeft={2}><Text color={COLORS.dim}>{status} · /tasks</Text></Box>;
    }
    const lines = transcript
        ? transcriptResultLines(thread.result)
        : thread.name === "skill" && thread.status === "done" && thread.outcome === "ok"
        ? ["Instructions loaded · ctrl+o to expand"]
        : summarizeToolResult(thread.name, thread.result);
    const color = thread.outcome && thread.outcome !== "ok"
        ? COLORS.error
        : COLORS.toolResult;
    return (
        <Box marginLeft={2} flexDirection="column">
            {lines.map((line, index) => (
                <ResultLine
                    key={`${index}:${line.slice(0, 40)}`}
                    line={line}
                    marker={index === 0 ? "⎿" : ""}
                    color={color}
                />
            ))}
            {thread.persisted && (
                <Text color={COLORS.dim}>
                    {`  saved as ${thread.persisted.resultId}${thread.persisted.complete ? "" : " (partial)"}`}
                </Text>
            )}
        </Box>
    );
}

function TaskNotificationView({
                                  thread,
                              }: {
    thread: Extract<UIThread, {role: "task_notification"}>;
}) {
    const state = thread.status === "completed"
        ? "completed"
        : thread.status === "interrupted"
            ? "interrupted"
            : thread.status === "cancelled"
            ? "cancelled"
            : "failed";
    const kind = thread.kind === "agent" ? "Background Agent" : "Background task";
    const label = thread.kind === "shell"
        ? describeToolCall("bash", JSON.stringify({command: thread.label})).detail
        : thread.label;
    const color = thread.status === "failed" ? COLORS.error : COLORS.toolName;
    if (thread.kind === "agent") return <Box marginTop={1}><Text color={color} wrap="truncate-end">{`${thread.status === "completed" ? "✓" : "●"} ${label} · ${state} · /tasks`}</Text></Box>;
    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                <Text color={color}>{SYMBOLS.assistantMark}</Text>
                <Text color={COLORS.toolName} bold>
                    {` ${kind} ${state}`}
                </Text>
                <Text color={COLORS.toolArgs}> · {label}</Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
                <ResultLine line={thread.summary} color={color}/>
                {thread.resultId && (
                    <ResultLine
                        marker=""
                        line="Full output is available in task details"
                        color={COLORS.dim}
                    />
                )}
            </Box>
        </Box>
    );
}

function AgentProgress({
                           thread,
                           transcript,
                       }: {
    thread: ToolCallThread;
    transcript: boolean;
}) {
    if (agentIdentity(thread)?.background) return null;
    const progress = thread.subagentProgress ?? [];
    if (progress.length === 0 || (thread.status === "done" && !transcript)) {
        return null;
    }
    const visible = transcript ? progress : progress.slice(-3);
    const hidden = progress.length - visible.length;
    return (
        <Box marginLeft={2} flexDirection="column">
            {hidden > 0 && (
                <Text color={COLORS.dim}>
                    {`+${hidden} more tool use${hidden === 1 ? "" : "s"} (ctrl+o to expand)`}
                </Text>
            )}
            {visible.map((item) => {
                const presentation = describeToolCall(item.name, item.args);
                return (
                    <Box key={item.toolCallId}>
                        <Text color={COLORS.dim}>⎿ </Text>
                        <Text color={COLORS.toolResult}>
                            {presentation.label}{presentation.detail ? ` ${presentation.detail}` : ""}
                        </Text>
                    </Box>
                );
            })}
        </Box>
    );
}

function ToolCallView({
                          thread,
                          paused,
                          transcript,
                          terminalWidth,
                          includeHidden = false,
                      }: {
    thread: ToolCallThread;
    paused: boolean;
    transcript: boolean;
    terminalWidth: number;
    includeHidden?: boolean;
}) {
    if (thread.hiddenByFileChange && !includeHidden) return null;
    const agent = agentIdentity(thread);
    const presentation = describeToolCall(thread.name, thread.args);
    const document = documentRead(thread);
    if (document) presentation.detail = document.detail;
    return (
        <Box flexDirection="column" marginTop={1}>
            {agent ? <Text wrap="truncate-end">
                <Text color={paused ? COLORS.assistant : COLORS.accent}>{SYMBOLS.assistantMark} </Text>
                <Text color={COLORS.toolName} bold>{`Agent${agent.name ? ` ${agent.name}` : ""}`}</Text>
                {agent.description && <Text color={COLORS.toolArgs}> · {agent.description}</Text>}
            </Text> : <Box>
                <Text color={paused ? COLORS.assistant : COLORS.accent}>{SYMBOLS.assistantMark}</Text>
                <Text color={COLORS.toolName} bold> {presentation.label}</Text>
                {presentation.detail && <>
                    <Text color={COLORS.dim}> </Text>
                    <Text color={COLORS.toolArgs}>{presentation.detail}</Text>
                </>}
            </Box>}
            {agent && <AgentProgress thread={thread} transcript={transcript}/>}
            <ToolResultLines thread={thread} transcript={transcript} terminalWidth={terminalWidth}/>
            {transcript && thread.subagentReport && (
                <Box marginLeft={2} marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>
                        {thread.subagentName
                            ? `${thread.subagentName} (${thread.subagentType ?? "Worker"})`
                            : thread.subagentType ?? "Agent"} response
                    </Text>
                    <Text color={COLORS.toolResult}>
                        {limitTerminalText(
                            thread.subagentReport,
                            MAX_SUBAGENT_REPORT_DISPLAY_CHARS,
                            "Subagent report"
                        )}
                    </Text>
                    {thread.subagentTranscriptPath && (
                        <Text color={COLORS.dim}>
                            transcript: {thread.subagentTranscriptPath}
                        </Text>
                    )}
                </Box>
            )}
        </Box>
    );
}

function PhaseGroupView({group}: {group: PhaseGroup}) {
    const calls = group.calls.flatMap((call) => {
        const summary = documentRead(call)?.summary ?? summarizePhaseToolCall(call);
        return summary ? [{call, summary}] : [];
    });
    const running = calls.some(({call}) => call.status === "running");
    return (
        <Box marginTop={1} flexDirection="column">
            <Box>
                <Text color={running ? COLORS.accent : COLORS.assistant}>
                    {SYMBOLS.assistantMark}
                </Text>
                <Text color={COLORS.toolName} bold>
                    {` ${group.label}`}
                </Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
                {calls.map(({call, summary}) => (
                    <Box key={call.id}>
                        <Text color={call.status === "running" ? COLORS.accent : COLORS.diffAdded}>
                            {call.status === "running" ? "… " : "✓ "}
                        </Text>
                        <Text color={COLORS.toolResult}>{summary}</Text>
                    </Box>
                ))}
            </Box>
        </Box>
    );
}

function ThreadView({
                        item,
                        paused,
                        transcript,
                        terminalWidth,
                    }: {
    item: ConversationItem;
    paused: boolean;
    transcript: boolean;
    terminalWidth: number;
}) {
    if ("kind" in item && item.kind === "phase_group") {
        return <PhaseGroupView group={item}/>;
    }
    const thread = item as UIThread;
    if (thread.role === "user") {
        const rows = layoutUserMessageRows(
            limitTerminalText(
                thread.text,
                MAX_USER_DISPLAY_CHARS,
                "User message"
            ),
            terminalWidth
        );
        return (
            <Box marginTop={1} flexDirection="column">
                {rows.map((row, index) => (
                    <Box key={`${row.start}-${index}`}>
                        <Text color={COLORS.user} bold>
                            {index === 0 ? `${SYMBOLS.userMark} ` : "  "}
                        </Text>
                        <Text>{row.text}</Text>
                    </Box>
                ))}
            </Box>
        );
    }
    if (thread.role === "assistant") {
        const text = limitTerminalText(
            thread.text,
            MAX_ASSISTANT_DISPLAY_CHARS,
            "Assistant response"
        );
        const visibleWidth = Math.max(1, terminalWidth - 3);
        return (
            <Box
                marginTop={1}
                alignItems="flex-start"
                width={Math.max(1, terminalWidth - 1)}
            >
                <Text color={COLORS.assistant}>{SYMBOLS.assistantMark} </Text>
                <Box
                    flexDirection="column"
                    flexGrow={1}
                >
                    <TerminalMarkdown
                        value={text}
                        width={visibleWidth}
                    />
                </Box>
            </Box>
        );
    }
    if (thread.role === "hook") {
        const {execution} = thread;
        const failed = execution.outcome === "error" || execution.outcome === "skipped_budget";
        return <Box marginTop={1} flexDirection="column">
            <Text color={failed ? COLORS.error : COLORS.dim}>
                {thread.status === "running" ? "…" : failed ? "!" : "✓"} Hook {execution.event} · {execution.handler}
                {execution.durationMs === undefined ? "" : ` · ${Math.round(execution.durationMs)}ms`}
            </Text>
            {(execution.userMessage || execution.message) && <Text color={failed ? COLORS.error : COLORS.dim}>
                {execution.userMessage ?? execution.message}
            </Text>}
        </Box>;
    }
    if (thread.role === "coordination_message") return <Box marginTop={1} flexDirection="column"><Text color={COLORS.dim}>● Agent message received · /tasks</Text>{transcript && <TerminalMarkdown value={thread.text} width={Math.max(1, terminalWidth - 2)}/>}</Box>;
    if (thread.role === "task_notification") {
        return <TaskNotificationView thread={thread}/>;
    }
    if (thread.role === "file_change_group") {
        return (
            <FileChangeGroup
                changes={thread.changes}
                expanded={transcript}
                terminalWidth={terminalWidth}
            />
        );
    }
    return (
        <ToolCallView
            thread={thread}
            paused={paused}
            transcript={transcript}
            terminalWidth={terminalWidth}
            includeHidden={transcript}
        />
    );
}

// Message list markers.
// User: ❯ {text}
// assistant：● {text}
export function MessageList({
                                threads,
                                paused = false,
                                transcript = false,
                                terminalWidth: widthOverride,
                            }: {
    threads: UIThread[];
    paused?: boolean;
    transcript?: boolean;
    terminalWidth?: number;
}) {
    const terminalWidth = useTerminalWidth(widthOverride);
    return (
        <Box flexDirection="column">
            {(transcript ? threads : projectDefaultThreads(threads)).map((item) => (
                <ThreadView
                    key={item.id}
                    item={item}
                    paused={paused}
                    transcript={transcript}
                    terminalWidth={terminalWidth}
                />
            ))}
        </Box>
    );
}

type StaticListItem =
    | {kind: "welcome"; id: "welcome"}
    | {kind: "thread"; id: string; item: ConversationItem};

/** Append-only output for redirected streams; interactive replay is owned by ScrollbackTranscript. */
export function StaticMessageList({
                                      threads,
                                      showWelcome = false,
                                      transcript = false,
                                      terminalWidth: widthOverride,
                                  }: {
    threads: UIThread[];
    showWelcome?: boolean;
    transcript?: boolean;
    terminalWidth?: number;
}) {
    const terminalWidth = useTerminalWidth(widthOverride);
    const items: StaticListItem[] = [
        ...(showWelcome
            ? [{kind: "welcome" as const, id: "welcome" as const}]
            : []),
        ...(transcript ? threads : projectDefaultThreads(threads)).map((item) => ({
            kind: "thread" as const,
            id: item.id,
            item,
        })),
    ];
    return (
        <Static items={items}>
            {(item) =>
                item.kind === "welcome" ? (
                    <Welcome key={item.id}/>
                ) : (
                    <ThreadView
                        key={item.id}
                        item={item.item}
                        paused
                        transcript={transcript}
                        terminalWidth={terminalWidth}
                    />
                )
            }
        </Static>
    );
}

function limitTerminalText(
    value: string,
    maxCharacters: number,
    label: string
): string {
    if (value.length <= maxCharacters) return value;
    return `${value.slice(0, maxCharacters)}\n\n[${label} truncated in terminal view]`;
}
