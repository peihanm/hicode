import {Box, Static, Text} from "ink";
import type {UIThread} from "./types.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {Welcome} from "../bootstrap/Welcome.js";
import {FileChangeGroup} from "../fileChanges/FileChangeGroup.js";
import {TerminalMarkdown} from "./TerminalMarkdown.js";
import {useTerminalWidth} from "../terminalSize.js";
import {
    describeToolCall,
    summarizePhaseToolCall,
    summarizeToolResult,
} from "../../tools/presentation.js";
import {limitTerminalText} from "./presentationLimits.js";
import {
    type AgentBatch,
    type ConversationItem,
    isToolCall,
    layoutUserMessageRows,
    type PhaseGroup,
    projectDefaultThreads,
    type ToolCallThread,
} from "./projection.js";

const MAX_USER_DISPLAY_CHARS = 100_000;
const MAX_ASSISTANT_DISPLAY_CHARS = 200_000;
const MAX_SUBAGENT_REPORT_DISPLAY_CHARS = 20_000;
function agentIdentity(
    thread: Extract<UIThread, { role: "tool_call" }>
): { type: string; description?: string } | undefined {
    if (thread.name !== "agent") return undefined;
    try {
        const parsed = JSON.parse(thread.args) as Record<string, unknown>;
        const type = thread.subagentName
            ? `${thread.subagentName} (fork)`
            : thread.subagentType ??
            (typeof parsed.subagent_type === "string"
                ? parsed.subagent_type
                : "Agent");
        return {
            type,
            ...(typeof parsed.description === "string"
                ? {description: parsed.description}
                : {}),
        };
    } catch {
        return {
            type: thread.subagentName
                ? `${thread.subagentName} (fork)`
                : thread.subagentType ?? "Agent",
        };
    }
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
                         }: {
    thread: ToolCallThread;
    transcript: boolean;
}) {
    if (!thread.result) return null;
    const lines = transcript
        ? transcriptResultLines(thread.result)
        : summarizeToolResult(thread.name, thread.result, thread.outcome);
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
        : thread.status === "cancelled"
            ? "cancelled"
            : "failed";
    const kind = thread.kind === "agent" ? "Background Agent" : "Background task";
    const label = thread.kind === "shell"
        ? describeToolCall("bash", JSON.stringify({command: thread.label})).detail
        : thread.label;
    const color = thread.status === "failed" ? COLORS.error : COLORS.toolName;
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
                        line="完整输出见任务详情"
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
                          includeHidden = false,
                      }: {
    thread: ToolCallThread;
    paused: boolean;
    transcript: boolean;
    includeHidden?: boolean;
}) {
    if (thread.hiddenByFileChange && !includeHidden) return null;
    const agent = agentIdentity(thread);
    const presentation = describeToolCall(thread.name, thread.args);
    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                <Text color={paused ? COLORS.assistant : COLORS.accent}>
                    {SYMBOLS.assistantMark}
                </Text>
                <Text color={COLORS.toolName} bold>
                    {" "}
                    {agent ? `${agent.type} Agent` : presentation.label}
                </Text>
                {agent?.description ? (
                    <Text color={COLORS.toolArgs}> · {agent.description}</Text>
                ) : (
                    presentation.detail ? <>
                        <Text color={COLORS.dim}> </Text>
                        <Text color={COLORS.toolArgs}>{presentation.detail}</Text>
                    </> : null
                )}
            </Box>
            {agent && <AgentProgress thread={thread} transcript={transcript}/>}
            <ToolResultLines thread={thread} transcript={transcript}/>
            {transcript && thread.subagentReport && (
                <Box marginLeft={2} marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>
                        {thread.subagentName
                            ? `${thread.subagentName} (fork)`
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
        const summary = summarizePhaseToolCall(call);
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

function AgentBatchView({batch, transcript}: {batch: AgentBatch; transcript: boolean}) {
    const running = batch.calls.some((call) => call.status === "running");
    return (
        <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.toolName} bold>
                {SYMBOLS.assistantMark} {running
                    ? `Running ${batch.calls.length} agents…`
                    : `${batch.calls.length} agents finished`}
            </Text>
            {batch.calls.map((call, index) => {
                const identity = agentIdentity(call);
                const branch = index === batch.calls.length - 1 ? "└─" : "├─";
                return (
                    <Box key={call.id} marginLeft={2} flexDirection="column">
                        <Text color={COLORS.toolResult}>
                            {branch} {identity?.type ?? "Agent"} · {identity?.description ?? "task"}
                        </Text>
                        <Box marginLeft={3}>
                            <Text color={COLORS.dim}>
                                ⎿ {call.status === "running"
                                    ? `${call.subagentToolUseCount ?? call.subagentProgress?.length ?? 0} tool uses${call.subagentTokenCount ? ` · ${call.subagentTokenCount} tokens` : ""}`
                                    : call.result ?? "Done"}
                            </Text>
                        </Box>
                        {transcript && <AgentProgress thread={call} transcript/>}
                    </Box>
                );
            })}
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
    if ("kind" in item && item.kind === "agent_batch") {
        return <AgentBatchView batch={item} transcript={transcript}/>;
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
        />
    );
}

// 消息列表：codebuddy 风格标记
// 用户：    ❯ {text}
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

/**
 * 已完成输出只追加到主屏幕 scrollback；进行中的内容留在 live 区更新。
 * 这样 resume 后使用终端原生滚轮、滚动条和文本选择，不接管鼠标协议。
 */
export function StaticMessageList({
                                      threads,
                                      showWelcome = false,
                                      terminalWidth: widthOverride,
                                  }: {
    threads: UIThread[];
    showWelcome?: boolean;
    terminalWidth?: number;
}) {
    const terminalWidth = useTerminalWidth(widthOverride);
    const items: StaticListItem[] = [
        ...(showWelcome
            ? [{kind: "welcome" as const, id: "welcome" as const}]
            : []),
        ...projectDefaultThreads(threads).map((item) => ({
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
                        transcript={false}
                        terminalWidth={terminalWidth}
                    />
                )
            }
        </Static>
    );
}

export function TranscriptDetails({
                                      threads,
                                      terminalWidth,
                                  }: {
    threads: UIThread[];
    terminalWidth?: number;
}) {
    const details = threads.filter(
        (thread): thread is
            | ToolCallThread
            | Extract<UIThread, {role: "file_change_group"}> =>
            isToolCall(thread) || thread.role === "file_change_group"
    );
    if (details.length === 0) return null;
    return (
        <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS.dim}>Transcript · Ctrl+O to close</Text>
            {details.map((thread) =>
                thread.role === "tool_call" ? (
                    <ToolCallView
                        key={`transcript:${thread.id}`}
                        thread={thread}
                        paused
                        transcript
                        includeHidden
                    />
                ) : (
                    <FileChangeGroup
                        key={`details:${thread.id}`}
                        changes={thread.changes}
                        expanded
                        terminalWidth={terminalWidth}
                    />
                )
            )}
        </Box>
    );
}
