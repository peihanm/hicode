import {Box, Static, Text} from "ink";
import stringWidth from "string-width";
import type {UIThread} from "./types.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {FileChangeGroup} from "../fileChanges/FileChangeGroup.js";
import {Welcome} from "../bootstrap/Welcome.js";
import {type InputRow, layoutInputRows} from "../input/MultilineTextInput.js";
import {parseVerificationSummary} from "../../subagents/builtins/verification/index.js";
import {TerminalMarkdown} from "./TerminalMarkdown.js";
import {useTerminalWidth} from "../terminalSize.js";
import {
    describeToolCall,
    isSuccessfulToolActivity,
    summarizeToolResult,
} from "../../tools/presentation.js";

type ToolCallThread = Extract<UIThread, {role: "tool_call"}>;

interface ActivityGroup {
    kind: "activity_group";
    id: string;
    calls: ToolCallThread[];
}

interface AgentBatch {
    kind: "agent_batch";
    id: string;
    calls: ToolCallThread[];
}

type ConversationItem = UIThread | ActivityGroup | AgentBatch;

function isToolCall(item: UIThread): item is ToolCallThread {
    return item.role === "tool_call";
}

/** 默认投影只折叠成功的只读探索；失败、拒绝和取消始终保留原始行。 */
export function projectDefaultThreads(threads: UIThread[]): ConversationItem[] {
    const items: ConversationItem[] = [];
    for (let index = 0; index < threads.length;) {
        const thread = threads[index]!;
        if (isToolCall(thread) && thread.hiddenByFileChange) {
            index += 1;
            continue;
        }
        if (isToolCall(thread) && isSuccessfulToolActivity(thread)) {
            const calls: ToolCallThread[] = [];
            while (index < threads.length) {
                const candidate = threads[index]!;
                if (!isToolCall(candidate) || !isSuccessfulToolActivity(candidate)) {
                    break;
                }
                calls.push(candidate);
                index += 1;
            }
            const visibleCalls = calls.filter(
                (call) => describeToolCall(call.name, call.args).activity?.kind !== "silent"
            );
            if (visibleCalls.length >= 2) {
                items.push({
                    kind: "activity_group",
                    id: `activity:${calls[0]!.id}:${calls.at(-1)!.id}`,
                    calls,
                });
            } else if (visibleCalls.length === 1) {
                items.push(visibleCalls[0]!);
            }
            continue;
        }
        if (isToolCall(thread) && thread.name === "agent") {
            const calls: ToolCallThread[] = [];
            const turnId = thread.turnId;
            while (index < threads.length) {
                const candidate = threads[index]!;
                if (
                    !isToolCall(candidate) ||
                    candidate.name !== "agent" ||
                    candidate.turnId !== turnId
                ) {
                    break;
                }
                calls.push(candidate);
                index += 1;
            }
            if (calls.length > 1) {
                items.push({
                    kind: "agent_batch",
                    id: `agents:${calls[0]!.id}:${calls.at(-1)!.id}`,
                    calls,
                });
            } else {
                items.push(calls[0]!);
            }
            continue;
        }
        items.push(thread);
        index += 1;
    }
    return items;
}

const MIN_USER_MESSAGE_TAIL_WIDTH = 12;

/**
 * Ink 会按终端最右侧机械折行，长中文提问可能只剩一两个词悬在末行。
 * 在没有显式换行时把少量字从倒数第二行移到短尾行，避免这种 widow。
 */
