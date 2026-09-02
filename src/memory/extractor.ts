import {randomUUID} from "node:crypto";
import {createAgentRunner, EMPTY_AGENT_INPUT_CHANNEL} from "../agent/index.js";
import {createDisabledFileCheckpointRuntime} from "../checkpoints/index.js";
import {createCompactHistoryRunner,} from "../context/compact.js";
import {createCompactSummaryGenerator} from "../context/compactSummary.js";
import {createCompactState} from "../context/index.js";
import {createLLMCaller} from "../llm/index.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {LLMSourceConnection} from "../llm/types.js";
import {EMPTY_PROJECT_INSTRUCTIONS} from "../prompt/instructions.js";
import {createToolContext} from "../runtime/toolContext.js";
import {createToolResultStore} from "../toolResults/index.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import {createToolRuntime} from "../tools/registry.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import type {MemoryFileAccess} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";

const MEMORY_AGENT_MAX_ITERATIONS = 5;
const MEMORY_AGENT_TOOLS = [
    "list_files",
    "read_file",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "delete_file",
] as const;

interface MemoryExtractionInput {
    turns: readonly {user: string; assistant: string}[];
    signal: AbortSignal;
}

export interface MemoryExtractor {
    extract(input: MemoryExtractionInput): Promise<void>;
}

export interface CreateMemoryExtractorOptions {
    storage: PillarStorageLayout;
    cwd: string;
    model: string;
    provider: LLMProviderName;
    source: LLMSourceConnection;
    shellRunner: ShellRunnerLike;
    memoryFiles: MemoryFileAccess;
}

function formatExtractionPrompt(
    directory: string,
    turns: MemoryExtractionInput["turns"]
): string {
    const conversation = turns.map((turn, index) => [
        `## Turn ${index + 1}`,
        `<user>\n${turn.user}\n</user>`,
        `<assistant>\n${turn.assistant}\n</assistant>`,
    ].join("\n\n"));
    return [
        "你是 Pillar 的持久 Memory 维护 Agent。分析最近对话，只有跨 Session 仍有价值的信息才值得保存。",
        `你只能访问这个目录：${directory}`,
        "不要读取项目源码，不要验证对话中的事实，也不要保存能从仓库直接推导的信息。",
        "",
        "维护规则：",
        "- user：用户长期背景或偏好；feedback：用户纠正或认可的工作方式；project：长期目标、动机、期限或协作背景；reference：外部资源及用途。",
        "- 不保存当前任务状态、Todo、代码结构、文件路径、工具输出、Secret 或未经用户确认的个人推断。",
        "- MEMORY.md 只是索引；主题正文位于同目录顶层的 <key>.md。先读取索引，必要时再读取相关主题。",
        "- 保存或更新必须分两步：先用 write_file/edit_file 写主题文件，再用 edit_file 更新 MEMORY.md 的一行指针。",
        "- 删除必须分两步：先完整读取并用 delete_file 删除主题文件，再从 MEMORY.md 删除对应指针。",
        "- 索引行固定为 `- [标题](topic-key.md) — 一行说明`，不得把正文写入索引。",
        "- 主题文件必须沿用现有 YAML frontmatter。新建时使用 version=1、合法 key、name、description、type、source=automatic，以及 ISO 8601 created_at/updated_at。更新时保留 created_at 并更新 updated_at。",
        "- 按主题合并既有内容，避免重复主题或活动流水。没有值得维护的 Memory 时不要修改任何文件。",
        "- 完成必要文件操作后，用一句简短文本结束；不要继续探索。",
        "",
        "## Recent conversation",
        ...conversation,
    ].join("\n");
}

/**
 * Create the restricted file Agent used by automatic Memory extraction.
 * It reuses the production Agent loop and standard file tools, while the
 * workspace boundary and MemoryFileAccess prevent access outside Memory.
 */
export function createMemoryExtractor(
    options: CreateMemoryExtractorOptions
): MemoryExtractor {
    const callLLM = createLLMCaller(options.source);
    const compactHistory = createCompactHistoryRunner({
        generateSummary: createCompactSummaryGenerator({callLLM}),
    });
    const runAgent = createAgentRunner({callLLM, compactHistory});
    const toolRuntime = createToolRuntime({
        allowedToolNames: MEMORY_AGENT_TOOLS,
    });

    return {
        async extract(input) {
            const sessionId = `memory-${randomUUID()}`;
            const ctx = createToolContext({
                signal: input.signal,
                resources: {
                    storage: options.storage,
                    cwd: options.cwd,
                    workspaceBoundary: options.memoryFiles.directory,
                    model: options.model,
                    provider: options.provider,
                    fastModel: options.model,
                    fastProvider: options.provider,
                    skills: [],
                    instructions: EMPTY_PROJECT_INSTRUCTIONS,
                    shellRunner: options.shellRunner,
                    fileState: createFileStateTracker(),
                    memoryFiles: options.memoryFiles,
                },
                session: {
                    sessionId,
                    compactState: createCompactState(),
                    toolResultStore: createToolResultStore(
                        options.storage,
                        options.cwd,
                        sessionId
                    ),
                    fileCheckpoints: createDisabledFileCheckpointRuntime(),
                },
                host: {
                    canUseTool: async () => ({
                        behavior: "deny",
                        message: "Memory Agent 不允许交互式权限确认",
                    }),
                    getPermissionRules: () => ({allow: [], ask: [], deny: []}),
                    getPermissionMode: () => "default",
                    getCollaborationMode: () => "build",
                    getPermissionPromptPolicy: () => "never",
                    setPermissionMode() {},
                    setCollaborationMode() {},
                    setTodos() {},
                },
            });
            const result = await runAgent(
                formatExtractionPrompt(options.memoryFiles.directory, input.turns),
                [{
                    role: "system",
                    content: [
                        "你是 Pillar 内部的持久 Memory 维护 Agent。",
                        "只根据给出的最近对话维护指定 Memory 目录；不要调查项目或扩展任务范围。",
                        "严格使用可用文件工具，完成必要修改后立即结束。",
                    ].join("\n"),
                }],
                () => {},
                ctx,
                EMPTY_AGENT_INPUT_CHANNEL,
                {
                    getToolSchemas: toolRuntime.getToolSchemas,
                    executeTool: toolRuntime.executeTool,
                    isToolConcurrencySafe: toolRuntime.isConcurrencySafe,
                    maxIterations: MEMORY_AGENT_MAX_ITERATIONS,
                    maxConsecutiveDeniedToolCalls: 2,
                }
            );
            if (result.reason !== "completed" && result.reason !== "no_tool_calls") {
                throw new Error(`Memory Agent 未正常完成: ${result.reason}`);
            }
        },
    };
}
