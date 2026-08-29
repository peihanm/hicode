import type {Message} from "../llm/types.js";

export function buildCompactPrompt(customInstructions?: string): string {
    const instructions = customInstructions?.trim()
        ? `\n\n额外总结要求：\n${customInstructions.trim()}`
        : "";

    return `关键要求：只输出纯文本，不要调用任何工具。

- 不要使用 read_file、bash、grep、edit_file、write_file 或任何其他工具。
- 你已经拥有上方对话中的全部上下文。
- 工具调用会被拒绝，并浪费本次唯一的总结机会。
- 你的完整输出必须先包含一个 <analysis> 草稿区，然后包含一个 <summary> 正式摘要区。

你的任务是为当前 pillar-agent 会话创建一份详细摘要。摘要会替换较早的历史消息，因此必须足够完整，让后续模型只看摘要和保留的近期消息，也能无缝继续开发工作。

在写正式摘要前，请先用 <analysis> 标签组织你的分析。分析时按时间顺序检查每段对话，并彻底识别：

1. 用户的明确请求、真实意图和后续修正。
2. 你采取过的处理思路、方案取舍和关键决策。
3. 重要技术概念、架构约定、代码模式、API、配置项和命令。
4. 具体细节，尤其是：
   - 文件名和路径
   - 函数、类型、接口、命令、环境变量
   - 已读取、已修改、已创建的文件
   - 关键代码片段或关键逻辑说明
5. 遇到的错误、失败尝试和报错现象，以及最终如何修复。
6. 用户的偏好、约束和明确指令，尤其是用户要求你改变做法的地方。
7. 当前仍未完成、需要继续处理或需要验证的事项。
8. 压缩前最近正在做的工作，以及停在了什么位置。

正式摘要必须使用下面 9 个章节，保持编号和标题：

1. 主要请求和意图：
   详细记录用户所有明确请求、目标、约束和意图变化。

2. 关键技术概念：
   列出本轮对话涉及的重要技术概念、框架、模块、架构模式和决策。

3. 文件和代码位置：
   枚举读过、修改过、创建过或重点讨论过的文件和代码区域。每个文件都要说明：
   - 为什么重要
   - 做过什么修改或观察到什么行为
   - 必要时保留关键代码片段、函数签名、配置项或命令

4. 错误、失败尝试和修复：
   记录所有重要错误、异常输出、用户指出的问题、失败方案，以及对应修复方式。

5. 问题解决过程：
   总结已经解决的问题、正在排查的问题、采用过的调试路径和验证结论。

6. 所有用户消息：
   按时间顺序列出所有非工具结果的用户消息。这里非常重要，用来保留用户反馈和意图变化；必要时可保留用户原话。

7. 待办任务：
   列出用户明确要求但尚未完成的任务，或后续必须验证的事项。没有则写“无明确待办”。

8. 当前工作：
   精确描述压缩发生前最近正在做什么，涉及哪些文件、函数、命令、修改和验证状态。

9. 可选下一步：
   只写和用户最近明确请求直接相关的下一步。如果当前任务已经完成，且用户没有要求继续，不要编造下一步。若有下一步，请引用最近对话中的关键原话或文件位置，避免任务漂移。

输出格式必须严格如下：

<analysis>
这里写你的分析过程，确保覆盖所有要点。
</analysis>

<summary>
1. 主要请求和意图：
...

2. 关键技术概念：
...

3. 文件和代码位置：
...

4. 错误、失败尝试和修复：
...

5. 问题解决过程：
...

6. 所有用户消息：
...

7. 待办任务：
...

8. 当前工作：
...

9. 可选下一步：
...
</summary>

请基于上方完整对话生成摘要，务必准确、详细、可继续执行。不要在 <summary> 之外输出额外说明。${instructions}`;
}

export function parseCompactSummary(raw: string): string {
    const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
    const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/);
    const summary = summaryMatch?.[1]?.trim() || withoutAnalysis;
    return summary.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildCompactSummaryMessage(summary: string): Message {
    return {
        role: "user",
        content: `<system-reminder>
本会话因为接近上下文上限已经被压缩。

下面是较早对话的摘要：

${summary}

请从对话中断处继续。除非和当前任务直接相关，不要向用户提及这次压缩，也不要重新复述摘要。
</system-reminder>`,
    };
}