export function layoutUserMessageRows(
    text: string,
    terminalWidth: number
): InputRow[] {
    const contentWidth = Math.max(8, terminalWidth - 2);
    const rows = layoutInputRows(text, contentWidth);
    if (rows.length < 2 || /[\r\n]/.test(text)) return rows;

    const last = rows.at(-1)!;
    const previous = rows.at(-2)!;
    const targetTailWidth = Math.min(
        MIN_USER_MESSAGE_TAIL_WIDTH,
        Math.floor(contentWidth / 3)
    );
    let tailWidth = stringWidth(last.text);
    if (tailWidth === 0 || tailWidth >= targetTailWidth) return rows;

    const segments = Array.from(
        new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(previous.text)
    );
    let boundary = previous.end;
    for (let index = segments.length - 1; index >= 0 && tailWidth < targetTailWidth; index--) {
        const segment = segments[index]!;
        boundary = previous.start + segment.index;
        tailWidth += stringWidth(segment.segment);
    }
    if (boundary <= previous.start) return rows;

    return [
        ...rows.slice(0, -2),
        {
            start: previous.start,
            end: boundary,
            text: text.slice(previous.start, boundary),
        },
        {
            start: boundary,
            end: last.end,
            text: text.slice(boundary, last.end),
        },
    ];
}

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
                        line={`Full output: read_tool_result(${thread.resultId})`}
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
    const verificationSummary =
        thread.subagentVerificationVerdict && thread.subagentReport
            ? parseVerificationSummary(
                thread.subagentReport,
                thread.subagentVerificationVerdict
            )
            : undefined;
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
            {verificationSummary && (
                <Box marginLeft={2}>
                    <Text color={COLORS.dim}>└ </Text>
                    <Text color={COLORS.toolResult}>{verificationSummary}</Text>
                </Box>
            )}
            {transcript && thread.subagentReport && (
                <Box marginLeft={2} marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>
                        {thread.subagentName
                            ? `${thread.subagentName} (fork)`
                            : thread.subagentType ?? "Agent"} response
                    </Text>
                    <Text color={COLORS.toolResult}>{thread.subagentReport}</Text>
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

function formatCount(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function ActivityGroupView({group}: {group: ActivityGroup}) {
    const presentations = group.calls.map((call) =>
        describeToolCall(call.name, call.args)
    );
    const reads = new Set(
        presentations
            .filter((item) => item.activity?.kind === "read")
            .map((item) => item.activity?.target ?? "file")
    ).size;
    const searches = presentations.filter(
        (item) => item.activity?.kind === "search"
    ).length;
    const lists = new Set(
        presentations
            .filter((item) => item.activity?.kind === "list")
            .map((item) => item.activity?.target ?? "directory")
    ).size;
    const running = group.calls.some((call) => call.status === "running");
    const parts = [
        searches > 0
            ? `${running ? "searching" : "searched"} ${formatCount(searches, "pattern", "patterns")}`
            : undefined,
        reads > 0
            ? `${running ? "reading" : "read"} ${formatCount(reads, "file", "files")}`
            : undefined,
        lists > 0
            ? `${running ? "listing" : "listed"} ${formatCount(lists, "directory", "directories")}`
            : undefined,
    ].filter((part): part is string => Boolean(part));
    const latest = [...presentations].reverse().find(
        (item) => item.activity?.kind !== "silent" && item.activity?.target
    )?.activity?.target;
    return (
        <Box marginTop={1} flexDirection="column">
            <Box>
                <Text color={running ? COLORS.accent : COLORS.dim}>
                    {running ? `${SYMBOLS.assistantMark} ` : "  "}
                </Text>
                <Text color={COLORS.dim}>
                    {parts.join(", ")}{running ? "…" : ""}
                </Text>
            </Box>
            {running && latest && (
                <Box marginLeft={2}>
                    <Text color={COLORS.dim}>⎿ {latest}</Text>
                </Box>
            )}
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
    if ("kind" in item && item.kind === "activity_group") {
        return <ActivityGroupView group={item}/>;
    }
    if ("kind" in item && item.kind === "agent_batch") {
        return <AgentBatchView batch={item} transcript={transcript}/>;
    }
    const thread = item as UIThread;
    if (thread.role === "user") {
        const rows = layoutUserMessageRows(thread.text, terminalWidth);
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
        return (
            <Box marginTop={1} alignItems="flex-start">
                <Text color={COLORS.assistant}>{SYMBOLS.assistantMark} </Text>
                <Box
                    flexDirection="column"
                    flexGrow={1}
                    borderStyle="single"
                    borderTop={false}
                    borderRight={false}
                    borderBottom={false}
                    borderLeftColor={COLORS.border}
                    borderLeftDimColor
                    paddingLeft={1}
                >
                    <TerminalMarkdown
                        value={thread.text}
                        width={Math.max(20, terminalWidth - 5)}
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

/**
 * 已完成输出交给 Ink Static。这样长 diff 会真正追加到终端滚动区，
 * 而不是让 Ink 对整段历史反复原地重绘（后者会造成光标停在中部和日志重复）。
 */
type StaticListItem =
    | { kind: "welcome"; id: "welcome" }
    | { kind: "thread"; id: string; item: ConversationItem };

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
    // Ink 的 reconciler 每个 root 只保存一个 staticNode。Welcome 和完成消息
    // 必须共享同一个 Static，否则后挂载的消息 Static 会覆盖欢迎框。
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

export function TranscriptDetails({threads}: {threads: UIThread[]}) {
    const toolCalls = threads.filter(isToolCall);
    const fileChanges = threads.filter(
        (thread): thread is Extract<UIThread, { role: "file_change_group" }> =>
            thread.role === "file_change_group"
    );
    if (toolCalls.length === 0 && fileChanges.length === 0) return null;
    return (
        <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS.dim}>Transcript · Ctrl+O to close</Text>
            {toolCalls.map((thread) => (
                <ToolCallView
                    key={`transcript:${thread.id}`}
                    thread={thread}
                    paused
                    transcript
                    includeHidden
                />
            ))}
            {fileChanges.map((thread) => (
                <FileChangeGroup
                    key={`details:${thread.id}`}
                    changes={thread.changes}
                    expanded
                />
            ))}
        </Box>
    );
}
